import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { liveChatMessages, liveSessions, liveViewers, liveWatchTokens, users } from "../db/schema.ts";
import type { LiveRepository } from "../../domain/ports.ts";
import { VIEWER_PRESENCE_WINDOW_SECONDS } from "../../domain/livePresence.ts";

/**
 * How many distinct members have checked in recently — the only definition of
 * "watching" this system has.
 *
 * `live_sessions.id` is written out rather than interpolated: a Drizzle column
 * inside a `sql` template renders UNQUALIFIED, so a bare `"id"` would bind to the
 * subquery's own table (see DrizzleCommunityRepository.baseQuery for the bug that
 * caused). `make_interval` keeps the window a bound parameter, not string-built SQL.
 */
const presentViewers = sql<number>`(
  SELECT COUNT(*)::int FROM live_viewers lv
  WHERE lv.session_id = live_sessions.id
    AND lv.last_seen_at >= NOW() - make_interval(secs => ${VIEWER_PRESENCE_WINDOW_SECONDS})
)`;

export class DrizzleLiveRepository implements LiveRepository {
  constructor(private readonly db: Db) {}

  async findActiveForCommunity(communityId: string) {
    const [row] = await this.db.select({
      id: liveSessions.id, communityId: liveSessions.communityId, title: liveSessions.title,
      status: liveSessions.status, viewerCount: presentViewers, startedAt: liveSessions.startedAt,
      streamKey: liveSessions.streamKey,
    }).from(liveSessions)
      .where(and(eq(liveSessions.communityId, communityId), eq(liveSessions.status, "live")))
      .limit(1);
    return row ?? null;
  }

  async listChat(sessionId: string) {
    return this.db.select({
      id: liveChatMessages.id, userName: users.name,
      body: liveChatMessages.body, createdAt: liveChatMessages.createdAt,
    })
      .from(liveChatMessages)
      .innerJoin(users, eq(users.id, liveChatMessages.userId))
      .where(eq(liveChatMessages.sessionId, sessionId))
      .orderBy(asc(liveChatMessages.createdAt));
  }

  async postChat(input: { sessionId: string; userId: string; body: string }) {
    const [row] = await this.db.insert(liveChatMessages).values(input).returning();
    return { id: row!.id, createdAt: row!.createdAt };
  }

  async startByStreamKey(streamKey: string): Promise<boolean> {
    const rows = await this.db.update(liveSessions)
      .set({ status: "live", startedAt: new Date(), endedAt: null })
      .where(eq(liveSessions.streamKey, streamKey))
      .returning({ id: liveSessions.id });
    return rows.length > 0;
  }

  async endByStreamKey(streamKey: string): Promise<boolean> {
    const rows = await this.db.update(liveSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(liveSessions.streamKey, streamKey))
      .returning({ id: liveSessions.id });
    return rows.length > 0;
  }

  async findLatestForCommunity(communityId: string) {
    const [row] = await this.db.select({
      id: liveSessions.id, communityId: liveSessions.communityId,
      streamKey: liveSessions.streamKey, status: liveSessions.status,
      publishSecret: liveSessions.publishSecret,
    }).from(liveSessions)
      .where(eq(liveSessions.communityId, communityId))
      // Newest first: a community that somehow holds several rows (an older
      // backend seeded one, say) answers with the one an admin last worked with.
      .orderBy(desc(liveSessions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async createForCommunity(input: { communityId: string; streamKey: string; publishSecret: string }) {
    const [row] = await this.db.insert(liveSessions).values(input).returning({
      id: liveSessions.id, communityId: liveSessions.communityId,
      streamKey: liveSessions.streamKey, status: liveSessions.status,
      publishSecret: liveSessions.publishSecret,
    });
    return row!;
  }

  async rotateStreamKey(sessionId: string, streamKey: string, publishSecret: string) {
    await this.db.update(liveSessions)
      .set({ streamKey, publishSecret })
      .where(eq(liveSessions.id, sessionId));
  }

  async touchViewer(sessionId: string, userId: string) {
    await this.db.insert(liveViewers)
      .values({ sessionId, userId, lastSeenAt: new Date() })
      // One row per viewer per session: a long watch refreshes its own row rather
      // than growing the table by one insert every twenty seconds.
      .onConflictDoUpdate({
        target: [liveViewers.sessionId, liveViewers.userId],
        set: { lastSeenAt: new Date() },
      });
  }

  async findByStreamKey(streamKey: string) {
    const [row] = await this.db.select({
      id: liveSessions.id, communityId: liveSessions.communityId,
      publishSecret: liveSessions.publishSecret,
    }).from(liveSessions).where(eq(liveSessions.streamKey, streamKey)).limit(1);
    return row ?? null;
  }

  async createWatchToken(input: { token: string; sessionId: string; userId: string; expiresAt: Date }) {
    await this.db.insert(liveWatchTokens).values(input);
  }

  async findWatchToken(token: string) {
    // Joined to the session rather than trusting the token row alone: the key it
    // is valid for is whatever the room holds NOW, so rotation revokes playback.
    const [row] = await this.db.select({
      sessionId: liveWatchTokens.sessionId, userId: liveWatchTokens.userId,
      expiresAt: liveWatchTokens.expiresAt, streamKey: liveSessions.streamKey,
    })
      .from(liveWatchTokens)
      .innerJoin(liveSessions, eq(liveSessions.id, liveWatchTokens.sessionId))
      .where(eq(liveWatchTokens.token, token))
      .limit(1);
    return row ?? null;
  }

  async deleteExpiredWatchTokens(now: Date) {
    await this.db.delete(liveWatchTokens).where(lt(liveWatchTokens.expiresAt, now));
  }

  async deleteWatchTokensForSession(sessionId: string) {
    await this.db.delete(liveWatchTokens).where(eq(liveWatchTokens.sessionId, sessionId));
  }
}
