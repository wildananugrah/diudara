import { verifyUserWatchToken } from "../../domain/user-watch-token";
import { verifyWatchToken } from "../../domain/watch-token";
import type { EventRecord, EventRepositoryPort } from "../ports/event-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type {
  UserStreamRepositoryPort,
  UserStreamRow,
} from "../ports/user-stream-repository.port";
import { MEMBERS_ONLY } from "./post-views";

/**
 * `event.status` values a publish is allowed against. `ended` is
 * deliberately excluded — see the class docstring below.
 */
const PUBLISHABLE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "live"]);

/**
 * The one `user_stream.status` a publish is allowed against — Task 5, and the
 * community world's `PUBLISHABLE_STATUSES` rule applied to the new table.
 * There is no `scheduled` here: `StartUserStream` inserts a row that is
 * already `live` (there is nothing to schedule in Siaran), so the set has one
 * member rather than two. `ended` refuses for the identical reason the
 * community world gives — a finished session must not be republishable by
 * somebody who captured the RTMP URL after the creator moved on.
 */
const USER_PUBLISHABLE_STATUS = "live";

/**
 * The one `user_stream.visibility` that opens a read to everybody. Written
 * here as a literal beside `MEMBERS_ONLY` rather than imported from anywhere,
 * because the decision below is an ALLOW-LIST: see
 * `authoriseUserStreamRead`'s docstring for why this file must not be able to
 * infer "not gated" from "not the gated value".
 */
const PUBLIC_VISIBILITY = "public";

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
 * Every top-level path segment MediaMTX's stream paths are ever built
 * under in this codebase, mapped to the world it names. `live` is the one
 * `MediaMtxAdapter.createSession` has ever constructed — it builds both
 * `rtmp://<host>:1935/live/<streamKey>` and
 * `<hlsBaseUrl>/live/<streamKey>/index.m3u8` — and stays the community
 * `event` world unchanged. `u` is the new Phase 7 namespace for a person's
 * own `user_stream`.
 *
 * WHO OWNS WHAT, corrected — the previous version of this sentence named
 * TASK 3 as the task that teaches an adapter to construct `u/<key>` paths.
 * Task 3 never owned that, nothing did, and the gap survived a review
 * precisely because this comment said otherwise: `MediaMtxAdapter` went on
 * hard-coding `live/`, so a real user publish arrived here parsed as
 * `world: "community"` and the branch below was unreachable in production.
 * TASK 4 is what added `StreamingProviderPort`'s `namespace` parameter, the
 * `^~ /u/` and `^~ /whip/u/` locations in
 * `infra/nginx/live-hls.conf.template`, and
 * `authoriseUserReadByStreamId` below. TASK 5 is what teaches `execute()`'s
 * own read branch — MediaMTX's direct `authHTTPAddress` hook, which arrives
 * with `u/<streamKey>` — to answer for the user world, together with the
 * membership gate and the watch token that decide the answer.
 *
 * These two keys are the same pair `StreamNamespace`
 * (`streaming-provider.port.ts`) declares for the CONSTRUCTION side; see its
 * docstring for why they are written twice rather than derived. Adding a
 * THIRD namespace later means adding ONE entry here and one there — see
 * `parseStreamPath` below for why an entry not listed in this map is refused
 * rather than guessed at.
 */
const NAMESPACES: ReadonlyMap<string, "community" | "user"> = new Map([
  ["live", "community"],
  ["u", "user"],
]);

/**
 * Parses `path` into the world it names and the key inside it, requiring
 * EXACTLY `<namespace>/<key>` for a namespace listed in `NAMESPACES` above
 * (a leading/trailing slash tolerated, an empty key, extra segments, or an
 * unlisted namespace not) — `null` otherwise.
 *
 * THIS IS THE ONE PARSER. It used to be named `streamKeyFromPath`, return a
 * bare string, and recognise only `live/`; Phase 7 widened it to cover both
 * worlds rather than growing a second, sibling parser for `u/` — see the
 * design spec §6 and this task's ruling in `progress.md`. A second parser
 * would re-open, wearing a new prefix, the exact defect this one was
 * hardened against: REQUIRING the namespace, rather than just taking the
 * last segment regardless of what came before it, is load-bearing and not
 * merely tidy. Without it, `foo/bar/<key>` once authorised a publish
 * exactly as `live/<key>` did, for any real key — an attacker (or a
 * misconfigured MediaMTX) could publish to a path our own adapter never
 * constructs, and `HandleStreamLifecycle`'s `runOnOnline` would then fire
 * with `MTX_PATH=foo/bar/<key>`, mark the event `live`, and notify every
 * member with an HLS URL under `live/<key>` that nothing is actually
 * publishing to. An unknown or wrongly-shaped path now refuses outright
 * (`null`, which `AuthoriseStream.execute` and `HandleStreamLifecycle.execute`
 * both treat as an immediate refusal / no-op), matching only the shapes
 * this codebase's own adapters are ever meant to produce.
 *
 * EXPORTED for `HandleStreamLifecycle`: MediaMTX hands
 * `runOnOnline`/`runOnOffline` the SAME `$MTX_PATH` value — confirmed
 * against mediamtx.org's hooks documentation ("MTX_PATH: path name"),
 * which is the runtime path a client actually published to, i.e.
 * `live/<key>` (or, as of Task 4, `u/<key>`) under this
 * codebase's catch-all path config, not the bare key. Re-parsing it here
 * rather than duplicating the segment check a second time is what keeps
 * "what path shape is legitimate, and which world does it name" answered
 * in exactly one place.
 */
export function parseStreamPath(path: string): { world: "community" | "user"; key: string } | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }
  const world = NAMESPACES.get(segments[0]!);
  if (world === undefined) {
    return null;
  }
  return { world, key: segments[1]! };
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
 * A FOURTH ENTRY POINT — `authoriseUserReadByStreamId` — is the same idea
 * again for the USER world (Task 4), and exists for the same one caller:
 * nginx's `auth_request`, now also fronting the `^~ /u/` location. It
 * resolves `user_stream` by its opaque row id (never by its stream key —
 * see its own docstring) and returns that row's key on success so nginx can
 * rewrite onto MediaMTX's internal `u/<streamKey>` path.
 *
 * THE USER WORLD'S OWN TWO DECISIONS — Task 5, and until it landed this
 * branch refused everything, so nobody could go live at all:
 *
 *   - `publish`: allowed only if `u/<key>` resolves, via
 *     `UserStreamRepositoryPort.findByStreamKey`, to a row whose `status` is
 *     `live`. `ended` refuses, for the identical reason the community world
 *     refuses one. See `authoriseUserPublish`.
 *   - `read`: `authoriseUserStreamRead`, an ALLOW-LIST over `visibility` — a
 *     `public` row needs no token at all, a `members` row needs a valid
 *     `user-watch-token.ts` token NAMING THAT ROW, and any other visibility
 *     value is refused. It is the SAME function nginx's by-id entry point
 *     calls, deliberately: one decision, two callers, because two copies of a
 *     paywall drift and the drift is silent.
 *
 * The user world's read does NOT re-check membership on every segment the
 * way the community world's does. Its token lives ten minutes rather than
 * six hours and the player re-mints silently, so the entitlement check lives
 * at the MINT endpoint (`POST /streams/:id/watch-token`) where the viewer's
 * session actually is. Design spec §5; `authoriseUserStreamRead`'s own
 * docstring carries the full reasoning.
 *
 * EVERY refusal — no such event, ended event, bad signature, expired token,
 * wrong event, wrong community, cancelled subscription, an unknown or gated
 * user stream — returns the same `{ allowed: false }`. Nothing here, or in the route that calls this,
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
    private readonly userStreams: UserStreamRepositoryPort,
    private readonly config: { streamTokenSecret: string }
  ) {}

  async execute(input: {
    action: string;
    path: string;
    query: string;
    now: number;
  }): Promise<{ allowed: boolean }> {
    const parsed = parseStreamPath(input.path);
    if (!parsed) {
      return { allowed: false };
    }

    if (parsed.world === "user") {
      // TASK 5. This method is what MediaMTX's OWN `authHTTPAddress` hook
      // calls, with the path a client published to or read from —
      // `u/<streamKey>` — so BOTH actions resolve through
      // `UserStreamRepositoryPort.findByStreamKey`, never through the
      // `event` table this world has nothing to do with.
      //
      // Until Task 5 this branch refused everything, which meant nobody
      // could go live at all: Task 4 shipped the namespace, the nginx
      // locations and the by-id read entry point, and no task owned the
      // publish. `authorise-stream.test.ts`'s "user world publish" describe
      // is the replaced pin.
      if (input.action === "publish") {
        return this.authoriseUserPublish(parsed.key);
      }
      if (input.action === "read") {
        return this.authoriseUserReadByStreamKey(parsed.key, input.query, input.now);
      }
      return { allowed: false };
    }

    // parsed.world === "community" from here on — EXACT current behaviour,
    // unchanged by the addition of the user world above.
    const streamKey = parsed.key;
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
   * The USER world's publish — Task 5, and the ~4 lines that let anybody go
   * live at all.
   *
   * `findByStreamKey` is the ONE sanctioned unscoped lookup on this port, for
   * the same reason it is on `EventRepositoryPort`: MediaMTX knows only the
   * key baked into the RTMP/WHIP path and there is no authenticated creator
   * on this call. Only a `live` row publishes (`USER_PUBLISHABLE_STATUS`);
   * an `ended` row refuses, exactly as the community world refuses a publish
   * to a non-publishable status.
   *
   * NO VISIBILITY CHECK, deliberately: `visibility` gates who may WATCH, and
   * the person publishing is the owner, who is never gated out of their own
   * broadcast. A gated stream must be publishable or *Khusus anggota* would
   * be a switch that breaks going live.
   */
  private async authoriseUserPublish(streamKey: string): Promise<{ allowed: boolean }> {
    const stream = await this.userStreams.findByStreamKey(streamKey);
    if (!stream) {
      return { allowed: false };
    }
    return { allowed: stream.status === USER_PUBLISHABLE_STATUS };
  }

  /**
   * The USER world's read as MediaMTX's own hook asks it — resolved BY KEY,
   * because that hook only ever knows the path a client actually requested.
   * The decision itself is `authoriseUserStreamRead`, shared verbatim with
   * `authoriseUserReadByStreamId` (nginx's by-id entry point); this method is
   * nothing but the lookup in front of it.
   */
  private async authoriseUserReadByStreamKey(
    streamKey: string,
    query: string,
    now: number
  ): Promise<{ allowed: boolean }> {
    const stream = await this.userStreams.findByStreamKey(streamKey);
    if (!stream) {
      return { allowed: false };
    }
    return this.authoriseUserStreamRead(stream, query, now);
  }

  /**
   * nginx's `auth_request` re-authorisation for the USER world, by STREAM ID
   * — Task 4, and deliberately the SAME shape as `authoriseReadByEventId`
   * below rather than a second mechanism beside a working one.
   *
   * WHY BY ID. `GET /streams` is PUBLIC — signed in or not — and publishes
   * `/u/<streamId>/index.m3u8` (`userStreamPlaybackPath`), never
   * `createSession`'s `hlsPlaybackPath`, because that URL carries the stream
   * key and a stream key authorises a PUBLISH. That is the old world's own
   * Critical (see `ResolveWatchToken`'s docstring) with a wider blast
   * radius, and Task 3 closed it the same way the old world did. This method
   * is the read side meeting that decision: it resolves the PUBLIC id via
   * `findById` and, only on success, hands the caller the stream key so
   * nginx can rewrite onto MediaMTX's unchanged internal `u/<streamKey>`
   * path (`auth_request_set $mtx_ukey`, then
   * `proxy_pass .../u/$mtx_ukey$mtx_rest`). MediaMTX was never taught about
   * stream ids and does not need to be.
   *
   * A PUBLISH KEY IS NOT A SECOND WAY IN. `findById` looks in the `id`
   * column; nothing here ever consults `findByStreamKey`, and nothing here
   * ever falls back to it when the id misses. A read path that accepted
   * either identifier would quietly undo the entire reason ids are what get
   * published. `authorise-stream.test.ts` pins this with a real 32-hex key.
   *
   * THE GATE ITSELF IS NOT HERE. It is `authoriseUserStreamRead` below, which
   * this method and `execute()`'s own by-key user branch BOTH call — one
   * decision, two callers. Task 5's ruling, and not a stylistic one: two
   * copies of a paywall drift, and the drift is silent, because the copy that
   * loosened still has its own passing tests. `query` carries the watch token
   * (the route already forwards `X-Watch-Token` as `token=...` for both
   * worlds) and `now` is the instant the caller read once.
   *
   * NO STATUS CHECK, matching `authoriseReadByEventId` exactly: the community
   * world's read path has never consulted `event.status` either, and an
   * `ended` stream has nothing for MediaMTX to serve regardless. Adding one
   * here and not there would make the two worlds disagree about a rule
   * neither of them needs.
   */
  async authoriseUserReadByStreamId(input: {
    streamId: string;
    query: string;
    now: number;
  }): Promise<{ allowed: false } | { allowed: true; streamKey: string }> {
    const stream = await this.userStreams.findById(input.streamId);
    if (!stream) {
      return { allowed: false };
    }
    const result = this.authoriseUserStreamRead(stream, input.query, input.now);
    if (!result.allowed) {
      return { allowed: false };
    }
    return { allowed: true, streamKey: stream.streamKey };
  }

  /**
   * THE USER WORLD'S READ DECISION — the whole paywall, in one place, called
   * by both entry points: `authoriseUserReadByStreamId` (nginx's
   * `auth_request`, resolving by the opaque row id a browser is allowed to
   * know) and `authoriseUserReadByStreamKey` (MediaMTX's own
   * `authHTTPAddress` hook, resolving by the key baked into the path). By the
   * time either calls this, it has the row in hand and nothing past that
   * point differs. This mirrors `authoriseReadForEvent`, which the community
   * world's two entry points already share for the identical reason.
   *
   * DENY BY DEFAULT. The shape here is an ALLOW-LIST over `visibility` — a
   * `public` row is authorised, a `members` row is authorised only by a valid
   * token naming it, and ANY OTHER VALUE IS REFUSED. It is deliberately NOT
   * the `visibility !== MEMBERS_ONLY -> allow` test the earlier version of
   * this method used. `user_stream.visibility` is a widened `varchar`, so a
   * typo, a migration, or a future tier name would read as "not gated" and
   * open the stream to the public internet; `toStreamView`'s listing gate can
   * afford that reading because the write path is the authority on what may
   * be stored there and the worst case is a lock shown where none was meant.
   * Here the worst case is the paywall, and an allow-by-default paywall is
   * one typo from open.
   *
   * NO LIVE MEMBERSHIP RE-CHECK, and this is the ONE place the two worlds
   * deliberately disagree. The community world re-reads the subscription on
   * every segment (`authoriseReadForEvent`) because its token lives SIX
   * HOURS. This one lives TEN MINUTES and the player re-mints silently while
   * watching, so a membership that lapses mid-broadcast stops access at the
   * next re-mint — `MintUserWatchToken` is what asks `IsMemberOf`, and it
   * needs the viewer's own session to answer, which is exactly why a
   * forwarded token cannot be renewed. Design spec §5 states that bargain and
   * chooses it; this method is not the place to re-litigate it, and adding a
   * membership query here would put one on every HLS segment request.
   *
   * NO STATUS CHECK, matching both `authoriseReadByEventId` and this world's
   * own by-id entry point: an `ended` stream has nothing for MediaMTX to
   * serve regardless, and the player must be able to reach the point of
   * discovering that for itself rather than being handed a dead link.
   *
   * SYNCHRONOUS on purpose — it touches no repository. Everything it needs is
   * the row the caller already fetched, plus the token in the query.
   */
  private authoriseUserStreamRead(
    stream: UserStreamRow,
    query: string,
    now: number
  ): { allowed: boolean } {
    if (stream.visibility === PUBLIC_VISIBILITY) {
      // Nothing to gate. Spec §5: "A public stream needs no token" — there is
      // nothing to mint and nothing to refresh, and `MintUserWatchToken`
      // refuses to issue one for such a stream rather than handing out a
      // credential that means nothing.
      return { allowed: true };
    }
    if (stream.visibility !== MEMBERS_ONLY) {
      return { allowed: false };
    }

    const token = watchTokenFromQuery(query);
    if (!token) {
      return { allowed: false };
    }
    const claims = verifyUserWatchToken({
      token,
      now,
      secret: this.config.streamTokenSecret,
    });
    if (!claims) {
      return { allowed: false };
    }
    // A token proves "this viewer may watch stream X"; the signature never
    // mentions which stream is being REQUESTED. Without this comparison one
    // paid membership anywhere would open every gated broadcast on the
    // platform — the same defect class as Phase 6's forwarded media id.
    if (claims.streamId !== stream.id) {
      return { allowed: false };
    }
    return { allowed: true };
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
