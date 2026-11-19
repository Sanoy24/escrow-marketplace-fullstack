import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orders } from './orders';
import { users } from './users';

/**
 * Legal transitions only, per docs/ARCHITECTURE.md §5 and
 * docs/CODE_GUIDELINES.md §2 — everything else is a bug:
 *   pending_payment -> held
 *   held            -> released | disputed
 *   disputed        -> released | refunded
 *   released        -> (terminal)
 *   refunded        -> (terminal)
 * Never write this column directly — always through
 * EscrowService's guarded transition helper.
 */
export const escrowStatusEnum = pgEnum('escrow_status', [
  'pending_payment',
  'held',
  'released',
  'disputed',
  'refunded',
]);

/**
 * The trust mechanism (docs/ARCHITECTURE.md §5). Funds are a plain Chapa
 * charge into the platform's own balance — never a subaccount split at
 * charge time (that settles immediately, which is wrong for a hold — see
 * the corrected design note in ARCHITECTURE.md §5). Release pays the
 * seller via an explicit Chapa Transfer call, recorded in
 * chapaTransferRef, only once release actually fires.
 */
export const escrowTransactions = pgTable(
  'escrow_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // One escrow per order.
    orderId: uuid('order_id')
      .notNull()
      .unique()
      .references(() => orders.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    amountSantim: bigint('amount_santim', { mode: 'bigint' }).notNull(),
    // Computed at release time (300 bps, floored toward the seller per
    // docs/CODE_GUIDELINES.md §1), not at initiation — the fee rate is
    // read at the moment it's actually charged, not snapshotted early for
    // no reason. platformFeeSantim + sellerSantim === amountSantim exactly.
    platformFeeSantim: bigint('platform_fee_santim', { mode: 'bigint' }),
    // The buyer's payment-in reference — the tx_ref this backend generates
    // and sends to Chapa's initialize call, used to look the transaction
    // back up from the webhook payload.
    chapaTxRef: text('chapa_tx_ref').notNull().unique(),
    // The seller-payout reference — set only once a Transfer call actually
    // succeeds on release.
    chapaTransferRef: text('chapa_transfer_ref'),
    // Set only when a dispute resolves to refunded.
    chapaRefundRef: text('chapa_refund_ref'),
    status: escrowStatusEnum('status').notNull().default('pending_payment'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    // held_at + ESCROW_AUTO_RELEASE_HOURS — a deadline that decides who
    // gets the money, hence timestamptz always (docs/CODE_GUIDELINES.md §7).
    autoReleaseAt: timestamp('auto_release_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('escrow_transactions_buyer_id_idx').on(table.buyerId),
    index('escrow_transactions_seller_id_idx').on(table.sellerId),
    index('escrow_transactions_status_idx').on(table.status),
  ],
);

export type EscrowTransaction = typeof escrowTransactions.$inferSelect;
export type NewEscrowTransaction = typeof escrowTransactions.$inferInsert;
