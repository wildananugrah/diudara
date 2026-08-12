import { verifyWatchToken } from "../../domain/watch-token";
import type { EventRecord, EventRepositoryPort } from "../ports/event-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/**
 * `event.status` values a publish is allowed against. `ended` is
 * deliberately excluded — see the class docstring below.
 */
const PUBLISHABLE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "live"]);

/**
 * The one status a watch token's subscription must hold for a read to be
 * allowed. Deliberately narrower than `hasLiveSubscriptionInCommunity`
 * (which also accepts `past_due`, for channel-gating purposes elsewhere):
 * the design spec's own error table (§8) says "the subscription is no
 * longer active" refuses a read, and the brief for this task says the same
 * thing in the same word. A grace-period member keeps their Telegram
 * access; this task does not extend that grace to the live stream.
 */
const ENTITLED_STATUS = "active";

/**
 * The one top-level path segment MediaMTX's stream paths are ever built
 * under in this codebase — see `MediaMtxAdapter.createSession`, which
 * constructs both `rtmp://<host>:1935/live/<streamKey>` and
 * `<hlsBaseUrl>/live/<streamKey>/index.m3u8`. Every real publish and every
 * real read this route will ever see therefore has `path = "live/<key>"`,
 * nothing else.
 */
const LIVE_PATH_SEGMENT = "live";

/**
 * Extracts the stream key from `path`, requiring EXACTLY `live/<key>` (a
 * leading/trailing slash tolerated, an empty key or extra segments not).
 *
 * REQUIRING the `live/` prefix, rather than just taking the last segment
 * regardless of what came before it, is load-bearing and not merely tidy:
 * without it, `foo/bar/<key>` authorised a publish exactly as `live/<key>`
 * did, for any real key — an attacker (or a misconfigured MediaMTX) could
 * publish to a path our own adapter never constructs, and Task 5's
 * `runOnOnline` would then fire with `MTX_PATH=foo/bar/<key>`, mark the
 * event `live`, and notify every member with an HLS URL under
 * `live/<key>` that nothing is actually publishing to. An unknown or
 * wrongly-shaped path now refuses outright (`""`, which never resolves via
 * `findByStreamKey`), matching the ONE shape this codebase's own adapter
 * ever produces.
 *
 * EXPORTED for `HandleStreamLifecycle` (Task 5): MediaMTX hands
 * `runOnOnline`/`runOnOffline` the SAME `$MTX_PATH` value — confirmed
 * against mediamtx.org's hooks documentation ("MTX_PATH: path name"),
 * which is the runtime path a client actually published to, i.e.
 * `live/<key>` under this codebase's catch-all path config, not the bare
 * key. Re-parsing it here rather than duplicating the two-segment check a
 * second time is what keeps "what path shape is legitimate" answered in
 * exactly one place; see this task's carry-forward note in
 * `progress.md` for the failure mode a second, looser parser would
 * reopen (an event marked `live` from a path this codebase's own adapter
 * never constructs, whose members are then sent an HLS URL that points
 * nowhere).
 */
export function streamKeyFromPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== LIVE_PATH_SEGMENT) {
    return "";
  }
  return segments[1]!;
}

/**
 * MediaMTX's `query` field is the raw query string of the request it is
 * authorising (per mediamtx.org's authentication docs — see this class's
 * own docstring for the citation), which may or may not carry a leading
 * `?` depending on version. Stripping it defensively costs nothing and
 * `URLSearchParams` tolerates an already-bare string unchanged.
 */
function watchTokenFromQuery(query: string): string | null {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  return params.get("token");
}

/**
 * `POST /webhooks/mediamtx/auth`'s decision logic — the security core of
 * the live-streaming phase. MediaMTX's `authHTTPAddress` mechanism (see
 * `routes/mediamtx-webhooks.ts` for the exact wire contract) asks this,
 * through the route, to authorise EVERY publish and EVERY read: there is no
 * other gate. A stream key is not a secret the moment MediaMTX's public
 * RTMP port is up, and a watch token is not a secret to the person it names
 * — this class is what stands between either of those and someone who
 * should not have them.
 *
 * PAYLOAD SHAPE, verified against MediaMTX's own docs (mediamtx.org/docs/
 * features/authentication) rather than assumed: MediaMTX POSTs
 * `{ user, password, token, ip, action, path, protocol, id, query,
 * userAgent }`, where `action` is one of `publish|read|playback|api|
 * metrics|pprof`. This class only ever receives `action`, `path`, `query`
 * and `now` (the route extracts the first three from that body) — the
 * remaining fields (`user`, `password`, `token`, `ip`, `protocol`, `id`,
 * `userAgent`) carry nothing either publish or read authorisation depends
 * on here, so the route does not forward them and this class has no
 * parameter for them.
 *
 * TWO DECISIONS, and the read decision is the one this task exists to get
 * right:
 *
 *   - `publish`: allowed only if `path` resolves, via
 *     `EventRepositoryPort.findByStreamKey` — the ONE sanctioned unscoped
 *     lookup, because MediaMTX knows only the key baked into the RTMP path
 *     — to an event whose `status` is `scheduled` or `live`. `ended`
 *     refuses: a finished session must not be republishable, because
 *     nothing else stops someone who captured the RTMP URL from restarting
 *     it after the creator has moved on.
 *   - `read`: FOUR things must ALL hold, and any one failing refuses:
 *       1. `path` resolves to a real event via `findByStreamKey`.
 *       2. `query` carries a `token` that `verifyWatchToken` accepts —
 *          correctly signed, well-formed, not expired.
 *       3. The token's `eventId` is the SAME event `path` resolved to. A
 *          token proves "this subscription may watch event X"; without this
 *          check it would prove "this subscription may watch ANY event",
 *          because the signature never mentions which stream is being
 *          requested.
 *       4. THE ENTITLEMENT RE-CHECK: the token's `subscriptionId` still
 *          resolves (`SubscriptionRepositoryPort.findByIdWithCommunity`) to
 *          a subscription that is `active` AND belongs to the SAME
 *          community the event belongs to. This is not redundant with (2) —
 *          a token proves who a request was minted FOR, at MINT time, and
 *          says nothing about whether they are still entitled NOW.
 *          Phase 5 shipped a Critical from exactly this omission in
 *          `RevokeChannelAccessForSystem`; `watch-token.ts`'s own docstring
 *          carries the same warning. A member who churns mid-stream must
 *          lose access on their very next segment request, not at the end
 *          of the token's 6-hour lifetime.
 *
 * A THIRD ENTRY POINT — `authoriseReadByEventId`, below — exists for exactly
 * one caller: nginx's `auth_request` re-authorisation (Task 9,
 * `mediamtx-webhooks.ts`'s `/auth-request` route). FINAL WHOLE-BRANCH REVIEW
 * CRITICAL, FIXED HERE: `createSession` (`MediaMtxAdapter`) builds the
 * member-facing HLS URL from the SAME `streamKey` that authorises a publish
 * — so the URL handed to every paying member is also, verbatim, the
 * publish credential, and this `execute()` method's `read` branch (resolving
 * by `streamKey` via `path`) cannot be the thing nginx calls without that
 * credential appearing in a member's browser history. The fix decouples the
 * two: the PUBLIC HLS path a member's browser ever sees is
 * `/live/<eventId>/...`, never `/live/<streamKey>/...` — eventId is not a
 * credential, it is an opaque row id a member is always allowed to know they
 * are watching. `authoriseReadByEventId` resolves by `findById` (the SAME
 * sanctioned unscoped-by-id lookup `ResolveWatchToken` already uses — there
 * is no authenticated creator on this path either), runs the IDENTICAL
 * token-and-entitlement checks as `execute()`'s `read` branch, and — ONLY on
 * success — returns the event's `streamKey` so the caller (nginx, via
 * `auth_request_set`) can rewrite the request onto MediaMTX's UNCHANGED
 * internal path before proxying. MediaMTX itself was never taught about
 * event ids and still only understands `live/<streamKey>` — the internal
 * publish/read surface is deliberately untouched by this fix, only the
 * public-facing HLS path changed. The key crosses exactly one boundary (an
 * HTTP response header nginx reads over `127.0.0.1`, captured by
 * `auth_request_set` and never forwarded to the original client) and is
 * never present in the two literal bodies (`ALLOWED_BODY`/`REFUSED_BODY`)
 * either endpoint ever sends to anything a browser can see.
 *
 * EVERY refusal — no such event, ended event, bad signature, expired token,
 * wrong event, wrong community, cancelled subscription — returns the same
 * `{ allowed: false }`. Nothing here, or in the route that calls this,
 * distinguishes one refusal reason from another: doing so would let a
 * prober learn whether a stream key exists, or whether a given subscription
 * id is real, from the SHAPE of a rejection.
 *
 * Any `action` other than `publish` or `read` (`playback`, `api`,
 * `metrics`, `pprof`, or a value a future MediaMTX version invents) is
 * refused. `playback` in particular is NOT what live HLS viewing sends —
 * per mediamtx.org, "the read action is specifically used for consuming
 * HLS streams"; `playback` belongs to MediaMTX's separate dedicated
 * recordings/VOD HTTP server, which this design does not use (recordings
 * are served from `StoragePort`/S3, per the design spec's scope), so it
 * should never legitimately reach this route at all. This webhook was
 * built to reason about the two actions the design spec names; failing
 * OPEN on an action nobody has reviewed would be the wrong default for the
 * one endpoint standing between a paid stream and
 * the public internet.
 */
export class AuthoriseStream {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly config: { streamTokenSecret: string }
  ) {}

  async execute(input: {
    action: string;
    path: string;
    query: string;
    now: number;
  }): Promise<{ allowed: boolean }> {
    const streamKey = streamKeyFromPath(input.path);
    if (streamKey === "") {
      return { allowed: false };
    }

    if (input.action === "publish") {
      return this.authorisePublish(streamKey);
    }
    if (input.action === "read") {
      return this.authoriseRead(streamKey, input.query, input.now);
    }
    return { allowed: false };
  }

  private async authorisePublish(streamKey: string): Promise<{ allowed: boolean }> {
    const event = await this.events.findByStreamKey(streamKey);
    if (!event) {
      return { allowed: false };
    }
    return { allowed: PUBLISHABLE_STATUSES.has(event.status) };
  }

  private async authoriseRead(
    streamKey: string,
    query: string,
    now: number
  ): Promise<{ allowed: boolean }> {
    const event = await this.events.findByStreamKey(streamKey);
    if (!event) {
      return { allowed: false };
    }
    return this.authoriseReadForEvent(event, query, now);
  }

  /**
   * nginx's `auth_request` re-authorisation, by EVENT ID — see this class's
   * own docstring (the "THIRD ENTRY POINT" section) for the full reasoning.
   * `findById` is the second sanctioned unscoped lookup (alongside
   * `findByStreamKey`), documented on `EventRepositoryPort` itself; there is
   * no authenticated creator on this path.
   *
   * Runs the SAME token-and-entitlement checks `authoriseRead` does — see
   * `authoriseReadForEvent` below, which both now share — and, ONLY on
   * success, returns the event's `streamKey` so the caller can rewrite the
   * request onto MediaMTX's unchanged internal path. A `null` `streamKey` on
   * the resolved event (should never happen for a row `ScheduleLiveSession`
   * created, but this port's type allows it) refuses rather than handing
   * back an empty string nginx would proxy onto a bare `/live/` path.
   */
  async authoriseReadByEventId(input: {
    eventId: string;
    query: string;
    now: number;
  }): Promise<{ allowed: false } | { allowed: true; streamKey: string }> {
    const event = await this.events.findById(input.eventId);
    if (!event || !event.streamKey) {
      return { allowed: false };
    }
    const result = await this.authoriseReadForEvent(event, input.query, input.now);
    if (!result.allowed) {
      return { allowed: false };
    }
    return { allowed: true, streamKey: event.streamKey };
  }

  /**
   * The read decision's actual logic, shared by `authoriseRead` (resolves
   * `event` by stream key, for MediaMTX's own direct `authHTTPAddress`
   * call) and `authoriseReadByEventId` (resolves `event` by id, for nginx's
   * `auth_request`) — both already have `event` in hand by the time this
   * runs, and everything past that point is identical: THE ENTITLEMENT
   * RE-CHECK, read fresh on every single request, never cached, never
   * trusted from the token — see this class's own docstring.
   */
  private async authoriseReadForEvent(
    event: EventRecord,
    query: string,
    now: number
  ): Promise<{ allowed: boolean }> {
    const token = watchTokenFromQuery(query);
    if (!token) {
      return { allowed: false };
    }

    const claims = verifyWatchToken({ token, now, secret: this.config.streamTokenSecret });
    if (!claims) {
      return { allowed: false };
    }
    if (claims.eventId !== event.id) {
      return { allowed: false };
    }

    const entitlement = await this.subscriptions.findByIdWithCommunity(claims.subscriptionId);
    if (!entitlement) {
      return { allowed: false };
    }
    if (entitlement.subscription.status !== ENTITLED_STATUS) {
      return { allowed: false };
    }
    if (entitlement.communityId !== event.communityId) {
      return { allowed: false };
    }

    return { allowed: true };
  }
}
