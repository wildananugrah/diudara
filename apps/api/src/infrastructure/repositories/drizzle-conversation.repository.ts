import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, conversations, directMessages } from "../../db/schema";
import type {
  ConversationRepositoryPort,
  ConversationRow,
  DirectMessageRow,
} from "../../application/ports/conversation-repository.port";

/**
 * **THE canonical ordering, in one place.**
 *
 * Sorting by uuid is arbitrary but total, which is all a canonical form
 * needs. Every write and every lookup goes through this, so no caller can
 * produce the reversed pair that `conversation_ordered_pair` would reject —
 * and, more importantly, no caller can produce a SECOND conversation for a
 * pair that already has one.
 */
function orderedPair(a: string, b: string): { lower: string; higher: string } {
  return a < b ? { lower: a, higher: b } : { lower: b, higher: a };
}

export class DrizzleConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async findBetween(a: string, b: string): Promise<{ id: string } | null> {
    const { lower, higher } = orderedPair(a, b);
    const [row] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.lowerUserId, lower), eq(conversations.higherUserId, higher))
      )
      .limit(1);
    return row ?? null;
  }

  async findOrCreateBetween(a: string, b: string): Promise<{ id: string }> {
    const { lower, higher } = orderedPair(a, b);
    const existing = await this.findBetween(a, b);
    if (existing !== null) return existing;

    // `onConflictDoNothing` rather than trusting the read above: two taps of
    // "message this person" in the same instant both miss, and the index is
    // what arbitrates. A losing insert returns no row, so the re-read below
    // is what hands it the winner's.
    const [inserted] = await this.db
      .insert(conversations)
      .values({ lowerUserId: lower, higherUserId: higher })
      .onConflictDoNothing({
        target: [conversations.lowerUserId, conversations.higherUserId],
      })
      .returning({ id: conversations.id });
    if (inserted !== undefined) return inserted;

    const [won] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.lowerUserId, lower), eq(conversations.higherUserId, higher))
      )
      .limit(1);
    if (won === undefined) {
      // The conflict fired but the row is not there: not a missing
      // conversation, a broken assumption. Loud rather than a silent null.
      throw new Error(
        "DrizzleConversationRepository.findOrCreateBetween: the pair conflicted but no row exists"
      );
    }
    return won;
  }

  /**
   * ONE query for the list, its previews and its counts.
   *
   * The viewer can be on either side, so `other` and `myReadMark` are both
   * CASE expressions over which column the viewer occupies. The alternative —
   * two queries unioned, or a fetch per row — is more code and more round
   * trips for the same answer.
   */
  listFor(viewerId: string): Promise<ConversationRow[]> {
    const isLower = sql`${conversations.lowerUserId} = ${viewerId}`;
    const otherId = sql`case when ${isLower} then ${conversations.higherUserId} else ${conversations.lowerUserId} end`;
    const myReadMark = sql`case when ${isLower} then ${conversations.lowerLastReadAt} else ${conversations.higherLastReadAt} end`;

    const lastMessage = sql<string | null>`(
      select body from ${directMessages}
      where ${directMessages.conversationId} = ${conversations.id}
      order by ${directMessages.createdAt} desc limit 1
    )`;
    const lastAt = sql<string | null>`(
      select created_at from ${directMessages}
      where ${directMessages.conversationId} = ${conversations.id}
      order by ${directMessages.createdAt} desc limit 1
    )`;
    // Messages I did not send, newer than my mark. A NULL mark means never
    // opened, which counts everything — that falls out of the comparison
    // rather than needing a branch.
    const unread = sql<number>`(
      select count(*) from ${directMessages}
      where ${directMessages.conversationId} = ${conversations.id}
        and ${directMessages.senderId} <> ${viewerId}
        and (${myReadMark} is null or ${directMessages.createdAt} > ${myReadMark})
    )`;

    return this.db
      .select({
        id: conversations.id,
        otherHandle: appUsers.handle,
        otherDisplayName: appUsers.displayName,
        lastMessageBody: lastMessage,
        lastMessageAt: lastAt,
        unreadCount: unread,
      })
      .from(conversations)
      .innerJoin(appUsers, sql`${appUsers.id} = ${otherId}`)
      .where(
        or(eq(conversations.lowerUserId, viewerId), eq(conversations.higherUserId, viewerId))
      )
      // Most recently ACTIVE first, falling back to when it was created so a
      // conversation nobody has spoken in still has a stable place.
      .orderBy(desc(sql`coalesce(${lastAt}, ${conversations.createdAt})`))
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          // The driver hands a raw-SQL subquery back as a STRING — drizzle
          // cannot know its type, so `sql<Date>` is a claim about intent, not
          // a conversion. Converted HERE so the port's `Date | null` is true
          // rather than merely declared; a view mapper calling
          // `.toISOString()` on a string is how that lie surfaces.
          lastMessageAt: row.lastMessageAt === null ? null : new Date(row.lastMessageAt),
          unreadCount: Number(row.unreadCount),
        }))
      );
  }

  async findParticipating(
    conversationId: string,
    viewerId: string
  ): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          // Membership is part of the LOOKUP, not a check after it. A caller
          // cannot forget to apply it, and absence and refusal collapse into
          // one answer — which is what lets the route 404 both.
          or(eq(conversations.lowerUserId, viewerId), eq(conversations.higherUserId, viewerId))
        )
      )
      .limit(1);
    return row ?? null;
  }

  listMessages(conversationId: string, limit: number): Promise<DirectMessageRow[]> {
    return this.db
      .select({
        id: directMessages.id,
        senderHandle: appUsers.handle,
        body: directMessages.body,
        createdAt: directMessages.createdAt,
      })
      .from(directMessages)
      .innerJoin(appUsers, eq(appUsers.id, directMessages.senderId))
      .where(eq(directMessages.conversationId, conversationId))
      .orderBy(asc(directMessages.createdAt))
      .limit(limit);
  }

  async send(conversationId: string, senderId: string, body: string): Promise<DirectMessageRow> {
    const [inserted] = await this.db
      .insert(directMessages)
      .values({ conversationId, senderId, body })
      .returning({ id: directMessages.id });
    const [row] = await this.listMessagesById(inserted!.id);
    if (row === undefined) {
      throw new Error("message disappeared immediately after insert");
    }
    return row;
  }

  private listMessagesById(id: string): Promise<DirectMessageRow[]> {
    return this.db
      .select({
        id: directMessages.id,
        senderHandle: appUsers.handle,
        body: directMessages.body,
        createdAt: directMessages.createdAt,
      })
      .from(directMessages)
      .innerJoin(appUsers, eq(appUsers.id, directMessages.senderId))
      .where(eq(directMessages.id, id));
  }

  /**
   * Moves THIS viewer's mark only. Which column that is depends on which side
   * they are, so the update writes whichever one matches — the other side's
   * mark is never touched.
   */
  async markRead(conversationId: string, viewerId: string): Promise<void> {
    const now = new Date();
    // TWO guarded updates rather than one `CASE`. The CASE form needs an
    // explicit cast on the timestamp parameter — Postgres cannot infer a
    // parameter's type inside it and refuses the statement — and each of
    // these is a plain no-op for the side the viewer is not on, which is both
    // shorter and obviously correct.
    await this.db
      .update(conversations)
      .set({ lowerLastReadAt: now })
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.lowerUserId, viewerId))
      );
    await this.db
      .update(conversations)
      .set({ higherLastReadAt: now })
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.higherUserId, viewerId))
      );
  }
}
