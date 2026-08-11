import { and, desc, eq, ne } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { communities, events } from "../../db/schema";
import type { EventRecord, EventRepositoryPort } from "../../application/ports/event-repository.port";

/** `event.status` from the moment `ScheduleLiveSession` creates the row. */
const SCHEDULED_STATUS = "scheduled";

/** `event.status` once MediaMTX's `runOnOnline` hook fires (Task 5). */
const LIVE_STATUS = "live";

/** `event.status` once MediaMTX's `runOnOffline` hook fires (Task 5). */
const ENDED_STATUS = "ended";

/**
 * `event` has no `creator_id` of its own — only `community_id` — so every
 * creator-facing method here is scoped through `community`, exactly as
 * `DrizzleAnalyticsRepository` scopes `activity_log` through it. See
 * `EventRepositoryPort`'s docstring for why that scoping lives here rather
 * than in a use-case, and why `findByStreamKey` is the one exception.
 */
export class DrizzleEventRepository implements EventRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * THE SCOPING QUERY, and the only place `creatorId` is compared — see
   * `DrizzleAnalyticsRepository.findOwnedCommunity`, which this mirrors
   * exactly. Every event query below runs this first, so `community_id = ?`
   * alone is sound for the query that follows: a community has exactly one
   * owner, so "this community's events" and "this creator's events in this
   * community" are the same set once this has returned a row.
   */
  private async findOwnedCommunity(
    communityId: string,
    creatorId: string
  ): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: communities.id })
      .from(communities)
      .where(and(eq(communities.id, communityId), eq(communities.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async createForCreator(input: {
    communityId: string;
    creatorId: string;
    title: string;
    scheduledAt: Date | null;
    streamKey: string;
    hlsPlaybackPath: string;
  }): Promise<EventRecord | null> {
    const community = await this.findOwnedCommunity(input.communityId, input.creatorId);
    if (!community) return null;

    const [row] = await this.db
      .insert(events)
      .values({
        communityId: community.id,
        title: input.title,
        scheduledAt: input.scheduledAt,
        streamKey: input.streamKey,
        hlsPlaybackPath: input.hlsPlaybackPath,
      })
      .returning();
    return row;
  }

  async findByIdForCreator(
    id: string,
    communityId: string,
    creatorId: string
  ): Promise<EventRecord | null> {
    const community = await this.findOwnedCommunity(communityId, creatorId);
    if (!community) return null;

    const [row] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.communityId, community.id)))
      .limit(1);
    return row ?? null;
  }

  async listForCommunityForCreator(
    communityId: string,
    creatorId: string
  ): Promise<EventRecord[] | null> {
    const community = await this.findOwnedCommunity(communityId, creatorId);
    if (!community) return null;

    return this.db
      .select()
      .from(events)
      .where(eq(events.communityId, community.id))
      .orderBy(desc(events.scheduledAt));
  }

  async markLive(id: string): Promise<EventRecord | null> {
    // `status = SCHEDULED_STATUS` is IN the predicate, not read first — see the port
    // docstring. That is what makes a second `online` hook, or two overlapping
    // deliveries of the same one, a no-op instead of a second `activity_log` row
    // and a second outbox row: the row that actually flips the status is the only
    // one that gets a non-null result back.
    const [row] = await this.db
      .update(events)
      .set({ status: LIVE_STATUS })
      .where(and(eq(events.id, id), eq(events.status, SCHEDULED_STATUS)))
      .returning();
    return row ?? null;
  }

  async markEnded(id: string): Promise<EventRecord | null> {
    // `status <> ENDED_STATUS`, not `= LIVE_STATUS`: MediaMTX can fire `runOnOffline`
    // for a session the API never saw go online (the API restarted mid-stream), so
    // `scheduled -> ended` is a real, legitimate transition here — only `ended ->
    // ended` is refused, which is what makes a repeated `offline` idempotent.
    const [row] = await this.db
      .update(events)
      .set({ status: ENDED_STATUS })
      .where(and(eq(events.id, id), ne(events.status, ENDED_STATUS)))
      .returning();
    return row ?? null;
  }

  async findByStreamKey(streamKey: string): Promise<EventRecord | null> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(eq(events.streamKey, streamKey))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<EventRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      // A MISS, not a driver error — same rule as `MemberRepositoryPort.findById`.
      // `id` comes out of an outbox payload, a jsonb column that can outlive a deploy.
      return null;
    }
    const [row] = await this.db.select().from(events).where(eq(events.id, id)).limit(1);
    return row ?? null;
  }
}

/**
 * Matches a well-formed UUID. `findById` guards on this before ever reaching
 * Postgres, exactly like `DrizzleSubscriptionRepository`'s own copy — see
 * that file's for the full reasoning. Duplicated rather than shared because
 * neither repository imports the other and the pattern is a one-liner.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
