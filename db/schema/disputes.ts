import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { escrowTransactions } from './escrow-transactions';
import { users } from './users';

export const disputeStatusEnum = pgEnum('dispute_status', [
  'open',
  'resolved_seller',
  'resolved_buyer',
]);

/**
 * Order-level, not per-item (docs/ARCHITECTURE.md §5) — at most one
 * dispute per EscrowTransaction, since a transaction can't return to
 * `held` after `disputed` except via the one admin resolve action.
 */
export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  escrowTransactionId: uuid('escrow_transaction_id')
    .notNull()
    .unique()
    .references(() => escrowTransactions.id),
  raisedBy: uuid('raised_by')
    .notNull()
    .references(() => users.id),
  reason: text('reason').notNull(),
  status: disputeStatusEnum('status').notNull().default('open'),
  resolvedByAdminId: uuid('resolved_by_admin_id').references(() => users.id),
  resolutionNote: text('resolution_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
