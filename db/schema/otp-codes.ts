import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * OTP no longer authenticates a login — it verifies a new phone at signup
 * and gates password recovery (see docs/ARCHITECTURE.md §6). No `.default()`:
 * every insert states its purpose explicitly, same fail-closed convention as
 * `listings.status`. Every read/consume query filters on purpose too, so a
 * leftover password-reset code can't be replayed as a signup-verify code.
 */
export const otpPurposeEnum = pgEnum('otp_purpose', ['signup', 'password_reset']);

/**
 * codeHash is an argon2 hash of the 6-digit code — deliberately a slow,
 * memory-hard hash (unlike refresh_tokens.tokenHash) because the code itself
 * is low-entropy (1e6 possibilities); the hash's cost is the only thing
 * standing between a leaked table and offline brute force. See
 * docs/CODE_GUIDELINES.md §6.
 */
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    purpose: otpPurposeEnum('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('otp_codes_phone_purpose_idx').on(table.phone, table.purpose)],
);

export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;
