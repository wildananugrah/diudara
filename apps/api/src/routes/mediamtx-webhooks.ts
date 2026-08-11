import { Hono } from "hono";
import { UnauthorizedError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/webhooks/webhook-token";
import type { Dependencies } from "../bootstrap";

/**
 * The header a caller MAY carry the shared secret in, mirroring
 * `X-CALLBACK-TOKEN` (Xendit) and `X-Telegram-Bot-Api-Secret-Token`
 * (Telegram) — and the SAME name Task 5's lifecycle hooks
 * (`runOnOnline`/`runOnOffline`) use, since those ARE shell `curl`
 * commands this codebase writes and so genuinely CAN send a header.
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
 * "no such event", "ended event", "bad signature", "expired token", "wrong
 * event", "wrong community" and "cancelled subscription" into one
 * `{ allowed: false }`; this constant is what stops the ROUTE from
 * reintroducing a distinction the use-case deliberately erased (e.g. by
 * some future edit adding a message that names which check failed).
 */
const REFUSED_BODY = { ok: false } as const;
const ALLOWED_BODY = { ok: true } as const;

/**
 * The literal body `/lifecycle` always answers with, once the shared secret has
 * checked out — success OR a no-op both read as "acknowledged". Unlike `/auth`,
 * this route has nothing to refuse: it is a fire-and-forget notification from a
 * shell `curl` command, not a decision MediaMTX branches on. See the route's own
 * docstring for why an unknown key or a malformed body still answer 200.
 */
const ACKNOWLEDGED_BODY = { ok: true } as const;

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
    "authoriseStream" | "mediamtxWebhookSecret" | "handleStreamLifecycle"
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
   * `GET /webhooks/mediamtx/auth-request` — Task 9. NOT called by MediaMTX.
   * Called by nginx's `auth_request` directive, once per HTTP request nginx
   * proxies to MediaMTX's HLS port, closing the gap the rest of this
   * docstring explains.
   *
   * THE PROBLEM THIS EXISTS TO FIX: MediaMTX's own `authHTTPAddress`
   * mechanism (the `/auth` route above) authorises a READ only ONCE per
   * viewer — confirmed empirically for Task 9 (see task-9-report.md): the
   * FIRST request for a stream mints an internal, MediaMTX-issued session
   * identifier (returned as `hlsSession`/`cookieCheck` cookies for
   * cookie-capable clients, AND rewritten directly into every sub-manifest
   * URI as a `?session=` query parameter for clients that never send
   * cookies at all — which is what `hls.js`'s default, credential-less
   * cross-origin XHR loader is, confirmed with a real browser). EVERY
   * subsequent request carrying that session identifier is let through
   * WITHOUT calling `/auth` again — `AuthoriseStream.authoriseRead`'s live
   * entitlement re-check never re-runs for the rest of that viewer's
   * session, which for an open tab is the rest of the broadcast. A member
   * who churns mid-stream keeps receiving segments until they close the tab
   * or the underlying MediaMTX session times out — directly contradicting
   * design spec §5.2 and this file's own `AuthoriseStream` docstring
   * ("lose access on their very next segment request").
   *
   * THE FIX: put nginx in front of MediaMTX's (already non-public) HLS
   * port, with `auth_request` pointing here for every proxied request —
   * see CONTRIBUTING.md's "Live streaming (MediaMTX)" section and
   * `infra/nginx/live-hls.conf.template` for the actual config. nginx's
   * `auth_request` has NO caching of its own: every single HTTP request
   * (master playlist, every sub-playlist reload, every init segment, every
   * media segment, every LL-HLS part) triggers a fresh subrequest here,
   * which calls the SAME `AuthoriseStream.authoriseRead` the `/auth` route
   * calls — the SAME live database re-check, every time, regardless of
   * whatever MediaMTX itself would have cached. This does not change
   * `AuthoriseStream` at all; it changes how often it gets asked.
   *
   * WHY A SEPARATE ROUTE, NOT A REUSED `/auth`: nginx's `auth_request`
   * subrequest has no built-in way to construct MediaMTX's POST-JSON-body
   * contract (it mirrors the original request, normally a bodyless GET) —
   * so this route accepts the two inputs `AuthoriseStream.authoriseRead`
   * actually needs as HEADERS instead: `X-Mtx-Path` (built by nginx from
   * the request URL as exactly `live/<key>` — see the nginx config; the
   * specific FILE being requested carries no additional
   * authorisation-relevant information, matching what MediaMTX's own
   * `authHTTPAddress` call already sends) and `X-Watch-Token` (the SAME
   * watch token `hls.js`'s `xhrSetup` re-attaches to every request, per
   * Task 8). `action` is hard-coded to `"read"`: nginx only ever proxies
   * HLS reads here — RTMP publish (port 1935) is never proxied through
   * nginx at all (see CONTRIBUTING.md's port-asymmetry note), so this
   * route has no publish case to handle.
   *
   * HEADERS, NOT QUERY PARAMETERS — found running this for real, not from
   * documentation. The obvious design reuses `?mtxPath=...&token=...` on
   * this route's own URL, exactly like `/auth`'s `secret` query parameter.
   * It does not work: nginx's `auth_request` subrequest does NOT inherit
   * `$args`/`$arg_*` from the request it is authorising — confirmed with a
   * probe upstream that echoed back what the subrequest actually received.
   * `$arg_token`, read directly inside the internal `auth_request` location,
   * came back EMPTY every time, while `$request_uri` and a location's own
   * regex-captured variable (`$mtx_key` in the nginx config) both came back
   * correct. The working pattern (see `infra/nginx/live-hls.conf.template`):
   * capture the token into a plain nginx variable with `set $watch_token
   * $arg_token;` in the OUTER location, BEFORE `auth_request` fires — a
   * `set` variable persists into the subrequest the same way a regex
   * capture does, even though `$arg_token` itself does not — then forward
   * that variable as a header. See task-9-report.md for the full trace.
   *
   * SECRET, VIA HEADER: unlike `authHTTPAddress`, nginx has no limitation
   * on custom headers (`proxy_set_header` in the internal location), so
   * there is no reason to also accept a query parameter here the way
   * `/auth` and `/lifecycle` must for MediaMTX's sake.
   *
   * nginx's `auth_request` module only inspects the STATUS CODE (2xx =
   * allow, 401/403 = deny) — same rule as MediaMTX's own `authHTTPAddress`
   * — so this reuses `ALLOWED_BODY`/`REFUSED_BODY` for consistency, though
   * nginx never reads either body.
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

    const mtxPath = c.req.header("X-Mtx-Path") ?? "";
    const token = c.req.header("X-Watch-Token");
    const query = token ? `token=${encodeURIComponent(token)}` : "";

    const { allowed } = await deps.authoriseStream.execute({
      action: "read",
      path: mtxPath,
      query,
      now: Date.now(),
    });

    return allowed ? c.json(ALLOWED_BODY, 200) : c.json(REFUSED_BODY, 403);
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
   * before `HandleStreamLifecycle` is ever reached — identical ordering to
   * `/auth`, for the identical reason.
   *
   * ALWAYS 200 ONCE THE SECRET CHECKS OUT, whatever `HandleStreamLifecycle.execute`
   * did or did not do: an unknown stream key, a malformed body, an out-of-order
   * hook that turned out to be a no-op — none of these are failures MediaMTX
   * should retry over. `runOnOnline`/`runOnOffline` are fire-and-forget; a 500
   * here would make MediaMTX (or whatever wraps the curl call) retry forever for
   * a condition retrying can never fix. A genuine database error is NOT caught
   * here and is allowed to become the process's normal 500, exactly as `/auth`
   * lets `AuthoriseStream.execute` propagate — the two failure modes are
   * different (one is "this input teaches us nothing new", the other is "the
   * database is unreachable") and only the first is swallowed to 200.
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

    // Streaming not configured on this box — nothing to react to. Unreachable
    // in practice once the secret check above holds (same pairing as
    // `authoriseStream`/`mediamtxWebhookSecret` — see bootstrap.ts); kept for
    // type-safety and so this route never assumes the pairing without checking.
    if (!deps.handleStreamLifecycle) {
      return c.json(ACKNOWLEDGED_BODY, 200);
    }

    await deps.handleStreamLifecycle.execute({
      hook: body.hook,
      streamKey: body.streamKey,
    });

    return c.json(ACKNOWLEDGED_BODY, 200);
  });

  return app;
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
 * The minimum shape `HandleStreamLifecycle.execute` needs out of the lifecycle
 * hook's own `curl -d` body. `hook` is checked against `LIFECYCLE_HOOKS` here,
 * not merely typeof-string, so a value neither the shell templates in
 * `infra/mediamtx.yml` nor `HandleStreamLifecycle`'s own union ever produces is
 * treated the same as a malformed body — acknowledged and dropped — rather than
 * reaching the use-case with a hook value it was never typed to accept.
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
