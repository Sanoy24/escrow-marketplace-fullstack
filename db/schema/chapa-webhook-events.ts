import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Idempotency table for Chapa webhook deliveries (docs/CODE_GUIDELINES.md
 * §3). The unique constraint on chapaReference IS the dedupe mechanism —
 * an insert that violates it means this exact event was already
 * processed, so the handler treats the conflict as a no-op success rather
 * than an `if (exists)` check racing a concurrent delivery of the same
 * event.
 */
export const chapaWebhookEvents = pgTable('chapa_webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  chapaReference: text('chapa_reference').notNull().unique(),
  eventType: text('event_type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ChapaWebhookEvent = typeof chapaWebhookEvents.$inferSelect;
export type NewChapaWebhookEvent = typeof chapaWebhookEvents.$inferInsert;
