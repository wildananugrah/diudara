import { and, desc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { communities, events } from "../../db/schema";
import type { EventRecord, EventRepositoryPort } from "../../application/ports/event-repository.port";

/** `event.status` once MediaMTX's `runOnOnline` hook fires (Task 4). */
const LIVE_STATUS = "live";

/** `event.status` once MediaMTX's `runOnOffline` hook fires (Task 4). */
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
    const [row] = await this.db
      .update(events)
      .set({ status: LIVE_STATUS })
      .where(eq(events.id, id))
      .returning();
    return row ?? null;
  }

  async markEnded(id: string): Promise<EventRecord | null> {
    const [row] = await this.db
      .update(events)
      .set({ status: ENDED_STATUS })
      .where(eq(events.id, id))
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
}
