import { and, gte, inArray, lte, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { streamViewerHeartbeats } from "../../db/schema";
import type { StreamViewerRepositoryPort } from "../../application/ports/stream-viewer-repository.port";

export class DrizzleStreamViewerRepository implements StreamViewerRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * `ON CONFLICT ... DO UPDATE` against the `(stream_id, identity)` unique
   * index — one row per viewer per stream, however many HLS requests they
   * make, rather than a row per request.
   */
  async heartbeat(streamId: string, identity: string, now: Date): Promise<void> {
    await this.db
      .insert(streamViewerHeartbeats)
      .values({ streamId, identity, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [streamViewerHeartbeats.streamId, streamViewerHeartbeats.identity],
        set: { lastSeenAt: now },
      });
  }

  async countRecentViewers(streamIds: string[], since: Date): Promise<Map<string, number>> {
    if (streamIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        streamId: streamViewerHeartbeats.streamId,
        value: sql<number>`count(*)`,
      })
      .from(streamViewerHeartbeats)
      .where(
        and(
          inArray(streamViewerHeartbeats.streamId, streamIds),
          gte(streamViewerHeartbeats.lastSeenAt, since)
        )
      )
      .groupBy(streamViewerHeartbeats.streamId);

    return new Map(rows.map((row) => [row.streamId, Number(row.value)]));
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(streamViewerHeartbeats)
      .where(lte(streamViewerHeartbeats.lastSeenAt, cutoff))
      .returning({ id: streamViewerHeartbeats.id });
    return deleted.length;
  }
}
