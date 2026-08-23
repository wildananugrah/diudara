import { verifyUserWatchToken } from "../../domain/user-watch-token";
import type {
  UserStreamRepositoryPort,
  UserStreamRow,
} from "../ports/user-stream-repository.port";
import { MEMBERS_ONLY } from "./post-views";

/**
 * The one `user_stream.status` a publish is allowed against — Phase 7's Task 5.
 * There is no `scheduled` here: `StartUserStream` inserts a row that is
 * already `live` (there is nothing to schedule in Siaran), so the set has one
 * member rather than two. `ended` refuses because a finished session must not
 * be republishable by somebody who captured the RTMP URL after the creator
 * moved on.
 */
const USER_PUBLISHABLE_STATUS = "live";

/**
 * The one `user_stream.status` a READ is allowed against — I3, final
 * whole-branch review. Written as its own constant rather than reusing
 * `USER_PUBLISHABLE_STATUS` above even though the two strings are equal
 * today: they answer different questions ("may somebody send bytes to this
 * path?" and "may somebody receive them?"), and a future third status —
 * `paused`, say, or a `replay` a recording is served from — would move one
 * without moving the other. One name per decision is what keeps that edit
 * from silently being both.
 */
const USER_READABLE_STATUS = "live";

/**
 * The one `user_stream.visibility` that opens a read to everybody. Written
 * here as a literal beside `MEMBERS_ONLY` rather than imported from anywhere,
 * because the decision below is an ALLOW-LIST: see
 * `authoriseUserStreamRead`'s docstring for why this file must not be able to
 * infer "not gated" from "not the gated value".
 */
const PUBLIC_VISIBILITY = "public";

/**
 * Every top-level path segment MediaMTX's stream paths are ever built under
 * in this codebase, mapped to the world it names. `u` is Phase 7's namespace
 * for a person's own `user_stream`, and since Phase 8 it is the only one.
 *
 * ONE ENTRY, AND STILL A MAP — Phase 8, Task 6, and the single decision in
 * this file most worth defending. The community `live` namespace came out
 * with the `event` world it named, which leaves a lookup table holding
 * exactly one key. The obvious simplification is to drop the table and treat
 * any `<something>/<key>` path as a user stream. DO NOT. `parseStreamPath`
 * below records the real defect that shape caused: a parser that took the
 * last segment regardless of what came before it authorised a publish to
 * `foo/bar/<key>` exactly as it authorised `live/<key>`, for any real key —
 * a path this codebase's own adapters never construct. A map that can MISS is
 * the entire mechanism, and it misses just as usefully with one key as with
 * two. `authorise-stream.test.ts`'s four `parseStreamPath` refusal cases were
 * verified by mutation against precisely this collapse.
 *
 * NOT IN STEP WITH THE CONSTRUCTION SIDE, and said here rather than left to
 * be found. `StreamNamespace` (`streaming-provider.port.ts`) still declares
 * `"live" | "u"`, because Task 6 owned the authorisation seam and not the
 * adapters. Nothing in `src/` passes `"live"` — `StartUserStream` is the only
 * `createSession` caller and it passes `"u"` — but the TYPE would still let
 * somebody build a `live/<key>` URL that this map refuses. Fails closed (the
 * publish is refused, so nobody goes live on a bad URL) and is flagged in
 * that union's own docstring. Adding a SECOND namespace later means adding
 * ONE entry here and one there; see that docstring for why the two key sets
 * are written out twice rather than derived.
 */
const NAMESPACES: ReadonlyMap<string, "user"> = new Map([["u", "user"]]);

/**
 * Parses `path` into the world it names and the key inside it, requiring
 * EXACTLY `<namespace>/<key>` for a namespace listed in `NAMESPACES` above
 * (a leading/trailing slash tolerated, an empty key, extra segments, or an
 * unlisted namespace not) — `null` otherwise.
 *
 * THIS IS THE ONE PARSER. It used to be named `streamKeyFromPath`, return a
 * bare string, and recognise only `live/`; Phase 7 widened it to cover both
 * worlds rather than growing a second, sibling parser for `u/`, and Phase 8
 * narrowed it back to one world by REMOVING an entry from the map rather than
 * by relaxing the lookup. A second parser — or a looser one — would re-open,
 * wearing a new prefix, the exact defect this one was hardened against:
 * REQUIRING the namespace, rather than just taking the last segment
 * regardless of what came before it, is load-bearing and not merely tidy.
 * Without it, `foo/bar/<key>` once authorised a publish exactly as
 * `live/<key>` did, for any real key — an attacker (or a misconfigured
 * MediaMTX) could publish to a path our own adapter never constructs, and the
 * lifecycle hook would then fire with `MTX_PATH=foo/bar/<key>` against a
 * stream nothing is actually publishing to. An unknown or wrongly-shaped path
 * refuses outright (`null`, which `AuthoriseStream.execute` treats as an
 * immediate refusal and `POST /webhooks/mediamtx/lifecycle` as a 404),
 * matching only the shapes this codebase's own adapters are ever meant to
 * produce.
 *
 * THE RETURN TYPE KEEPS ITS `world` FIELD even though only one value can
 * ever appear in it. Callers discriminate on it as an ALLOW-LIST
 * (`parsed.world !== "user"` refuses in the lifecycle route), so the field is
 * what makes adding a namespace here fail closed at every call site until
 * somebody deliberately teaches each one what to do with it.
 *
 * EXPORTED for `routes/mediamtx-webhooks.ts`: MediaMTX hands
 * `runOnOnline`/`runOnOffline` the SAME `$MTX_PATH` value — confirmed
 * against mediamtx.org's hooks documentation ("MTX_PATH: path name"),
 * which is the runtime path a client actually published to, i.e. `u/<key>`
 * under this codebase's catch-all path config, not the bare key. Re-parsing
 * it there rather than duplicating the segment check a second time is what
 * keeps "what path shape is legitimate, and which world does it name"
 * answered in exactly one place.
 */
export function parseStreamPath(path: string): { world: "user"; key: string } | null {
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
 * live streaming. MediaMTX's `authHTTPAddress` mechanism (see
 * `routes/mediamtx-webhooks.ts` for the exact wire contract) asks this,
 * through the route, to authorise EVERY publish and EVERY read: there is no
 * other gate. A stream key is not a secret the moment MediaMTX's public
 * RTMP port is up, and a watch token is not a secret to the person it names
 * — this class is what stands between either of those and someone who
 * should not have them.
 *
 * ONE WORLD — Phase 8, Task 6. This class used to authorise two: the
 * community `event` world under `live/<streamKey>`, resolved through
 * `EventRepositoryPort` and gated by a six-hour `watch-token.ts` token plus a
 * live subscription re-check, and the user world under `u/<streamKey>`.
 * Retiring Telegram deleted the community world outright — `event`'s
 * repository, its port, its watch token and the `authoriseReadByEventId`
 * entry point nginx's `^~ /live/` location called all went with it. What
 * survived unchanged is the SHAPE of every decision below; nothing was
 * loosened to make one world's rules cover what two used to.
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
 * TWO DECISIONS, both reached through `parseStreamPath`'s allow-list:
 *
 *   - `publish`: allowed only if `u/<key>` resolves, via
 *     `UserStreamRepositoryPort.findByStreamKey`, to a row whose `status` is
 *     `live`. `ended` refuses: a finished session must not be republishable,
 *     because nothing else stops someone who captured the RTMP URL from
 *     restarting it after the creator has moved on. See
 *     `authoriseUserPublish`.
 *   - `read`: `authoriseUserStreamRead`, an ALLOW-LIST over `visibility` — a
 *     `public` row needs no token at all, a `members` row needs a valid
 *     `user-watch-token.ts` token NAMING THAT ROW, and any other visibility
 *     value is refused. It is the SAME function nginx's by-id entry point
 *     calls, deliberately: one decision, two callers, because two copies of a
 *     paywall drift and the drift is silent.
 *
 * A SECOND ENTRY POINT — `authoriseUserReadByStreamId` — exists for exactly
 * one caller: nginx's `auth_request`, fronting the `^~ /u/` location. It
 * resolves `user_stream` by its opaque row id (never by its stream key — see
 * its own docstring) and returns that row's key on success so nginx can
 * rewrite onto MediaMTX's internal `u/<streamKey>` path. The reason it
 * resolves by ID is the one the community world learned the hard way: the
 * member-facing HLS URL and the publish credential must not be the same
 * string, or the URL handed to every viewer IS the credential to broadcast.
 *
 * NO LIVE MEMBERSHIP RE-CHECK on a read, and this is a deliberate bargain
 * rather than an omission. The community world re-read its subscription on
 * every segment because its token lived six hours; this one lives ten minutes
 * and the player re-mints silently, so the entitlement check lives at the
 * MINT endpoint (`POST /streams/:id/watch-token`) where the viewer's session
 * actually is. Design spec §5; `authoriseUserStreamRead`'s own docstring
 * carries the full reasoning.
 *
 * EVERY refusal — an unrecognised namespace, no such stream, an ended stream,
 * a bad signature, an expired token, a token naming another stream, an
 * unrecognised visibility — returns the same `{ allowed: false }`. Nothing
 * here, or in the route that calls this, distinguishes one refusal reason
 * from another: doing so would let a prober learn whether a stream key
 * exists, or whether a given stream id is real, from the SHAPE of a
 * rejection.
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
 * one endpoint standing between a gated stream and the public internet.
 */
export class AuthoriseStream {
  constructor(
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

    // `parsed.world` can only be `"user"` — but the guard above is what makes
    // that true, and it is an ALLOW-LIST (see `parseStreamPath`). A path under
    // any other namespace never reaches this line at all.
    //
    // This method is what MediaMTX's OWN `authHTTPAddress` hook calls, with
    // the path a client published to or read from — `u/<streamKey>` — so BOTH
    // actions resolve through `UserStreamRepositoryPort.findByStreamKey`.
    if (input.action === "publish") {
      return this.authoriseUserPublish(parsed.key);
    }
    if (input.action === "read") {
      return this.authoriseUserReadByStreamKey(parsed.key, input.query, input.now);
    }
    return { allowed: false };
  }

  /**
   * The USER world's publish — the ~4 lines that let anybody go live at all.
   *
   * `findByStreamKey` is the ONE sanctioned unscoped lookup on this port:
   * MediaMTX knows only the key baked into the RTMP/WHIP path and there is no
   * authenticated creator on this call. Only a `live` row publishes
   * (`USER_PUBLISHABLE_STATUS`); an `ended` row refuses.
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
   * nginx's `auth_request` re-authorisation, by STREAM ID.
   *
   * WHY THIS EXISTS AT ALL. MediaMTX's own `/auth` hook authorises a read
   * ONCE, when the HLS session opens; it is never asked again. nginx's
   * `auth_request` fires on EVERY proxied HTTP request instead, which is what
   * makes a stream the creator ended stop serving segments on the next one
   * rather than whenever the viewer's player happens to reconnect.
   *
   * WHY BY ID. `GET /streams` is PUBLIC — signed in or not — and publishes
   * `/u/<streamId>/index.m3u8` (`userStreamPlaybackPath`), never a URL
   * carrying the stream key, because a stream key authorises a PUBLISH. That
   * is the defect the retired community world shipped and then fixed: its
   * member-facing HLS URL was built from the same `streamKey` that authorised
   * a publish, so the URL handed to every paying member was, verbatim, the
   * broadcast credential. This method is the read side meeting that decision:
   * it resolves the PUBLIC id via `findById` and, only on success, hands the
   * caller the stream key so nginx can rewrite onto MediaMTX's unchanged
   * internal `u/<streamKey>` path (`auth_request_set $mtx_ukey`, then
   * `proxy_pass .../u/$mtx_ukey$mtx_rest`). MediaMTX was never taught about
   * stream ids and does not need to be. The key crosses exactly one boundary
   * — an HTTP response header nginx reads over loopback, captured by
   * `auth_request_set` and never forwarded to the original client — and is
   * never present in the literal bodies this route sends.
   *
   * A PUBLISH KEY IS NOT A SECOND WAY IN. `findById` looks in the `id`
   * column; nothing here ever consults `findByStreamKey`, and nothing here
   * ever falls back to it when the id misses. A read path that accepted
   * either identifier would quietly undo the entire reason ids are what get
   * published. `authorise-stream.test.ts` pins this with a real 32-hex key.
   *
   * THE GATE ITSELF IS NOT HERE. It is `authoriseUserStreamRead` below, which
   * this method and `execute()`'s own by-key branch BOTH call — one decision,
   * two callers, and not a stylistic ruling: two copies of a paywall drift,
   * and the drift is silent, because the copy that loosened still has its own
   * passing tests. `query` carries the watch token (the route forwards
   * `X-Watch-Token` as `token=...`) and `now` is the instant the caller read
   * once.
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
   * THE READ DECISION — the whole paywall, in one place, called by both entry
   * points: `authoriseUserReadByStreamId` (nginx's `auth_request`, resolving
   * by the opaque row id a browser is allowed to know) and
   * `authoriseUserReadByStreamKey` (MediaMTX's own `authHTTPAddress` hook,
   * resolving by the key baked into the path). By the time either calls this,
   * it has the row in hand and nothing past that point differs.
   *
   * DENY BY DEFAULT. The shape here is an ALLOW-LIST over `visibility` — a
   * `public` row is authorised, a `members` row is authorised only by a valid
   * token naming it, and ANY OTHER VALUE IS REFUSED. It is deliberately NOT
   * the `visibility !== MEMBERS_ONLY -> allow` test an earlier version of
   * this method used. `user_stream.visibility` is a widened `varchar`, so a
   * typo, a migration, or a future tier name would read as "not gated" and
   * open the stream to the public internet; `toStreamView`'s listing gate can
   * afford that reading because the write path is the authority on what may
   * be stored there and the worst case is a lock shown where none was meant.
   * Here the worst case is the paywall, and an allow-by-default paywall is
   * one typo from open.
   *
   * NO LIVE MEMBERSHIP RE-CHECK. This token lives TEN MINUTES and the player
   * re-mints silently while watching, so a membership that lapses
   * mid-broadcast stops access at the next re-mint — `MintUserWatchToken` is
   * what asks `IsMemberOf`, and it needs the viewer's own session to answer,
   * which is exactly why a forwarded token cannot be renewed. Design spec §5
   * states that bargain and chooses it; this method is not the place to
   * re-litigate it, and adding a membership query here would put one on every
   * HLS segment request.
   *
   * **AN ENDED STREAM REFUSES EVERY READ — I3, final whole-branch review.**
   * This method used to have no status check, on the reasoning that an
   * `ended` stream has nothing for MediaMTX to serve anyway. That reasoning
   * was wrong about the thing this world added: an explicit **End** button in
   * front of a person. `EndOwnUserStream` marks the row `ended` and NOTHING
   * kicks the publisher — MediaMTX authorises a publish once, at connect, and
   * is not polled — so an already-connected OBS session keeps sending, and
   * every segment it produced was still being authorised here. A member
   * holding the stream id kept re-minting (ten minutes at a time, silently,
   * from the player) and kept watching a broadcast the creator believed was
   * over.
   *
   * The check is FIRST, before the visibility allow-list, because it holds
   * regardless of who is asking or what they carry: a public ended stream is
   * refused with no token exactly as a gated one is refused with a perfectly
   * valid one. Deny-by-default again — `!== live`, never `!== ended`, so an
   * unrecognised status refuses rather than reading as "not finished".
   *
   * **WHAT THIS DOES NOT FIX, stated rather than implied:** the publisher.
   * Kicking a connected session needs MediaMTX's own API and is out of scope
   * here. Readers being cut is the part this codebase owns, and they are cut
   * on the very next segment request rather than up to ten minutes later.
   *
   * SYNCHRONOUS on purpose — it touches no repository. Everything it needs is
   * the row the caller already fetched, plus the token in the query.
   */
  private authoriseUserStreamRead(
    stream: UserStreamRow,
    query: string,
    now: number
  ): { allowed: boolean } {
    if (stream.status !== USER_READABLE_STATUS) {
      // I3. Nothing a reader can carry rescues a stream the creator ended —
      // see this method's own docstring.
      return { allowed: false };
    }
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
}
