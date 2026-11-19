import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { otpCodes, refreshTokens, socialLoginCodes, users, type User } from '../../db/schema';
import { maskPhone, normalizePhoneToE164 } from '../common/phone/phone.util';
import type { AppConfig } from '../config/configuration';
import { type Insertable, type Tx } from '../db/drizzle.service';
import { DrizzleService } from '../db/drizzle.service';
import { OTP_DELIVERY_QUEUE, type OtpDeliveryJobData } from '../queue/queue.constants';
import {
  generateOtpCode,
  generateRefreshToken,
  hashOtpCode,
  hashPassword,
  hashRefreshToken,
  verifyOtpCode,
  verifyPassword,
} from './token.util';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
}

/**
 * A social login with no matching account yet — carries the OAuth identity
 * forward while the user supplies+verifies a phone (users.phone stays
 * NOT NULL/unique; see db/schema/users.ts). Signed with the same access
 * secret as AccessTokenPayload; JwtStrategy's `type !== 'access'` check is
 * exactly what stops this from ever being accepted as a real session token.
 */
export interface SocialPendingPayload {
  type: 'social-pending';
  provider: 'google' | 'facebook';
  providerId: string;
  email?: string;
  name?: string;
}

export type OtpPurpose = 'signup' | 'password_reset';

export interface SocialProfile {
  provider: 'google' | 'facebook';
  providerId: string;
  email?: string;
  name?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  verificationLevel: User['verificationLevel'];
  // The seller's own bank details on file for an escrow release payout
  // (docs/ARCHITECTURE.md §5) — all three or none. Exposed here so a
  // settings page can show what's currently set, not just blindly
  // overwrite it via PATCH /users/me/payout-account.
  payoutBankCode: string | null;
  payoutAccountNumber: string | null;
  payoutAccountName: string | null;
  createdAt: Date;
}

// Independent of the per-IP @Throttle on the controller: SMS cost and abuse
// are tied to the destination phone, not the caller's IP, so a single phone
// can't be re-texted faster than this regardless of how many IPs ask.
const OTP_REQUEST_COOLDOWN_SECONDS = 60;
const REFRESH_REUSE_GRACE_SECONDS = 5;
// Long enough to fill in a phone number after an OAuth redirect, short
// enough that an abandoned social signup can't be resumed indefinitely.
const SOCIAL_PENDING_TTL_SECONDS = 900;
// Deliberately short — this code's only job is surviving one browser
// redirect from the OAuth callback to the frontend's own callback route.
const SOCIAL_CODE_TTL_SECONDS = 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
    @InjectQueue(OTP_DELIVERY_QUEUE) private readonly otpQueue: Queue<OtpDeliveryJobData>,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Creates the account (verificationLevel: 'none') and sends a
   * signup-purpose OTP to confirm the phone. Re-callable for an
   * unverified phone (treated as "resend" — password/name/email are
   * updated to whatever was just submitted) since there's otherwise no way
   * to recover from a dropped SMS or an abandoned first attempt; a phone
   * that's already verified rejects with 409.
   */
  async signup(rawPhone: string, password: string, name?: string, email?: string): Promise<void> {
    const phone = normalizePhoneToE164(rawPhone);
    const passwordHash = await hashPassword(password);

    await this.drizzle.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.phone, phone)).limit(1);
      if (existing) {
        if (existing.verificationLevel !== 'none') {
          throw new ConflictException('An account with this phone number already exists.');
        }
        await tx
          .update(users)
          .set({
            passwordHash,
            ...(name !== undefined && { name }),
            ...(email !== undefined && { email }),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id));
        return;
      }

      await tx
        .insert(users)
        .values({ phone, passwordHash, name, email, verificationLevel: 'none' })
        .onConflictDoNothing({ target: users.phone });
    });

    await this.requestOtp(phone, 'signup');
  }

  async verifySignup(rawPhone: string, code: string): Promise<{ user: PublicUser } & TokenPair> {
    const phone = normalizePhoneToE164(rawPhone);

    const result = await this.drizzle.db.transaction(async (tx) => {
      const ok = await this.verifyAndConsumeOtp(tx, phone, code, 'signup');
      if (!ok) return { ok: false as const };

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .for('update')
        .limit(1);
      if (!user) {
        // Unreachable: signup()/completeSocialSignup() always create the row
        // before a 'signup'-purpose OTP is ever sent.
        return { ok: false as const };
      }

      const verified =
        user.verificationLevel === 'none'
          ? ((
              await tx
                .update(users)
                .set({ verificationLevel: 'phone', updatedAt: new Date() })
                .where(eq(users.id, user.id))
                .returning()
            )[0] ?? user)
          : user;

      const tokens = await this.issueTokenPair(verified.id, randomUUID(), tx);
      return { ok: true as const, user: verified, tokens };
    });

    if (!result.ok) {
      throw new UnauthorizedException('Invalid or expired code.');
    }
    this.logger.info({ userId: result.user.id }, 'Signup verified, tokens issued');
    return { user: this.toPublicUser(result.user), ...result.tokens };
  }

  async login(rawPhone: string, password: string): Promise<{ user: PublicUser } & TokenPair> {
    const phone = normalizePhoneToE164(rawPhone);
    const [user] = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);

    if (user && !user.passwordHash) {
      const provider = user.googleId ? 'Google' : user.facebookId ? 'Facebook' : 'social login';
      throw new BadRequestException(`This account uses ${provider} — continue with that instead.`);
    }
    if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new UnauthorizedException('Invalid phone number or password.');
    }

    const tokens = await this.issueTokenPair(user.id, randomUUID());
    this.logger.info({ userId: user.id }, 'Logged in');
    return { user: this.toPublicUser(user), ...tokens };
  }

  /** Always resolves the same way regardless of whether the phone is
   * registered — no account-existence signal, per OWASP's Forgot Password
   * guidance. */
  async forgotPassword(rawPhone: string): Promise<void> {
    const phone = normalizePhoneToE164(rawPhone);
    const [user] = await this.drizzle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);
    if (user) {
      await this.requestOtp(phone, 'password_reset');
    }
  }

  async resetPassword(rawPhone: string, code: string, newPassword: string): Promise<TokenPair> {
    const phone = normalizePhoneToE164(rawPhone);
    const newPasswordHash = await hashPassword(newPassword);

    const result = await this.drizzle.db.transaction(async (tx) => {
      const ok = await this.verifyAndConsumeOtp(tx, phone, code, 'password_reset');
      if (!ok) return { ok: false as const };

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .for('update')
        .limit(1);
      if (!user) return { ok: false as const };

      await tx
        .update(users)
        .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      // A password reset is a security-sensitive event — force re-login on
      // every device, not just this one. Same bulk-revoke shape as logout(),
      // scoped to every family for this user instead of one.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

      const tokens = await this.issueTokenPair(user.id, randomUUID(), tx);
      return { ok: true as const, tokens };
    });

    if (!result.ok) {
      throw new UnauthorizedException('Invalid or expired code.');
    }
    this.logger.info({ phone: maskPhone(phone) }, 'Password reset, all prior sessions revoked');
    return result.tokens;
  }

  /**
   * The OAuth callback's outcome: either an existing/linkable account (issue
   * a short-lived exchange code, see exchangeSocialCode) or a brand-new
   * identity that still needs a phone (issue a pending token, see
   * completeSocialSignup).
   */
  async handleSocialLogin(
    profile: SocialProfile,
  ): Promise<
    { kind: 'authenticated'; code: string } | { kind: 'needs-phone'; pendingToken: string }
  > {
    const providerColumn = profile.provider === 'google' ? users.googleId : users.facebookId;
    const [byProviderId] = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(providerColumn, profile.providerId))
      .limit(1);
    if (byProviderId) {
      return { kind: 'authenticated', code: await this.issueSocialLoginCode(byProviderId.id) };
    }

    if (profile.email) {
      const [byEmail] = await this.drizzle.db
        .select()
        .from(users)
        .where(eq(users.email, profile.email))
        .limit(1);
      if (byEmail) {
        const linkFields =
          profile.provider === 'google'
            ? { googleId: profile.providerId }
            : { facebookId: profile.providerId };
        await this.drizzle.db
          .update(users)
          .set({ ...linkFields, updatedAt: new Date() })
          .where(eq(users.id, byEmail.id));
        return { kind: 'authenticated', code: await this.issueSocialLoginCode(byEmail.id) };
      }
    }

    const payload: SocialPendingPayload = {
      type: 'social-pending',
      provider: profile.provider,
      providerId: profile.providerId,
      email: profile.email,
      name: profile.name,
    };
    const pendingToken = this.jwtService.sign(payload, { expiresIn: SOCIAL_PENDING_TTL_SECONDS });
    return { kind: 'needs-phone', pendingToken };
  }

  /** Exchanges a one-time code (see handleSocialLogin) for a real session —
   * see db/schema/social-login-codes.ts for why this isn't argon2. */
  async exchangeSocialCode(code: string): Promise<{ user: PublicUser } & TokenPair> {
    const codeHash = hashRefreshToken(code);

    const result = await this.drizzle.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(socialLoginCodes)
        .where(eq(socialLoginCodes.codeHash, codeHash))
        .for('update')
        .limit(1);
      if (!candidate || candidate.consumedAt || candidate.expiresAt.getTime() < Date.now()) {
        return { ok: false as const };
      }
      await tx
        .update(socialLoginCodes)
        .set({ consumedAt: new Date() })
        .where(eq(socialLoginCodes.id, candidate.id));

      const [user] = await tx.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
      if (!user) return { ok: false as const };

      const tokens = await this.issueTokenPair(user.id, randomUUID(), tx);
      return { ok: true as const, user, tokens };
    });

    if (!result.ok) {
      throw new UnauthorizedException('Invalid or expired code.');
    }
    return { user: this.toPublicUser(result.user), ...result.tokens };
  }

  /**
   * Completes a "needs-phone" social login: creates the user row (linked to
   * the social identity) and sends a signup-purpose OTP — the caller then
   * hits the same POST /auth/signup/verify as an ordinary signup to
   * confirm the phone and get tokens. No separate verify path needed.
   */
  async completeSocialSignup(pendingToken: string, rawPhone: string): Promise<void> {
    let payload: SocialPendingPayload;
    try {
      payload = await this.jwtService.verifyAsync<SocialPendingPayload>(pendingToken);
    } catch {
      throw new UnauthorizedException('This sign-up link has expired. Please try again.');
    }
    if (payload.type !== 'social-pending') {
      throw new UnauthorizedException('Invalid token.');
    }

    const phone = normalizePhoneToE164(rawPhone);
    const socialFields =
      payload.provider === 'google'
        ? { googleId: payload.providerId }
        : { facebookId: payload.providerId };

    await this.drizzle.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);
      if (existing) {
        throw new ConflictException('An account with this phone number already exists.');
      }
      await tx
        .insert(users)
        .values({
          phone,
          email: payload.email,
          name: payload.name,
          verificationLevel: 'none',
          ...socialFields,
        })
        .onConflictDoNothing({ target: users.phone });
    });

    await this.requestOtp(phone, 'signup');
  }

  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(rawRefreshToken);

    // IMPORTANT: Drizzle rolls back the *entire* transaction when the
    // callback throws. The reuse-detected branch below must therefore
    // return normally (letting the revocation UPDATE commit) rather than
    // throwing inside the transaction — throwing there would roll back the
    // very revocation it just wrote, silently leaving the stolen family
    // usable. The 401 is thrown only after the transaction has committed.
    const result = await this.drizzle.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .for('update');

      if (!existing) {
        throw new UnauthorizedException('Invalid refresh token.');
      }
      if (existing.revokedAt) {
        throw new UnauthorizedException('Refresh token has been revoked.');
      }
      if (existing.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException('Refresh token has expired.');
      }
      if (existing.consumedAt) {
        const secondsSinceConsumption = (Date.now() - existing.consumedAt.getTime()) / 1000;
        if (secondsSinceConsumption <= REFRESH_REUSE_GRACE_SECONDS) {
          // Two legitimate requests can cross while the same cookie is still
          // in flight. Reject the loser, but do not kill the replacement token
          // that the winning request just issued.
          return { kind: 'concurrent-rotation' as const };
        }
        // Reuse of an already-rotated token: treat as theft/replay and kill
        // the whole family, not just this token. See docs/CODE_GUIDELINES.md §2 —
        // this is the gap the reference project's plain JTI-denylist left open.
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)),
          );
        return { kind: 'reuse-detected' as const, familyId: existing.familyId };
      }

      await tx
        .update(refreshTokens)
        .set({ consumedAt: new Date() })
        .where(eq(refreshTokens.id, existing.id));

      const pair = await this.issueTokenPair(existing.userId, existing.familyId, tx);
      return { kind: 'rotated' as const, pair };
    });

    if (result.kind === 'concurrent-rotation') {
      // Distinct from invalid/replayed credentials so the BFF does not clear
      // cookies that a parallel winning response is about to replace.
      throw new ConflictException('Refresh token rotation is already in progress.');
    }
    if (result.kind === 'reuse-detected') {
      this.logger.warn(
        { familyId: result.familyId },
        'Refresh token reuse detected; family revoked',
      );
      throw new UnauthorizedException('Refresh token reuse detected; all sessions revoked.');
    }

    return result.pair;
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const db = this.drizzle.db;

    const [existing] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!existing) return; // idempotent: don't leak whether the token existed

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)));
  }

  async getPublicUser(userId: string): Promise<PublicUser> {
    const [user] = await this.drizzle.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }
    return this.toPublicUser(user);
  }

  /**
   * purpose-scoped: a signup and a password-reset request for the same
   * phone don't share the 60s cooldown or the "latest code" lookup —
   * they're unrelated flows that happen to target the same phone.
   */
  private async requestOtp(phone: string, purpose: OtpPurpose): Promise<void> {
    const db = this.drizzle.db;
    const code = generateOtpCode();
    const codeHash = await hashOtpCode(code);
    const { ttlMinutes } = this.configService.get('otp', { infer: true });
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const inserted = await db.transaction(async (tx) => {
      // There may be no row to lock for a first request, so serialize by a
      // stable Postgres advisory key derived from the normalized phone +
      // purpose (two different purposes for the same phone must not
      // serialize against each other).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${phone} || ':' || ${purpose}, 0))`,
      );

      const [latest] = await tx
        .select()
        .from(otpCodes)
        .where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose)))
        .orderBy(desc(otpCodes.createdAt))
        .limit(1);

      if (latest) {
        const secondsSinceLast = (Date.now() - latest.createdAt.getTime()) / 1000;
        if (secondsSinceLast < OTP_REQUEST_COOLDOWN_SECONDS) {
          return false;
        }
      }

      await tx.insert(otpCodes).values({ phone, purpose, codeHash, expiresAt });
      return true;
    });
    if (!inserted) {
      throw new UnauthorizedException('Please wait before requesting another code.');
    }

    await this.otpQueue.add('deliver', {
      phone,
      body: `Your verification code is ${code}. It expires in ${ttlMinutes} minutes.`,
    });

    this.logger.info({ phone: maskPhone(phone), purpose }, 'OTP requested');
  }

  private async verifyAndConsumeOtp(
    tx: Tx,
    phone: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<boolean> {
    const { maxAttempts } = this.configService.get('otp', { infer: true });

    const [candidate] = await tx
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.phone, phone),
          eq(otpCodes.purpose, purpose),
          isNull(otpCodes.consumedAt),
          gt(otpCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(otpCodes.createdAt))
      .for('update')
      .limit(1);

    if (!candidate || candidate.attemptCount >= maxAttempts) {
      return false;
    }

    const isValid = await verifyOtpCode(candidate.codeHash, code);
    if (!isValid) {
      await tx
        .update(otpCodes)
        .set({ attemptCount: candidate.attemptCount + 1 })
        .where(eq(otpCodes.id, candidate.id));
      return false;
    }

    await tx.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, candidate.id));
    return true;
  }

  private async issueSocialLoginCode(userId: string): Promise<string> {
    // Reuses the refresh-token primitives: same shape (high-entropy random
    // value, fast deterministic hash looked up directly), not the OTP ones —
    // see db/schema/social-login-codes.ts.
    const code = generateRefreshToken();
    const codeHash = hashRefreshToken(code);
    const expiresAt = new Date(Date.now() + SOCIAL_CODE_TTL_SECONDS * 1000);
    await this.drizzle.db.insert(socialLoginCodes).values({ userId, codeHash, expiresAt });
    return code;
  }

  /**
   * Accepts an optional transaction handle so `refresh()` can call this
   * inside the same transaction that locked and consumed the old token —
   * issuing the new pair outside that transaction would let a concurrent
   * refresh interleave between "consume old" and "issue new".
   */
  private async issueTokenPair(
    userId: string,
    familyId: string,
    dbHandle: Insertable = this.drizzle.db,
  ): Promise<TokenPair> {
    const payload: AccessTokenPayload = { sub: userId, type: 'access' };
    const accessToken = this.jwtService.sign(payload);

    const rawRefreshToken = generateRefreshToken();
    const { refreshTtlDays } = this.configService.get('jwt', { infer: true });
    const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

    await dbHandle.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: hashRefreshToken(rawRefreshToken),
      expiresAt,
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      verificationLevel: user.verificationLevel,
      payoutBankCode: user.payoutBankCode,
      payoutAccountNumber: user.payoutAccountNumber,
      payoutAccountName: user.payoutAccountName,
      createdAt: user.createdAt,
    };
  }
}
