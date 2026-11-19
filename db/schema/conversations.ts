import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { listings } from './listings';
import { users } from './users';

/**
 * One conversation per (listing, buyer) pair — the unique constraint below
 * is what makes POST /conversations a find-or-create rather than always
 * inserting a new row. sellerId is redundant with listings.sellerId at
 * insert time but kept as its own column: a listing can be edited/removed
 * later, and a conversation must keep pointing at who the seller actually
 * was, plus it lets `GET /conversations` index straight on it instead of
 * joining through listings just to find "conversations where I'm the
 * seller".
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('conversations_listing_buyer_unique').on(table.listingId, table.buyerId),
    index('conversations_buyer_id_idx').on(table.buyerId),
    index('conversations_seller_id_idx').on(table.sellerId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
