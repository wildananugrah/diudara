import { Hono } from "hono";
import { UnauthorizedError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/webhooks/webhook-token";
import type { Dependencies } from "../bootstrap";

/**
 * The header MediaMTX's `authHTTPAddress` POST must carry the shared secret
 * in, mirroring `X-CALLBACK-TOKEN` (Xendit) and
 * `X-Telegram-Bot-Api-Secret-Token` (Telegram) — and the SAME name the
 * design's Task 5 lifecycle hooks (`runOnOnline`/`runOnOffline`, which ARE
 * shell `curl` commands this codebase writes) already use, for one
 * endpoint's secret to be spelled one way across this codebase.
 *
 * WORTH FLAGGING, not silently worked around: MediaMTX's own
 * `authHTTPAddress` mechanism is NOT a shell command we control — it is
 * MediaMTX's internal HTTP client, and mediamtx.org's authentication docs
 * enumerate its configuration surface (`authMethod`, `authHTTPAddress`,
 * `authHTTPExclude`, `authHTTPFingerprint`, `authInternalUsers`, the
 * `authJWT*` keys) with NO option to attach a custom static header. So while
 * `runOnOnline`'s `curl -H "X-Mediamtx-Secret: ..."` can send this header
 * because we wrote the command, MediaMTX itself has no built-in way to send
 * it on the POST this route authenticates. Task 6 (the real `infra/
 * mediamtx.yml`) will need to reconcile that — most plausibly by baking the
 * secret into `authHTTPAddress`'s own URL as a query parameter
 * (`?secret=...`, read via `c.req.query`, independent of this route's own
 * `X-Mediamtx-Secret` check) rather than a header MediaMTX cannot send. This
 * route still enforces the header today, exactly as briefed, so it is
 * secure-by-default and the test suite below proves the 401 path holds; a
 * later task adding a second, query-based check alongside this one is a
 * strict widening, not a change to what already passes.
 */
const MEDIAMTX_SECRET_HEADER = "X-Mediamtx-Secret";

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
    if (!verifyCallbackToken(c.req.header(MEDIAMTX_SECRET_HEADER), deps.mediamtxWebhookSecret)) {
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
