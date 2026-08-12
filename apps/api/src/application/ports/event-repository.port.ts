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
 * one row. There are now TWO sanctioned unscoped lookups, each documented at
 * its own declaration in the shape `CommunityRepositoryPort.findBySlug`
 * already uses for its own exception: `findByStreamKey` (MediaMTX knows only
 * the key baked into the RTMP path) and `findById` (Task 5's
 * `notify_stream_live` outbox consumer knows only the id `HandleStreamLifecycle`
 * wrote into the row's payload, and runs with no authenticated creator at
 * all — the same reason `MemberRepositoryPort.findById` is unscoped).
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

  /**
   * Transitions an event to `live`, but ONLY from `scheduled` — the status
   * check is part of the UPDATE's predicate, not a preceding read, for the
   * same reason `SubscriptionRepositoryPort.markPastDue`'s is: it is what
   * makes the transition atomic under a flapping publisher that fires
   * `runOnOnline` twice, or two overlapping deliveries of the same hook.
   *
   * Returns `null` — not an error — both when `id` does not exist and when
   * the event was not `scheduled` (already `live`, or `ended`). Both are
   * "nothing to do" to the caller (`HandleStreamLifecycle`): a second
   * `online` must not enqueue a second `notify_stream_live` row, and a late
   * `online` after `runOnOffline` has already fired must not resurrect an
   * `ended` event. See this port's docstring for why the method itself is
   * unscoped.
   */
  markLive(id: string): Promise<EventRecord | null>;

  /**
   * Transitions an event to `ended`, from EITHER `scheduled` or `live` — but
   * not from `ended` again. Same atomic-predicate shape as `markLive`, for
   * the same reason: MediaMTX can fire `runOnOffline` for a session the API
   * never saw go `online` (the API restarted mid-stream), so `scheduled` is
   * a legitimate starting point, not just `live`.
   *
   * The predicate is an ALLOWLIST of starting statuses (`{scheduled, live}`),
   * not a denylist of `ended` alone — this codebase's own rule (see
   * `REVOCABLE_COMMUNITY_STATUSES` in `process-churn.ts`): a denylist fails
   * OPEN on a status nobody anticipated; an allowlist fails CLOSED on it.
   *
   * Returns `null` when `id` does not exist or the event is already `ended`
   * — a repeated `offline` from a flapping publisher is a no-op, not an
   * error. See this port's docstring for why the method itself is unscoped.
   */
  markEnded(id: string): Promise<EventRecord | null>;

  /**
   * Unscoped by creator ON PURPOSE — MediaMTX's publish/read authorisation
   * webhook (Task 4) knows only the stream key baked into the RTMP path and
   * has no creator identity to scope by. Never call this to serve an
   * authenticated creator-facing route; every one of those has a
   * creator-scoped method above instead.
   */
  findByStreamKey(streamKey: string): Promise<EventRecord | null>;

  /**
   * One event by id, unscoped — the second sanctioned exception, alongside
   * `findByStreamKey`. Task 5's `notify_stream_live` outbox consumer starts
   * from the `eventId` `HandleStreamLifecycle` wrote into the row's payload
   * and has to re-read the event FRESH at delivery time (never trust what
   * was true at enqueue — the stream may already have ended), and it runs in
   * the worker, with no authenticated creator to scope by. A value that
   * cannot be an id — a jsonb payload can outlive a deploy — is a MISS
   * (`null`), never a driver error. Never call this to serve an
   * authenticated creator-facing route.
   */
  findById(id: string): Promise<EventRecord | null>;

  /**
   * The `live` event for a community, or `null` when none is currently live —
   * the THIRD sanctioned unscoped exception, alongside `findByStreamKey` and
   * `findById`. `GetSubscriptionStatus` (Task 8) backs the public, unauthenticated
   * `GET /c/subscription/:id/status` route: a member landed there off a redirect
   * URL, not an authenticated creator session, so there is no `creatorId` to scope
   * by — the same reason `findByStreamKey`/`findById` are unscoped, restated for a
   * third caller.
   *
   * This is deliberately NOT the entitlement check — `GetSubscriptionStatus` still
   * has to decide separately whether the CALLER'S subscription is `active` before
   * minting anything off what this returns. It only answers "does this community
   * have something to watch right now", which is what decides whether the
   * "Tonton sekarang" link appears at all.
   *
   * MORE THAN ONE `live` ROW PER COMMUNITY IS A REAL, REACHABLE STATE, NOT A BUG —
   * an earlier version of this docstring claimed `markLive`'s atomic predicate
   * made one-live-event-per-community a steady-state invariant, which review
   * caught as false: that predicate is `WHERE id = ? AND status = 'scheduled'`,
   * scoped to ONE event, not to the community. A creator who schedules two
   * sessions and publishes to BOTH stream keys gets two `live` rows for the same
   * community, and this method has to answer something anyway. It ORDERS BY `id`
   * so the choice is at least DETERMINISTIC (the same call always returns the
   * same row) rather than whatever order Postgres happens to return — `id` is not
   * a meaningful ordering (not "most recently gone live"), only a tie-break that
   * makes the method's own behaviour reproducible and testable.
   */
  findLiveByCommunityId(communityId: string): Promise<EventRecord | null>;
}
