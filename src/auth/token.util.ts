import { createHash, randomBytes, randomInt } from 'node:crypto';
import * as argon2 from 'argon2';

/** node:crypto's randomInt is CSPRNG-based — Math.random() is not, and an
 * OTP code is exactly the kind of secret that must not be predictable. */
export function generateOtpCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

/** Slow, memory-hard hash — appropriate for a low-entropy (1e6 possibility)
 * secret. See docs/CODE_GUIDELINES.md §6 and db/schema/otp-codes.ts. */
export function hashOtpCode(code: string): Promise<string> {
  return argon2.hash(code);
}

export function verifyOtpCode(hash: string, code: string): Promise<boolean> {
  return argon2.verify(hash, code);
}

/** Same argon2 hash already used for OTP codes — no new hashing library. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** 256 bits of entropy — the token itself, not the hash, is what resists
 * brute force, so the hash below can be fast. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Fast hash is intentional here — see db/schema/refresh-tokens.ts. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
