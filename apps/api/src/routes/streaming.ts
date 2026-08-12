import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * `GET /streaming/status` (Task 7) — mirrors `GET /ai/status` (routes/ai.ts)
 * exactly, for the exact same reason: `deps.scheduleLiveSession` is
 * `undefined` iff live streaming is not configured on this server (see
 * `selectStreamingProvider` in bootstrap.ts and events.ts's own docstring),
 * and the dashboard needs a way to learn that WITHOUT a side effect before
 * it decides whether to show the "Siaran langsung" tab at all.
 *
 * Task 3's report explicitly left this decision to whichever task built the
 * creator-facing screen ("I chose not to add a `GET /events/status`-style
 * enabled flag ... that decision is left to whichever task builds the
 * creator-facing 'go live' screen") — this route is that decision. The
 * alternative — probing via `POST /communities/:communityId/events` and
 * reading its 503 — was rejected on purpose: unlike a GET, a successful POST
 * is not a probe, it is a real session with a real stream key, the same
 * reason `paymentAccount.ts` refuses to probe `POST /payment-account`
 * ("PROBING WITH POST IS STILL NOT AN OPTION").
 *
 * Behind `requireAuth`, same as `/ai/status` — keeps every route consistent
 * with the rest of the dashboard's API surface even though the flag itself
 * is not community-scoped and reveals nothing sensitive.
 */
export function streamingRoutes(deps: Pick<Dependencies, "tokenIssuer" | "scheduleLiveSession">) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.get("/status", async (c) => {
    return c.json({ enabled: deps.scheduleLiveSession !== undefined });
  });

  return app;
}
