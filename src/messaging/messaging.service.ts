import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  conversations,
  listingImages,
  listings,
  messages,
  users,
  type Conversation,
  type Message,
} from '../../db/schema';
import { DrizzleService } from '../db/drizzle.service';
import { QueryMessagesDto } from './dto/query-messages.dto';

export interface ConversationSummary {
  id: string;
  createdAt: Date;
  listing: { id: string; title: string; primaryImageUrl: string | null };
  otherParticipant: { id: string; name: string | null; phone: string };
  lastMessage: { body: string; sentAt: Date } | null;
}

export interface PaginatedMessages {
  items: Message[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 30;

@Injectable()
export class MessagingService {
  constructor(private readonly drizzle: DrizzleService) {}

  /**
   * Find-or-create, keyed by the (listing, buyer) unique constraint — see
   * db/schema/conversations.ts. Never message your own listing.
   */
  async findOrCreateConversation(buyerId: string, listingId: string): Promise<Conversation> {
    const [listing] = await this.drizzle.db
      .select({ id: listings.id, sellerId: listings.sellerId })
      .from(listings)
      .where(and(eq(listings.id, listingId), eq(listings.status, 'active')))
      .limit(1);
    if (!listing) {
      throw new NotFoundException('Listing not found.');
    }
    if (listing.sellerId === buyerId) {
      throw new BadRequestException('You cannot message yourself about your own listing.');
    }

    const [existing] = await this.drizzle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.listingId, listingId), eq(conversations.buyerId, buyerId)))
      .limit(1);
    if (existing) {
      return existing;
    }

    const [created] = await this.drizzle.db
      .insert(conversations)
      .values({ listingId, buyerId, sellerId: listing.sellerId })
      .onConflictDoNothing({ target: [conversations.listingId, conversations.buyerId] })
      .returning();
    if (created) {
      return created;
    }

    // Lost a create race against a concurrent request for the same
    // (listing, buyer) pair — the unique constraint made ours a no-op, so
    // the row that won the race is already there.
    const [raced] = await this.drizzle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.listingId, listingId), eq(conversations.buyerId, buyerId)))
      .limit(1);
    if (!raced) {
      // Unreachable: the insert only no-ops when a conflicting row exists.
      throw new Error('Failed to find or create conversation.');
    }
    return raced;
  }

  /**
   * A conversation the given user is a participant of, or undefined — the
   * single ownership check both the REST controller and the WS gateway
   * call before trusting anything about a conversation id a client
   * supplied. Never fetch-then-compare (docs/CODE_GUIDELINES.md §5).
   */
  async findParticipantConversation(
    conversationId: string,
    userId: string,
  ): Promise<Conversation | undefined> {
    const [row] = await this.drizzle.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId)),
        ),
      )
      .limit(1);
    return row;
  }

  async listConversationsForUser(userId: string): Promise<ConversationSummary[]> {
    const rows = await this.drizzle.db
      .select()
      .from(conversations)
      .where(or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId)));

    if (rows.length === 0) return [];

    const conversationIds = rows.map((r) => r.id);
    const listingIds = [...new Set(rows.map((r) => r.listingId))];
    const otherUserIds = [
      ...new Set(rows.map((r) => (r.buyerId === userId ? r.sellerId : r.buyerId))),
    ];

    const [listingRows, imageRows, userRows, lastMessages] = await Promise.all([
      this.drizzle.db
        .select({ id: listings.id, title: listings.title })
        .from(listings)
        .where(inArray(listings.id, listingIds)),
      this.drizzle.db
        .select({ listingId: listingImages.listingId, url: listingImages.url })
        .from(listingImages)
        .where(and(inArray(listingImages.listingId, listingIds), eq(listingImages.sortOrder, 0))),
      this.drizzle.db
        .select({ id: users.id, name: users.name, phone: users.phone })
        .from(users)
        .where(inArray(users.id, otherUserIds)),
      this.drizzle.db
        .selectDistinctOn([messages.conversationId], {
          conversationId: messages.conversationId,
          body: messages.body,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .where(inArray(messages.conversationId, conversationIds))
        .orderBy(messages.conversationId, desc(messages.sentAt)),
    ]);

    const listingById = new Map(listingRows.map((l) => [l.id, l]));
    const imageByListingId = new Map(imageRows.map((i) => [i.listingId, i.url]));
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const lastMessageByConversationId = new Map(lastMessages.map((m) => [m.conversationId, m]));

    const summaries: ConversationSummary[] = rows.map((row) => {
      const listing = listingById.get(row.listingId);
      const otherId = row.buyerId === userId ? row.sellerId : row.buyerId;
      const other = userById.get(otherId);
      const lastMessage = lastMessageByConversationId.get(row.id) ?? null;
      return {
        id: row.id,
        createdAt: row.createdAt,
        listing: {
          id: row.listingId,
          title: listing?.title ?? '',
          primaryImageUrl: imageByListingId.get(row.listingId) ?? null,
        },
        otherParticipant: { id: otherId, name: other?.name ?? null, phone: other?.phone ?? '' },
        lastMessage: lastMessage ? { body: lastMessage.body, sentAt: lastMessage.sentAt } : null,
      };
    });

    // Most recently active conversation first; one with no messages yet
    // sorts by when it was started.
    summaries.sort((a, b) => {
      const aTime = (a.lastMessage?.sentAt ?? a.createdAt).getTime();
      const bTime = (b.lastMessage?.sentAt ?? b.createdAt).getTime();
      return bTime - aTime;
    });

    return summaries;
  }

  /**
   * `page=1` is the most recent `pageSize` messages (typical chat-history
   * load), not the oldest — fetched DESC by sentAt then reversed so the
   * returned array itself still reads oldest-to-newest, top-to-bottom.
   * Higher page numbers page backward into older history.
   */
  async getMessages(
    conversationId: string,
    userId: string,
    query: QueryMessagesDto,
  ): Promise<PaginatedMessages> {
    const conversation = await this.findParticipantConversation(conversationId, userId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const [rawItems, [countRow]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.sentAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.drizzle.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
    ]);

    // Opening the thread marks the other side's messages read — no
    // separate "mark read" endpoint needed for this phase's scope.
    await this.drizzle.db
      .update(messages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          ne(messages.senderId, userId),
          isNull(messages.readAt),
        ),
      );

    return { items: rawItems.reverse(), page, pageSize, total: countRow?.count ?? 0 };
  }

  /**
   * Persists a message. Callers (the WS gateway) must verify participant
   * membership themselves first via findParticipantConversation — this
   * method trusts conversationId/senderId are already authorized.
   */
  async createMessage(conversationId: string, senderId: string, body: string): Promise<Message> {
    const [created] = await this.drizzle.db
      .insert(messages)
      .values({ conversationId, senderId, body })
      .returning();
    if (!created) {
      // Unreachable: insert().returning() either returns the row or the
      // statement itself throws.
      throw new Error('Failed to create message.');
    }
    return created;
  }
}
