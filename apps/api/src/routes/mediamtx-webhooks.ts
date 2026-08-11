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
  deps: Pick<Dependencies, "authoriseStream" | "mediamtxWebhookSecret">
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
