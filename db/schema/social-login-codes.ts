import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * A short-lived, single-use handoff between the OAuth callback (a full-page
 * browser redirect, which can't be a same-origin fetch the BFF intercepts)
 * and the real token pair. Unlike otp_codes (a low-entropy 6-digit code
 * looked up by phone, then argon2-verified), this code is itself
 * high-entropy — same shape as a refresh token, so it reuses
 * generateRefreshToken()/hashRefreshToken() (fast SHA-256, looked up
 * directly by hash) rather than argon2: there's no separate identifier to
 * narrow the lookup by, the code IS the lookup key, and its 256 bits of
 * entropy is what resists guessing, not hash cost. The raw code briefly
 * appears in a redirect URL (browser history/referrer), which is exactly
 * why it's short-lived (see AuthService.SOCIAL_CODE_TTL_SECONDS) and
 * single-use (consumedAt) — see docs/ARCHITECTURE.md §6.
 */
export const socialLoginCodes = pgTable(
  'social_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('social_login_codes_user_id_idx').on(table.userId)],
);

export type SocialLoginCode = typeof socialLoginCodes.$inferSelect;
export type NewSocialLoginCode = typeof socialLoginCodes.$inferInsert;
