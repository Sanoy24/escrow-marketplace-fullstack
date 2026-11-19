import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashRefreshToken } from '../src/auth/token.util';
import { SMS_SERVICE } from '../src/sms/sms.interface';
import { FakeSmsService } from './setup/fake-sms.service';
import { startPostgres, type StartedPostgres } from './setup/testcontainers-postgres';
import { startRedis, type StartedRedis } from './setup/testcontainers-redis';

const PHONE = (suffix: number): string => `+2519${String(suffix).padStart(8, '0')}`;
const BFF_PROXY_SECRET = 'test-bff-proxy-secret-at-least-32-characters';
const PASSWORD = 'Test-password-123';

describe('Auth (e2e)', () => {
  let pg: StartedPostgres;
  let redis: StartedRedis;
  let rawPool: Pool;
  let app: INestApplication;
  let sms: FakeSmsService;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
    rawPool = new Pool({ connectionString: pg.connectionUri });

    process.env.DATABASE_URL = pg.connectionUri;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long';
    process.env.BFF_PROXY_SECRET = BFF_PROXY_SECRET;
    // Small cap so the attempt-cap test doesn't need 5 wrong guesses.
    process.env.OTP_MAX_ATTEMPTS = '3';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SERVICE)
      .useClass(FakeSmsService)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts's bootstrap — needed here so AuthController's
    // cookie-based refresh-token fallback (Phase 10) has req.cookies to
    // read from; e2e specs build the Nest app directly and never run
    // through bootstrap() themselves.
    app.use(cookieParser());
    await app.init();
    sms = moduleRef.get(SMS_SERVICE);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await rawPool.end();
    await pg.stop();
    await redis.stop();
  });

  // Every request in this suite goes through this, not just signup — several
  // routes here (/auth/signup, /auth/forgot-password) carry a tight 5/60s
  // per-IP throttle, and this suite calls them far more than 5 times total
  // across its ~17 tests. A distinct forwarded IP per test (mirroring how
  // the real BFF forwards the actual visitor's IP on every request, not
  // just some of them) keeps each test's calls independent instead of
  // sharing the test client's one raw connection IP.
  function authed(forwardedFor: string, req: request.Test): request.Test {
    return req.set('X-Forwarded-For', forwardedFor).set('X-BFF-Proxy-Secret', BFF_PROXY_SECRET);
  }

  async function signupAndVerify(
    phone: string,
    forwardedFor: string,
    password = PASSWORD,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const smsCountBefore = sms.sent.length;
    await authed(forwardedFor, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);
    const verifyRes = await authed(
      forwardedFor,
      request(app.getHttpServer()).post('/auth/signup/verify'),
    )
      .send({ phone, code })
      .expect(201);
    return verifyRes.body as { accessToken: string; refreshToken: string };
  }

  it('completes the signup -> verify -> protected route loop', async () => {
    const phone = PHONE(1);
    const ip = '10.0.4.1';

    const smsCountBefore = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(200);

    const code = await sms.waitForCodeAfter(smsCountBefore);

    const verifyRes = await authed(ip, request(app.getHttpServer()).post('/auth/signup/verify'))
      .send({ phone, code })
      .expect(201);

    expect(verifyRes.body.user.phone).toBe(phone);
    expect(verifyRes.body.user.verificationLevel).toBe('phone');
    expect(typeof verifyRes.body.accessToken).toBe('string');
    expect(typeof verifyRes.body.refreshToken).toBe('string');

    const { accessToken } = verifyRes.body as { accessToken: string };

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.phone).toBe(phone);
      });

    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('rejects signing up with a phone that is already a verified account', async () => {
    const phone = PHONE(2);
    const ip = '10.0.4.2';
    await signupAndVerify(phone, ip);

    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(409);
  });

  it('treats a repeat signup for an unverified phone as a resend, not a conflict', async () => {
    const phone = PHONE(20);
    const ip = '10.0.4.20';
    const firstSmsCount = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(200);
    await sms.waitForCodeAfter(firstSmsCount);

    // A second signup attempt before ever verifying — must not 409, and
    // must complete the verify loop with whatever password was just sent.
    const secondSmsCount = sms.sent.length;
    await rawPool.query(
      `update otp_codes set created_at = now() - interval '2 minutes' where phone = $1`,
      [phone],
    );
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: 'Different-password-1' })
      .expect(200);
    const code = await sms.waitForCodeAfter(secondSmsCount);

    const verifyRes = await authed(ip, request(app.getHttpServer()).post('/auth/signup/verify'))
      .send({ phone, code })
      .expect(201);
    expect(verifyRes.body.user.phone).toBe(phone);
  });

  it('blocks verification once the attempt cap is exhausted, even with the right code', async () => {
    const phone = PHONE(3);
    const ip = '10.0.4.3';

    const smsCountBefore = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);

    // OTP_MAX_ATTEMPTS=3 above: three wrong guesses exhausts the cap.
    for (let i = 0; i < 3; i++) {
      await authed(ip, request(app.getHttpServer()).post('/auth/signup/verify'))
        .send({ phone, code: '000000' })
        .expect(401);
    }

    await authed(ip, request(app.getHttpServer()).post('/auth/signup/verify'))
      .send({ phone, code })
      .expect(401);
  });

  it('rejects a code past its expiry', async () => {
    const phone = PHONE(4);
    const ip = '10.0.4.4';

    const smsCountBefore = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);

    // Force expiry directly — the code is only ever stored hashed, so
    // there's no way to observe it slipping past a real 5-minute wait
    // without controlling the clock.
    await rawPool.query(
      `update otp_codes set expires_at = now() - interval '1 minute' where phone = $1`,
      [phone],
    );

    await authed(ip, request(app.getHttpServer()).post('/auth/signup/verify'))
      .send({ phone, code })
      .expect(401);
  });

  it('logs in with the right phone and password', async () => {
    const phone = PHONE(5);
    const ip = '10.0.4.5';
    await signupAndVerify(phone, ip);

    const loginRes = await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: PASSWORD })
      .expect(200);
    expect(loginRes.body.user.phone).toBe(phone);
    expect(typeof loginRes.body.accessToken).toBe('string');
  });

  it('rejects login with the wrong password', async () => {
    const phone = PHONE(6);
    const ip = '10.0.4.6';
    await signupAndVerify(phone, ip);

    await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: 'wrong-password-entirely' })
      .expect(401);
  });

  it('rejects login for a phone that was never registered', async () => {
    await authed('10.0.4.7', request(app.getHttpServer()).post('/auth/login'))
      .send({ phone: PHONE(7), password: PASSWORD })
      .expect(401);
  });

  it('rejects login for a social-only account with a helpful message naming the provider', async () => {
    const phone = PHONE(8);
    const ip = '10.0.4.8';
    // No passwordHash — simulates an account created purely via social
    // login (AuthService.completeSocialSignup never sets one).
    await rawPool.query(
      `insert into users (phone, google_id, verification_level) values ($1, $2, 'phone')`,
      [phone, 'fake-google-id-8'],
    );

    const res = await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: PASSWORD })
      .expect(400);
    expect(res.body.message).toMatch(/google/i);
  });

  it('forgot-password responds identically whether or not the phone is registered', async () => {
    const registeredPhone = PHONE(9);
    const ip = '10.0.4.9';
    await signupAndVerify(registeredPhone, ip);
    const unregisteredPhone = PHONE(10);

    const registeredRes = await authed(
      ip,
      request(app.getHttpServer()).post('/auth/forgot-password'),
    )
      .send({ phone: registeredPhone })
      .expect(200);
    const unregisteredRes = await authed(
      ip,
      request(app.getHttpServer()).post('/auth/forgot-password'),
    )
      .send({ phone: unregisteredPhone })
      .expect(200);
    expect(registeredRes.body.message).toBe(unregisteredRes.body.message);

    // But only the registered phone actually got an SMS.
    expect(sms.sent.some((m) => m.to === registeredPhone)).toBe(true);
    expect(sms.sent.some((m) => m.to === unregisteredPhone)).toBe(false);
  });

  it('resets the password, revokes every prior session, and the new password works', async () => {
    const phone = PHONE(11);
    const ip = '10.0.4.11';
    const { refreshToken: oldRefreshToken } = await signupAndVerify(phone, ip);

    const smsCountBefore = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/forgot-password'))
      .send({ phone })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);

    const newPassword = 'Brand-new-password-1';
    const resetRes = await authed(ip, request(app.getHttpServer()).post('/auth/reset-password'))
      .send({ phone, code, newPassword })
      .expect(200);
    expect(typeof resetRes.body.accessToken).toBe('string');

    // The session that existed before the reset must be dead now.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken })
      .expect(401);

    // Old password no longer works; new one does.
    await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: PASSWORD })
      .expect(401);
    await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: newPassword })
      .expect(200);
  });

  it('rejects reset-password with an invalid or expired code', async () => {
    const phone = PHONE(12);
    const ip = '10.0.4.12';
    await signupAndVerify(phone, ip);
    await authed(ip, request(app.getHttpServer()).post('/auth/forgot-password'))
      .send({ phone })
      .expect(200);

    await authed(ip, request(app.getHttpServer()).post('/auth/reset-password'))
      .send({ phone, code: '000000', newPassword: 'Whatever-password-1' })
      .expect(401);
  });

  it('rotates the refresh token pair on /auth/refresh', async () => {
    const phone = PHONE(13);
    const { refreshToken } = await signupAndVerify(phone, '10.0.4.13');

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
    expect(typeof refreshRes.body.accessToken).toBe('string');
  });

  it('detects refresh-token reuse and revokes the whole family', async () => {
    const phone = PHONE(14);
    const { refreshToken: originalRefreshToken } = await signupAndVerify(phone, '10.0.4.14');

    const firstRotation = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);
    const rotatedRefreshToken = firstRotation.body.refreshToken as string;

    // Reuse outside the short concurrency grace window is theft/replay,
    // not two legitimate requests crossing in flight.
    await rawPool.query(
      `update refresh_tokens set consumed_at = now() - interval '1 minute' where token_hash = $1`,
      [hashRefreshToken(originalRefreshToken)],
    );

    // Replay the now-consumed original token.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(401);

    // The reuse must have revoked the *entire family* — the token that was
    // legitimately issued by the rotation above is dead too, not just the
    // replayed one. This is the behavior that closes the gap left by a
    // plain consumed-token check with no family revocation.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotatedRefreshToken })
      .expect(401);
  });

  it('does not revoke the replacement token when two refreshes race', async () => {
    const phone = PHONE(15);
    const { refreshToken: original } = await signupAndVerify(phone, '10.0.4.15');

    const attempts = await Promise.all([
      request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: original }),
      request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: original }),
    ]);
    const success = attempts.find((response) => response.status === 200);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(success).toBeDefined();

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: success?.body.refreshToken })
      .expect(200);
  });

  it('serializes concurrent signup requests for the same phone', async () => {
    const phone = PHONE(16);
    const attempts = await Promise.all([
      authed('10.0.4.16', request(app.getHttpServer()).post('/auth/signup')).send({
        phone,
        password: PASSWORD,
      }),
      authed('10.0.4.16', request(app.getHttpServer()).post('/auth/signup')).send({
        phone,
        password: PASSWORD,
      }),
    ]);

    expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it('allows a signup-verify code to be consumed only once under concurrent verification', async () => {
    const phone = PHONE(17);
    const ip = '10.0.4.17';
    const smsCountBefore = sms.sent.length;
    await authed(ip, request(app.getHttpServer()).post('/auth/signup'))
      .send({ phone, password: PASSWORD })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);

    const attempts = await Promise.all([
      authed(ip, request(app.getHttpServer()).post('/auth/signup/verify')).send({ phone, code }),
      authed(ip, request(app.getHttpServer()).post('/auth/signup/verify')).send({ phone, code }),
    ]);

    expect(attempts.map((response) => response.status).sort()).toEqual([201, 401]);
  });

  // Phase 10 (frontend migration — docs/ARCHITECTURE.md's BFF-removal
  // section): the backend now sets the refresh token as a cookie too, in
  // addition to the unchanged JSON body every test above already asserts
  // on — these tests cover only the new cookie behavior, additively.

  it('sets an httpOnly, SameSite=Lax refresh-token cookie on login', async () => {
    const phone = PHONE(21);
    const ip = '10.0.4.21';
    await signupAndVerify(phone, ip);

    const loginRes = await authed(ip, request(app.getHttpServer()).post('/auth/login'))
      .send({ phone, password: PASSWORD })
      .expect(200);

    const setCookie = loginRes.headers['set-cookie'] as unknown as string[];
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/SameSite=Lax/i);
    expect(refreshCookie).not.toMatch(/Secure/i); // NODE_ENV is 'test', not 'production'
  });

  it('accepts a refresh token from the cookie when the body omits it, and rotates it', async () => {
    const phone = PHONE(22);
    const { refreshToken } = await signupAndVerify(phone, '10.0.4.22');

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .send({})
      .expect(200);

    expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
    expect(typeof refreshRes.body.accessToken).toBe('string');
    // The response also rotates the cookie itself, not just the body.
    const setCookie = refreshRes.headers['set-cookie'] as unknown as string[];
    expect(
      setCookie.some((c) => c.startsWith(`refresh_token=${refreshRes.body.refreshToken}`)),
    ).toBe(true);
  });

  it('rejects /auth/refresh when neither the body nor a cookie carries a refresh token', async () => {
    await request(app.getHttpServer()).post('/auth/refresh').send({}).expect(400);
  });

  it('clears the refresh-token cookie on logout', async () => {
    const phone = PHONE(23);
    const { refreshToken } = await signupAndVerify(phone, '10.0.4.23');

    const logoutRes = await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken })
      .expect(204);

    const setCookie = logoutRes.headers['set-cookie'] as unknown as string[];
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));
    expect(refreshCookie).toBeDefined();
    // clearCookie() expires it immediately rather than sending a real value.
    expect(refreshCookie).toMatch(/refresh_token=;/);
  });
});
