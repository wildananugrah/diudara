import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conversationParticipants, conversations, messageAttachments, messages, uploads, users,
} from "../db/schema.ts";
import type { ConversationRepository, MessageRepository } from "../../domain/ports.ts";

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Subqueries use explicit aliases (m/cp) rather than Drizzle column
   * interpolation: interpolation renders unqualified names, and a bare "id"
   * inside a subquery over `messages` binds to messages.id instead of
   * conversations.id, silently breaking the correlation.
   *
   * lastMessageAt is selected as epoch millis, not a timestamp. A raw
   * `sql<Date>` is only a compile-time claim — postgres-js hands back a string
   * for an un-mapped expression, so calling .getTime() on it throws at runtime.
   */
  async listForUser(userId: string) {
    const mine = this.db.select({ id: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, userId));

    const rows = await this.db.select({
      id: conversations.id,
      peerName: users.name,
      peerInitials: users.initials,
      peerColor: users.avatarColor,
      lastMessage: sql<string>`COALESCE((
        SELECT m.body FROM messages m
        WHERE m.conversation_id = conversations.id
        ORDER BY m.created_at DESC LIMIT 1
      ), '')`.as("last_message"),
      lastMessageAtMs: sql<number>`COALESCE((
        SELECT (EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint FROM messages m
        WHERE m.conversation_id = conversations.id
        ORDER BY m.created_at DESC LIMIT 1
      ), 0)`.as("last_message_at_ms"),
      unread: sql<number>`(
        SELECT COUNT(*)::int FROM messages m
        WHERE m.conversation_id = conversations.id
          AND m.sender_id <> ${userId}
          AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
      )`.as("unread"),
    })
      .from(conversations)
      // The caller's own participant row supplies last_read_at (aliased `cp`,
      // which the unread subquery above correlates against).
      .innerJoin(sql`conversation_participants cp`, sql`cp.conversation_id = conversations.id AND cp.user_id = ${userId}`)
      // ...while the peer's row supplies the name shown in the list.
      .innerJoin(users, sql`${users.id} = (
        SELECT cp2.user_id FROM conversation_participants cp2
        WHERE cp2.conversation_id = conversations.id AND cp2.user_id <> ${userId}
        LIMIT 1
      )`)
      .where(inArray(conversations.id, mine));

    return rows
      .map(({ lastMessageAtMs, ...r }) => ({
        ...r,
        unread: Number(r.unread),
        lastMessageAt: Number(lastMessageAtMs) > 0 ? new Date(Number(lastMessageAtMs)) : null,
      }))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
  }

  /**
   * Idempotent per user-pair: opening the same DM twice must reuse the thread,
   * otherwise the FloatingChat "open chat" event would fork a new empty
   * conversation on every click.
   */
  async findOrCreateDirect(userA: string, userB: string): Promise<{ id: string }> {
    const [existing] = await this.db.select({ id: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.userId, userA),
        inArray(conversationParticipants.conversationId,
          this.db.select({ id: conversationParticipants.conversationId })
            .from(conversationParticipants)
            .where(eq(conversationParticipants.userId, userB))),
      ))
      .limit(1);
    if (existing) return { id: existing.id };

    const [conv] = await this.db.insert(conversations).values({}).returning({ id: conversations.id });
    await this.db.insert(conversationParticipants).values([
      { conversationId: conv!.id, userId: userA },
      { conversationId: conv!.id, userId: userB },
    ]);
    return { id: conv!.id };
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ n: sql<number>`1` }).from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      )).limit(1);
    return Boolean(row);
  }

  async markRead(conversationId: string, userId: string): Promise<void> {
    await this.db.update(conversationParticipants)
      .set({ lastReadAt: new Date() })
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ));
  }
}

export class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly db: Db) {}

  async listForConversation(conversationId: string) {
    const rows = await this.db.select({
      id: messages.id, senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt,
    }).from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    if (rows.length === 0) return [];

    const atts = await this.db.select({
      messageId: messageAttachments.messageId,
      id: uploads.id, name: uploads.filename, kind: uploads.kind,
    })
      .from(messageAttachments)
      .innerJoin(uploads, eq(uploads.id, messageAttachments.uploadId))
      .where(inArray(messageAttachments.messageId, rows.map((r) => r.id)));

    return rows.map((r) => ({
      ...r,
      attachments: atts.filter((a) => a.messageId === r.id)
        .map((a) => ({ id: a.id, name: a.name, kind: a.kind, url: `/api/uploads/${a.id}` })),
    }));
  }

  async create(input: { conversationId: string; senderId: string; body: string; attachmentIds?: string[] }) {
    const [row] = await this.db.insert(messages)
      .values({ conversationId: input.conversationId, senderId: input.senderId, body: input.body })
      .returning();
    if (input.attachmentIds?.length) {
      await this.db.insert(messageAttachments)
        .values(input.attachmentIds.map((uploadId) => ({ messageId: row!.id, uploadId })))
        .onConflictDoNothing();
    }
    return { id: row!.id, createdAt: row!.createdAt };
  }
}
