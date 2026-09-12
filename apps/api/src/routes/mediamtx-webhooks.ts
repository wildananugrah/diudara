import { Hono } from "hono";
import { NotFoundError, UnauthorizedError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/webhooks/webhook-token";
import { parseStreamPath } from "../application/use-cases/authorise-stream";
import { anonymousViewerIdentity } from "../domain/anonymous-viewer-identity";
import type { Dependencies } from "../bootstrap";

/**
 * `$remote_addr`, forwarded by `live-hls.conf.template`'s internal
 * `/auth-request` location — see `RecordStreamViewerHeartbeat`'s own spec
 * (`docs/superpowers/specs/2026-09-12-live-viewer-counts-design.md`) for why
 * this is the one piece of this feature not yet verified against a real
 * MediaMTX/nginx box. Absent (not yet deployed, or a non-nginx caller)
 * degrades to a shared "unknown" identity rather than erroring — see
 * `anonymousViewerIdentity`.
 */
const CLIENT_IP_HEADER = "X-Client-IP";

/**
 * The header a caller MAY carry the shared secret in, mirroring
 * `X-CALLBACK-TOKEN` (Xendit) — and the SAME name the lifecycle hooks
 * (`runOnOnline`/`runOnOffline`) use, since those ARE shell commands this
 * codebase writes and so genuinely CAN send a header.
 *
 * This is now one of TWO accepted mechanisms — see the `secret` query
 * parameter this route also checks, and the docstring on
 * `mediamtxWebhookRoutes` below for why both exist. Kept, rather than
 * replaced by the query parameter: it is real (Task 5's hooks use it) and
 * removing it would silently break the code Task 5 already wrote against
 * this name.
 */
const MEDIAMTX_SECRET_HEADER = "X-Mediamtx-Secret";

/**
 * The query parameter MediaMTX's `authHTTPAddress` POST can be made to
 * carry the shared secret in. THIS ONE, not the header above, is the
 * mechanism a real MediaMTX instance actually reaches this route through
 * — see `mediamtxWebhookRoutes`'s docstring for the full reasoning.
 *
 * SECURITY NOTE FOR TASK 6 (`infra/mediamtx.yml`): a query-string secret
 * is not confidential the way a header is — it lands in this process's
 * HTTP access logs (if any are ever added) and sits in plaintext inside
 * `authHTTPAddress`'s own config value in `mediamtx.yml` on disk. Neither
 * of those is new exposure THIS route creates (the secret already lives
 * in `mediamtx.yml` as plaintext either way, and this app does not log
 * request URLs today), but Task 6 MUST NOT put this route on the public
 * nginx surface — it belongs on the same private path MediaMTX itself
 * reaches the API over (`host.docker.internal`), never proxied to the
 * internet, exactly like the HLS port it authorises reads for.
 */
const MEDIAMTX_SECRET_QUERY_PARAM = "secret";

/**
 * The fixed body every REFUSED decision returns — not just the same fields,
 * the same literal value every time. `AuthoriseStream` already collapses
 * "no such stream", "a stream that is not live", "an unrecognised namespace",
 * "bad signature", "expired token", "a token naming a DIFFERENT stream" and
 * "not a member" into one `{ allowed: false }`; this constant is what stops
 * the ROUTE from reintroducing a distinction the use-case deliberately erased
 * (e.g. by some future edit adding a message that names which check failed).
 * The list above shrank with retire-telegram Task 6 — the community `event`
 * refusals it used to name went with the world that produced them — and the
 * rule did not: whatever the reasons ARE, the wire never tells them apart.
 */
const REFUSED_BODY = { ok: false } as const;
const ALLOWED_BODY = { ok: true } as const;

/**
 * The literal body `/lifecycle` answers with once the shared secret has checked
 * out and the stream key named a namespace this API still serves — success OR a
 * no-op both read as "acknowledged". It is a fire-and-forget notification from a
 * shell `curl` command, not a decision MediaMTX branches on. See the route's own
 * docstring for why a malformed body and an unknown `u/<key>` still answer 200
 * while a key naming no served namespace does NOT.
 */
const ACKNOWLEDGED_BODY = { ok: true } as const;

/**
 * What `/lifecycle` says when `body.streamKey` names no namespace this API
 * serves — a `live/<key>` from the retired community world, or anything
 * `parseStreamPath` cannot read at all.
 *
 * ENGLISH, not Indonesian, and that is the rule rather than an oversight: this
 * message reaches a `curl` command's stderr and an operator reading logs, never
 * a member's screen, and `NotFoundError` messages are English throughout this
 * codebase.
 *
 * It names the SHAPE it wanted (`u/<key>`) and not the shape it got. There is no
 * secrecy argument for that here the way there is for `/auth`'s `REFUSED_BODY`
 * — this route is secret-gated and private, and a caller that reached this line
 * already knows what it sent. It is simply the half that is actionable: whoever
 * is reading this needs to know what `$MTX_PATH` should have looked like.
 */
const LIFECYCLE_UNKNOWN_PATH_MESSAGE =
  "lifecycle streamKey does not name a stream this server handles: expected a u/<key> path";

/** The two `hook` values `POST /lifecycle`'s body may legitimately carry. */
const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set(["online", "offline"]);

/**
 * `POST /webhooks/mediamtx/auth` — MediaMTX's `authHTTPAddress` target, the
 * single gate every publish and every read passes through (design spec §5).
 *
 * PAYLOAD SHAPE verified against mediamtx.org/docs/features/authentication
 * (see `AuthoriseStream`'s own docstring for the full citation and the
 * exact field list): MediaMTX POSTs
 * `{ user, password, token, ip, action, path, protocol, id, query,
 * userAgent }`. This route reads only `action`, `path` and `query` — the
 * three `AuthoriseStream.execute` needs — and ignores the rest; `token` in
 * particular is MediaMTX's OWN auth-token field (populated from RTMP/RTSP
 * username/password style credentials) and is unrelated to the watch token
 * this codebase signs, which travels in `query` instead (see
 * `AuthoriseStream`).
 *
 * The secret check happens FIRST, before the body is even parsed —
 * identical ordering to `routes/webhooks.ts`'s Xendit and Telegram routes,
 * and for the identical reason: an unauthenticated caller must not be able
 * to reach the parser, `AuthoriseStream`, or the database. `verifyCallbackToken`
 * is REUSED rather than re-implemented — see that module's own docstring for
 * why a second constant-time comparison must not be hand-rolled.
 *
 * TWO WAYS TO PRESENT THE SECRET, checked at the same guard: the
 * `X-Mediamtx-Secret` header, and a `secret` query parameter. This is not
 * redundancy for its own sake — mediamtx.org's authentication docs
 * enumerate `authHTTPAddress`'s ENTIRE configuration surface (`authMethod`,
 * `authHTTPAddress`, `authHTTPExclude`, `authHTTPFingerprint`,
 * `authInternalUsers`, the `authJWT*` keys) and none of it lets MediaMTX
 * attach a custom header to the POST this route authenticates. A real
 * MediaMTX can only reach this endpoint at all via the query parameter
 * (baked into `authHTTPAddress`'s own URL, e.g.
 * `.../webhooks/mediamtx/auth?secret=...`, in Task 6's `infra/mediamtx.yml`)
 * — checking the header ALONE, as an earlier version of this route did,
 * would 401 every single publish and every single read in production, since
 * nothing MediaMTX sends could ever satisfy it. The header path stays for
 * Task 5's lifecycle hooks, which ARE shell `curl` commands and genuinely
 * can send one. The query parameter is read via `c.req.query`, which is
 * THIS request's own URL — completely independent of `query` inside the
 * JSON BODY below, which is the query string of the publish/read request
 * MediaMTX is asking about. Do not conflate the two.
 *
 * Every response after the secret check is one of exactly two literal
 * bodies (`ALLOWED_BODY` / `REFUSED_BODY`) — MediaMTX only inspects the
 * STATUS CODE (2xx vs. not) per its own docs, but the body is deliberately
 * uninformative anyway: nothing here may let a caller distinguish "no such
 * event" from "not entitled" from "expired token".
 */
export function mediamtxWebhookRoutes(
  deps: Pick<
    Dependencies,
    "authoriseStream" | "mediamtxWebhookSecret" | "endUserStream" | "recordStreamViewerHeartbeat"
  >
) {
  const app = new Hono();

  app.post("/auth", async (c) => {
    // `c.req.query(...)` here is THIS request's own URL query string — the
    // one `authHTTPAddress`'s own address can be configured with — and has
    // nothing to do with the `query` field inside the JSON body below,
    // which describes the publish/read MediaMTX is asking about.
    const secret = c.req.query(MEDIAMTX_SECRET_QUERY_PARAM) ?? c.req.header(MEDIAMTX_SECRET_HEADER);
    if (!verifyCallbackToken(secret, deps.mediamtxWebhookSecret)) {
      throw new UnauthorizedError("invalid mediamtx webhook secret");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(REFUSED_BODY, 403);
    }

    if (!isAuthRequestBody(body)) {
      return c.json(REFUSED_BODY, 403);
    }

    // Streaming not configured on this box (see `selectStreamingProvider`
    // in bootstrap.ts) — nothing can be authorised. Unreachable in practice
    // once the secret check above holds, because `mediamtxWebhookSecret`
    // and `authoriseStream` are undefined together; kept for type-safety
    // and so this route never assumes the pairing rather than checking it.
    if (!deps.authoriseStream) {
      return c.json(REFUSED_BODY, 403);
    }

    const { allowed } = await deps.authoriseStream.execute({
      action: body.action,
      path: body.path,
      query: typeof body.query === "string" ? body.query : "",
      now: Date.now(),
    });

    return allowed ? c.json(ALLOWED_BODY, 200) : c.json(REFUSED_BODY, 403);
  });

  /**
   * `GET /webhooks/mediamtx/auth-request` — NOT called by MediaMTX. Called by
   * nginx's `auth_request` directive, once per HTTP request nginx proxies to
   * MediaMTX's HLS port, closing the gap the rest of this docstring explains.
   *
   * THE PROBLEM THIS EXISTS TO FIX: MediaMTX's own `authHTTPAddress`
   * mechanism (the `/auth` route above) authorises a READ only ONCE per
   * viewer — confirmed empirically (see task-9-report.md of the live-streaming
   * phase): the FIRST request for a stream mints an internal, MediaMTX-issued
   * session identifier (returned as `hlsSession`/`cookieCheck` cookies for
   * cookie-capable clients, AND rewritten directly into every sub-manifest
   * URI as a `?session=` query parameter for clients that never send
   * cookies at all — which is what `hls.js`'s default, credential-less
   * cross-origin XHR loader is, confirmed with a real browser). EVERY
   * subsequent request carrying that session identifier is let through
   * WITHOUT calling `/auth` again, so whatever `AuthoriseStream` would have
   * refused on the second request is never asked. For an open tab that is the
   * rest of the broadcast: a stream the creator ENDED keeps serving segments
   * (`authoriseUserStreamRead`'s status check never re-runs) until the viewer
   * closes the tab or MediaMTX's own session times out.
   *
   * THE FIX: put nginx in front of MediaMTX's (already non-public) HLS
   * port, with `auth_request` pointing here for every proxied request —
   * see CONTRIBUTING.md's "Live streaming (MediaMTX)" section and
   * `infra/nginx/live-hls.conf.template` for the actual config. nginx's
   * `auth_request` has NO caching of its own: every single HTTP request
   * (master playlist, every sub-playlist reload, every init segment, every
   * media segment, every LL-HLS part) triggers a fresh subrequest here,
   * which reaches the SAME `authoriseUserStreamRead` decision the `/auth`
   * route reaches — the same live row, re-read every time, regardless of
   * whatever MediaMTX itself would have cached. This does not change
   * `AuthoriseStream` at all; it changes how often it gets asked.
   *
   * WHY A SEPARATE ROUTE, NOT A REUSED `/auth`: nginx's `auth_request`
   * subrequest has no built-in way to construct MediaMTX's POST-JSON-body
   * contract (it mirrors the original request, normally a bodyless GET) —
   * so this route accepts the inputs
   * `AuthoriseStream.authoriseUserReadByStreamId` actually needs as HEADERS
   * instead: `X-Mtx-Stream-Id` (built by nginx from the PUBLIC request URL's
   * captured stream id — see the nginx config) and `X-Watch-Token` (the SAME
   * watch token `hls.js`'s `xhrSetup` re-attaches to every request).
   * `action` is implicitly `"read"`: nginx only ever proxies HLS reads here —
   * RTMP publish (port 1935) is never proxied through nginx at all (see
   * CONTRIBUTING.md's port-asymmetry note), so this route has no publish case
   * to handle.
   *
   * ONE WORLD, ONE ID HEADER — Phase 8, Task 6. This route used to serve two,
   * told apart by WHICH id header arrived: `X-Mtx-Event-Id` named a community
   * `event` and resolved through `AuthoriseStream.authoriseReadByEventId`,
   * `X-Mtx-Stream-Id` names a `user_stream` and resolves through
   * `authoriseUserReadByStreamId`. Retiring Telegram deleted the community
   * world and that entry point with it, so `X-Mtx-Event-Id` is no longer read
   * here at all.
   *
   * WHAT THAT MEANS FOR A STALE `^~ /live/` LOCATION, stated rather than left
   * to be discovered: an nginx deployment still fronting the retired
   * community path sends an event id and no stream id, and this route
   * REFUSES it — `presentId` finds no stream id, and there is no fallback
   * that could read the event id instead. Fail-closed, and the same shape the
   * `/lifecycle` route's 404 has: a namespace this API no longer serves gets
   * an answer that differs from a healthy one, rather than silently resolving
   * as the surviving world. Nothing here ever assumes "the only world left"
   * from "an id of some kind arrived".
   *
   * WHY BY ID AND NOT BY STREAM KEY. `GET /streams` publishes
   * `/u/<streamId>/index.m3u8`, never a URL carrying the stream key, because
   * a stream key authorises a PUBLISH — the retired community world shipped
   * exactly that defect (its member-facing HLS URL was built from the same
   * `streamKey` that authorised a publish, so the URL handed to every paying
   * member WAS the broadcast credential) and then fixed it by resolving on an
   * opaque row id instead. So this route resolves by that id, and on success
   * answers with an `X-Stream-Key` HEADER (never a body field) so nginx can
   * rewrite the request onto MediaMTX's still-`u/<streamKey>`-shaped internal
   * path before proxying — see the nginx config's `auth_request_set` for the
   * other half of this. The key crosses this one response header, read only
   * by nginx over `127.0.0.1`/loopback, and is never in a body a browser
   * could ever see.
   *
   * HEADERS, NOT QUERY PARAMETERS — found running this for real, not from
   * documentation. The obvious design reuses `?streamId=...&token=...` on
   * this route's own URL, exactly like `/auth`'s `secret` query parameter.
   * It does not work: nginx's `auth_request` subrequest does NOT inherit
   * `$args`/`$arg_*` from the request it is authorising — confirmed with a
   * probe upstream that echoed back what the subrequest actually received.
   * `$arg_token`, read directly inside the internal `auth_request` location,
   * came back EMPTY every time, while `$request_uri` and a location's own
   * regex-captured variable came back correct. The working pattern (see
   * `infra/nginx/live-hls.conf.template`): capture the token into a plain
   * nginx variable with `set $watch_token $arg_token;` in the OUTER
   * location, BEFORE `auth_request` fires — a `set` variable persists into
   * the subrequest the same way a regex capture does, even though
   * `$arg_token` itself does not — then forward that variable as a header.
   * See task-9-report.md for the full trace.
   *
   * SECRET, VIA HEADER: unlike `authHTTPAddress`, nginx has no limitation
   * on custom headers (`proxy_set_header` in the internal location), so
   * there is no reason to also accept a query parameter here the way
   * `/auth` and `/lifecycle` must for MediaMTX's sake.
   *
   * nginx's `auth_request` module only inspects the STATUS CODE (2xx =
   * allow, 401/403 = deny) — same rule as MediaMTX's own `authHTTPAddress`
   * — so this reuses `ALLOWED_BODY`/`REFUSED_BODY` for consistency, though
   * nginx never reads either body. The `X-Stream-Key` response header is
   * ONLY ever consumed by nginx's `auth_request_set` — nginx does not
   * forward an `auth_request` subrequest's headers to the client on its own,
   * and this app adds no directive that would.
   *
   * MUST NOT be reachable from the public internet, same as `/auth` and
   * `/lifecycle` above: it is called ONLY by nginx's internal `auth_request`
   * subrequest (see the `internal;` directive in the nginx config), over the
   * same private `host.docker.internal` path MediaMTX itself reaches this
   * API over — never proxied to the public origin.
   */
  app.get("/auth-request", async (c) => {
    const secret = c.req.header(MEDIAMTX_SECRET_HEADER);
    if (!verifyCallbackToken(secret, deps.mediamtxWebhookSecret)) {
      throw new UnauthorizedError("invalid mediamtx webhook secret");
    }

    if (!deps.authoriseStream) {
      return c.json(REFUSED_BODY, 403);
    }

    const streamId = presentId(c.req.header("X-Mtx-Stream-Id"));
    const token = c.req.header("X-Watch-Token");
    const query = token ? `token=${encodeURIComponent(token)}` : "";

    // NO STREAM ID, NO RESOLUTION. `presentId` above is what keeps this rule
    // from depending on nginx: an id header that arrived empty, or holding
    // nothing but whitespace, counts as ABSENT — read its docstring before
    // changing either. A request from a stale `^~ /live/` location carries an
    // event id and lands here too; it is refused by this same line, because
    // nothing in this route reads that header any more.
    if (streamId === undefined) {
      return c.json(REFUSED_BODY, 403);
    }

    const result = await deps.authoriseStream.authoriseUserReadByStreamId({
      streamId,
      query,
      now: Date.now(),
    });

    if (!result.allowed) {
      // A refusal is not a viewer — nothing is recorded. See
      // `RecordStreamViewerHeartbeat`'s own docstring.
      return c.json(REFUSED_BODY, 403);
    }

    // Awaited, not fire-and-forget: this endpoint already pays one database
    // read to authorise the request, and one more small upsert is a modest
    // addition next to it — worth it for a write whose success or failure
    // this route can actually observe and reason about, rather than one a
    // caller (a test, an operator) has no way to wait for. A failed
    // heartbeat must never turn an authorised read into a 500, so it is
    // swallowed here — an approximate viewer count losing one data point is
    // nothing compared to every HLS segment on the platform starting to fail.
    try {
      await deps.recordStreamViewerHeartbeat.execute({
        streamId,
        identity:
          result.viewerId ??
          anonymousViewerIdentity(
            c.req.header(CLIENT_IP_HEADER) ?? "unknown",
            c.req.header("User-Agent") ?? ""
          ),
        now: new Date(),
      });
    } catch {
      // Swallowed — see the comment above.
    }

    // Read only by nginx's `auth_request_set` — never forwarded to the
    // client. See this route's own docstring for why that is safe.
    c.header("X-Stream-Key", result.streamKey);
    return c.json(ALLOWED_BODY, 200);
  });

  /**
   * `POST /webhooks/mediamtx/lifecycle` — Task 5's `runOnOnline`/`runOnOffline`
   * hooks, in `infra/mediamtx.yml`'s planned shape:
   * `curl -X POST .../lifecycle -H "X-Mediamtx-Secret: $MEDIAMTX_WEBHOOK_SECRET"
   * -d '{"hook":"online","streamKey":"$MTX_PATH"}'`. These hooks are shell
   * commands, not a mechanism with `authHTTPAddress`'s configuration surface, so
   * (unlike `/auth`) they CAN and DO send the secret as a header — but this route
   * still checks the query parameter first, for the one reason that matters: the
   * secret-verification CODE must be the exact same call as `/auth`'s, not a
   * second hand-rolled comparison that could silently diverge.
   *
   * THE SECRET CHECK IS STILL THE FIRST STATEMENT, before the body is parsed and
   * before either lifecycle class is ever reached — identical ordering to
   * `/auth`, for the identical reason.
   *
   * ONE WORLD, TOLD APART BY `parseStreamPath` — Phase 8, Task 3. This route
   * used to serve TWO: `HandleStreamLifecycle` for the community `live/<key>`
   * namespace and `EndUserStream` for `u/<key>`, dispatched between by parsing
   * `body.streamKey` ONCE, here, with the SAME parser `authorise-stream.ts`
   * exports ("the single parser", per that function's own docstring). Retiring
   * Telegram deleted the community world, so `HandleStreamLifecycle` is gone and
   * `u/<key>` is the only namespace with anything left to handle. The parse
   * stays exactly where it was — the dispatch became a GUARD rather than a fork,
   * and the parser is still the one thing that decides. `EndUserStream` gets the
   * BARE key (`parsed.key`), never the raw `u/<key>` path — see its own
   * docstring.
   *
   * A KEY THAT DOES NOT NAME A USER STREAM PATH IS A 404 — the one behaviour
   * this task changed, and the reason it changed. `live/<key>` and an
   * unparseable key BOTH used to fall through to `HandleStreamLifecycle`, which
   * logged an "ignoring" line and no-op'd, and this route answered 200. With
   * that class deleted there is nothing to hand either one to, and the choice
   * was between acknowledging a path nothing can serve and refusing it.
   *
   * It refuses, because of WHO CALLS THIS ROUTE: MediaMTX and
   * `infra/mediamtx.yml`'s `runOnOnline`/`runOnOffline` `curl` commands — never
   * a person. A wrong `$MTX_PATH`, a stale `mediamtx.yml` still shaped for the
   * community namespace, a path template nobody updated: every one of those has
   * exactly one way to become visible, and it is the hook failing. A 200 for a
   * namespace that no longer exists is byte-for-byte the response a healthy
   * broadcast gets, so the deployment would look fine while every lifecycle
   * event silently went nowhere and every user stream stayed `live` forever.
   * That is the failure the deleted class's own log line existed to warn about;
   * the status code now carries it instead, where something other than a human
   * reading stderr can see it.
   *
   * 404 AND NEVER 5xx. The rule the previous version of this docstring gave for
   * never failing survives intact, and it was always about RETRIES: a 5xx makes
   * MediaMTX (or whatever wraps the curl call) retry forever for a condition
   * retrying can never fix. A 404 is permanent and says so — it is not a request
   * to try again, it is "this API does not serve that path". Nothing here
   * retries it.
   *
   * STILL 200 FOR A MALFORMED BODY, and for a `hook` value outside
   * `LIFECYCLE_HOOKS`, and for an `u/<key>` stream key matching no live row: all
   * three are unchanged. Those say something about ONE garbled or late request,
   * not about the deployment pointing at a namespace this API no longer has —
   * and the last of them is `EndUserStream`'s documented, ordinary no-op (an
   * `offline` can legitimately arrive twice). Only the namespace decision moved.
   *
   * A genuine database error is NOT caught here and is allowed to become the
   * process's normal 500, exactly as `/auth` lets `AuthoriseStream.execute`
   * propagate — the two failure modes are different (one is "this input teaches
   * us nothing new", the other is "the database is unreachable") and only the
   * first is swallowed to 200.
   */
  app.post("/lifecycle", async (c) => {
    const secret = c.req.query(MEDIAMTX_SECRET_QUERY_PARAM) ?? c.req.header(MEDIAMTX_SECRET_HEADER);
    if (!verifyCallbackToken(secret, deps.mediamtxWebhookSecret)) {
      throw new UnauthorizedError("invalid mediamtx webhook secret");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(ACKNOWLEDGED_BODY, 200);
    }

    if (!isLifecycleRequestBody(body)) {
      return c.json(ACKNOWLEDGED_BODY, 200);
    }

    // Told apart by NAMESPACE, never by guessing — see this route's own
    // docstring. `parsed === null` (unparseable) and `parsed.world ===
    // "community"` used to fall through to `handleStreamLifecycle`; that class
    // is gone, so both are now refused here instead of acknowledged. The guard
    // is `world !== "user"` rather than `world === "community"`: it stays an
    // ALLOW-LIST, exactly like `AuthoriseStream`'s own, so a namespace added to
    // `parseStreamPath` later refuses here until somebody deliberately teaches
    // this route what to do with it, instead of falling into `EndUserStream`.
    const parsed = parseStreamPath(body.streamKey);

    if (parsed === null || parsed.world !== "user") {
      throw new NotFoundError(LIFECYCLE_UNKNOWN_PATH_MESSAGE);
    }

    // Streaming not configured on this box — nothing to react to. Unreachable
    // in practice once the secret check above holds (same lockstep pairing as
    // `authoriseStream`/`mediamtxWebhookSecret` — see bootstrap.ts); kept for
    // type-safety and so this route never assumes the pairing without checking.
    //
    // Deliberately checked AFTER the namespace guard above, not before: a
    // `live/<key>` hook is a wrong path whether or not this box has streaming
    // configured, and answering 200 for it on an unconfigured box would hide the
    // very misconfiguration the 404 exists to surface.
    if (!deps.endUserStream) {
      return c.json(ACKNOWLEDGED_BODY, 200);
    }

    await deps.endUserStream.execute({ hook: body.hook, streamKey: parsed.key });
    return c.json(ACKNOWLEDGED_BODY, 200);
  });

  return app;
}

/**
 * An id header, normalised to "present" or "absent" — where a header that
 * arrived EMPTY, or holding nothing but whitespace, counts as **absent**.
 *
 * FIX ROUND 2. This exists so that the `/auth-request` route's
 * exactly-one-id rule does not depend on a behaviour of nginx that nobody
 * here has run. The two internal `auth_request` locations each CLEAR the
 * other world's id header with `proxy_set_header X-Mtx-... "";`, and nginx's
 * documented response to an empty value is to drop the field entirely. If
 * some nginx version instead forwarded the field present-and-empty, then —
 * with a stricter `=== undefined` test — EVERY request would arrive carrying
 * both ids, the rule below would refuse all of them, and BOTH worlds' HLS
 * would go dark at once. That is a total outage resting on an unverified
 * assumption, and the assumption is not worth keeping: an empty string is
 * not an id, nothing can ever legitimately send one, and accepting it as
 * "present" buys nothing at all.
 *
 * So the nginx directives stay — they are correct, and they are what keeps a
 * client-forged sibling header out of the subrequest in the first place —
 * but they are now belt-and-braces rather than load-bearing.
 *
 * WHAT ARRIVES HERE, MEASURED RATHER THAN ASSUMED — probed with a real Hono
 * request during fix round 2, because the whole point of this function is to
 * stop guessing about transports:
 *
 *   header absent      -> `undefined`
 *   `X-Foo: ""`        -> `""`     <- PRESENT AND EMPTY. This is exactly the
 *                                     nginx failure mode above, reproducible
 *                                     at this layer, which is what lets the
 *                                     four tests for it actually bite.
 *   `X-Foo: "   "`     -> `""`     <- HTTP strips optional whitespace around
 *                                     a field value before anything here.
 *   `X-Foo: "  abc  "` -> `"abc"`  <- same rule.
 *
 * So over HTTP the `.trim()` below is a no-op and `raw.trim() !== ""` is
 * equivalent to `raw !== ""`. It is kept as cheap defence in depth — this
 * function should be obviously right when read on its own, without the
 * reader having to know that rule, and a future runtime or a non-HTTP caller
 * is not owed the benefit of the doubt.
 *
 * IT IS A PRESENCE TEST ONLY; the value itself is passed on UNCHANGED, so
 * nothing here can repair a not-quite-matching id into a matching one. That
 * property is deliberately NOT pinned by a test: the transport already
 * guarantees a padded value never reaches this function, so a test for it
 * would assert against an input HTTP cannot deliver. A mutant that trims the
 * VALUE therefore survives, for that reason and no other — see
 * task-4-fix-2-report.md.
 */
function presentId(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/** The minimum shape `AuthoriseStream.execute` needs out of MediaMTX's body. */
function isAuthRequestBody(
  body: unknown
): body is { action: string; path: string; query?: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).action === "string" &&
    typeof (body as Record<string, unknown>).path === "string"
  );
}

/**
 * The minimum shape `EndUserStream.execute` needs out of the lifecycle hook's
 * own `curl -d` body. `hook` is checked against `LIFECYCLE_HOOKS` here, not
 * merely typeof-string, so a value neither the shell templates in
 * `infra/mediamtx.yml` nor `EndUserStream`'s own union ever produces is treated
 * the same as a malformed body — acknowledged and dropped — rather than reaching
 * the use-case with a hook value it was never typed to accept.
 *
 * NOTE THAT THIS RUNS BEFORE THE NAMESPACE GUARD, so a body that fails here is
 * acknowledged with a 200 even when its `streamKey` is a retired `live/<key>`.
 * That ordering is deliberate and unchanged: this function answers "is this
 * request readable at all", and there is nothing to say about a stream key that
 * arrived alongside a hook value this route cannot interpret.
 */
function isLifecycleRequestBody(
  body: unknown
): body is { hook: "online" | "offline"; streamKey: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).hook === "string" &&
    LIFECYCLE_HOOKS.has((body as Record<string, unknown>).hook as string) &&
    typeof (body as Record<string, unknown>).streamKey === "string"
  );
}
