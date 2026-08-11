/** One `event` row — a scheduled, live, or concluded streaming session. */
export interface EventRecord {
  id: string;
  communityId: string;
  title: string;
  scheduledAt: Date | null;
  meetingLink: string | null;
  /**
   * The secret MediaMTX authenticates a publish against. Present once
   * `ScheduleLiveSession` mints one, and never cleared afterwards — it stays
   * on the row so `findByStreamKey` (Task 4's publish/read authorisation)
   * keeps resolving the same event for the whole life of the session.
   *
   * A SECRET. It travels to the creator who owns the community and nobody
   * else — never to another creator's response, never into `activity_log`,
   * never into an error message or a log line. See
   * `EventRepositoryPort`'s own docstring for the scoping that is the other
   * half of that guarantee.
   */
  streamKey: string | null;
  /** `scheduled` | `live` | `ended`, per the design spec's lifecycle (§4). */
  status: string;
  hlsPlaybackPath: string | null;
  recordingUrl: string | null;
}

/**
 * Every creator-facing method takes `creatorId` and scopes on it, and there
 * is no unscoped variant — same design as `AnalyticsRepositoryPort`, and for
 * the same reason (see that port's docstring, and `CommunityRepositoryPort`'s
 * before it): the ABSENCE of the dangerous method is what makes the
 * vulnerable query hard to write by accident. `event` carries no
 * `creator_id` column of its own — only `community_id` — so scoping has to
 * go through the community it belongs to, exactly as `AnalyticsRepositoryPort`
 * scopes `activity_log` and `subscription` through `community`/`membership_tier`.
 *
 * A creator-facing method returns `null` — never throws, never returns a
 * partial record — when the community does not exist OR belongs to another
 * creator. THE TWO CASES ARE DELIBERATELY INDISTINGUISHABLE: a use-case turns
 * `null` into `NotFoundError`, so the wire answer is 404, never 403 — a 403
 * would confirm to a stranger that another creator's community exists.
 *
 * `markLive` and `markEnded` are NOT creator-facing and therefore not
 * scoped: Task 4's MediaMTX webhook resolves the one event a stream key
 * identifies via `findByStreamKey` below, and by the time either is called
 * ownership is not the question being asked — the key already picked exactly
 * one row. The single sanctioned unscoped LOOKUP is `findByStreamKey` itself,
 * documented at its own declaration in the shape `CommunityRepositoryPort.findBySlug`
 * already uses for its own exception.
 */
export interface EventRepositoryPort {
  /**
   * Schedules a session. `streamKey` and `hlsPlaybackPath` are supplied by
   * the caller (`ScheduleLiveSession`, which minted the key and asked the
   * streaming provider to build the URLs from it) rather than computed here
   * — this repository has no opinion on either, only on where the row is
   * allowed to be written. `null` when `creatorId` does not own
   * `communityId`; nothing is inserted in that case.
   */
  createForCreator(input: {
    communityId: string;
    creatorId: string;
    title: string;
    scheduledAt: Date | null;
    streamKey: string;
    hlsPlaybackPath: string;
  }): Promise<EventRecord | null>;

  /** One event, or `null` when it does not exist or `creatorId` does not own `communityId`. */
  findByIdForCreator(id: string, communityId: string, creatorId: string): Promise<EventRecord | null>;

  /**
   * Every session ever scheduled for a community, newest scheduled time
   * first — or `null` when `creatorId` does not own `communityId`. `null`
   * and `[]` mean different things: `null` is "not your community" and
   * becomes a 404; `[]` is "no sessions yet".
   */
  listForCommunityForCreator(communityId: string, creatorId: string): Promise<EventRecord[] | null>;

  /** Transitions an event to `live`. See this port's docstring for why it is unscoped. */
  markLive(id: string): Promise<EventRecord | null>;

  /** Transitions an event to `ended`. See this port's docstring for why it is unscoped. */
  markEnded(id: string): Promise<EventRecord | null>;

  /**
   * Unscoped by creator ON PURPOSE — MediaMTX's publish/read authorisation
   * webhook (Task 4) knows only the stream key baked into the RTMP path and
   * has no creator identity to scope by. This is the ONLY unscoped lookup
   * that returns a record. Never call this to serve an authenticated
   * creator-facing route; every one of those has a creator-scoped method
   * above instead.
   */
  findByStreamKey(streamKey: string): Promise<EventRecord | null>;
}
