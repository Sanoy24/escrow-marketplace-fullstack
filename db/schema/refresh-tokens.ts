import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * tokenHash is a plain SHA-256 of the raw (high-entropy, 256-bit random)
 * token — a fast hash is fine here because entropy, not hash cost, is the
 * protection. Contrast with otp_codes.codeHash. See docs/CODE_GUIDELINES.md §6.
 *
 * familyId ties every token descended from one login together. Presenting
 * an already-consumed token is theft/replay evidence: the whole family gets
 * revoked, not just that one token, closing the gap the reference project's
 * plain JTI-denylist rotation left open (a thief who rotates first would
 * otherwise keep a live chain). See docs/CODE_GUIDELINES.md and the phase-0 plan.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_family_id_idx').on(table.familyId),
  ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
