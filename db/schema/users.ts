import { integer, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * none    — signed up, phone-verified only (implicit on row creation)
 * phone   — can list; this is the default and keeps sign-up zero-friction
 * id      — document + selfie reviewed; required to sell via escrow (Phase 3+)
 * business — KYB reviewed; unlocks bulk tools (Phase 4+)
 * See docs/ARCHITECTURE.md §5.
 */
export const verificationLevelEnum = pgEnum('verification_level', [
  'none',
  'phone',
  'id',
  'business',
]);

// user  — everyone; default
// admin — can resolve disputes (see AdminGuard). No signup path sets this;
//         the first admin is a one-off manual DB update.
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Always E.164 — enforced by normalizePhoneToE164 at the API boundary,
  // never by a DB constraint. See src/common/phone/phone.util.ts. Stays
  // NOT NULL/unique even after adding password+social auth — phone remains
  // the product's primary identity (docs/ARCHITECTURE.md §1); a brand-new
  // social signup collects and verifies one before a user row is created
  // rather than relaxing this constraint. See AuthService.findOrCreateFromSocial.
  phone: text('phone').notNull().unique(),
  name: text('name'),
  email: text('email'),
  // Nullable: a social-only account may never set one. Argon2 hash, same as
  // otp_codes.codeHash — see token.util.ts#hashPassword.
  passwordHash: text('password_hash'),
  googleId: text('google_id').unique(),
  facebookId: text('facebook_id').unique(),
  verificationLevel: verificationLevelEnum('verification_level').notNull().default('none'),
  role: userRoleEnum('role').notNull().default('user'),
  // A seller's own bank account, collected the first time they need to
  // receive an escrow release (see PATCH /users/me/payout-account).
  // Destination for the Chapa Transfer call on release — never a Chapa
  // subaccount (docs/ARCHITECTURE.md §5). All three or none.
  payoutBankCode: text('payout_bank_code'),
  payoutAccountNumber: text('payout_account_number'),
  payoutAccountName: text('payout_account_name'),
  // Rolled up from Review (see db/schema/reviews.ts) — recomputed by
  // ReviewsService on every new review rather than incrementally
  // maintained, since review volume per user is low. Null (not 0) until
  // the first review, so the frontend can tell "no ratings yet" apart
  // from "rated 0" — same nullable-until-real-data shape as
  // Listing.flaggedReason.
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2, mode: 'number' }),
  ratingCount: integer('rating_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
