/**
 * `stream_viewer_heartbeat` — see that table's own docstring in `db/schema.ts`
 * for the full reasoning (why this exists, why it is one row per identity
 * rather than one per request, why a public read's identity is a hash rather
 * than a token claim).
 */
export interface StreamViewerRepositoryPort {
  /** Upserts `(streamId, identity)`'s `lastSeenAt` to `now`. */
  heartbeat(streamId: string, identity: string, now: Date): Promise<void>;

  /**
   * The count of DISTINCT identities per stream with a heartbeat at or after
   * `since` — `GET /streams`'s live viewer count. A stream id with no recent
   * heartbeat is simply absent from the returned map rather than mapped to
   * `0`; the caller (`ListLiveStreams`) defaults a miss to `0`.
   */
  countRecentViewers(streamIds: string[], since: Date): Promise<Map<string, number>>;

  /**
   * Deletes every heartbeat at or before `cutoff` — `SweepStaleViewerHeartbeats`'s
   * only need, and also the structural shape that sweep's own narrower
   * interface asks for (mirroring `StaleUserStreamRepository`'s
   * relationship to `UserStreamRepositoryPort`). Returns the count removed.
   */
  deleteOlderThan(cutoff: Date): Promise<number>;
}
