import {
  generateOtpCode,
  generateRefreshToken,
  hashOtpCode,
  hashPassword,
  hashRefreshToken,
  verifyOtpCode,
  verifyPassword,
} from './token.util';

describe('generateOtpCode', () => {
  it('always produces a 6-digit numeric string', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('OTP code hashing', () => {
  it('verifies a matching code and rejects a non-matching one', async () => {
    const code = generateOtpCode();
    const hash = await hashOtpCode(code);
    await expect(verifyOtpCode(hash, code)).resolves.toBe(true);
    await expect(verifyOtpCode(hash, '000000')).resolves.toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies a matching password and rejects a non-matching one', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });
});

describe('refresh token hashing', () => {
  it('produces a deterministic hash for the same raw token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });

  it('generates high-entropy, non-colliding tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(1000);
  });
});
