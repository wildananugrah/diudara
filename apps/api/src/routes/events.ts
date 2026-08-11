import { Hono } from "hono";
import { scheduleLiveSessionSchema, type ScheduleLiveSessionInput } from "@diudara/shared";
import { z } from "zod";
import { uuidParam, validate, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import { ServiceUnavailableError } from "../application/errors";
import type { Dependencies } from "../bootstrap";

/**
 * `POST /communities/:communityId/events` and `GET /communities/:communityId/events`
 * (Task 3, design spec §4 step 1) — scheduling a live session and listing a
 * community's sessions.
 *
 * `scheduleLiveSession` is `undefined` exactly when `streamingProvider` is
 * (see `selectStreamingProvider` in bootstrap.ts): live streaming is not
 * configured on this box. That is surfaced as a 503 on the POST below —
 * the SAME shape `POST /ai/messages` uses when `sendAiMessage` is undefined
 * (routes/ai.ts) — rather than throwing from inside the use-case's own
 * constructor call, which would read as a crash rather than a deliberate
 * "not available right now".
 *
 * `listLiveSessions` is never undefined: listing depends on no provider and
 * works the same whether streaming is configured or not (see
 * `ListLiveSessions`'s docstring) — a creator can always see the sessions
 * already on the calendar, even on a box where "go live" is disabled.
 */
export function eventRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "scheduleLiveSession" | "listLiveSessions">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));
  app.use("*", validateParams(z.object({ communityId: uuidParam })));

  app.post("/", validate(scheduleLiveSessionSchema), async (c) => {
    if (!deps.scheduleLiveSession) {
      throw new ServiceUnavailableError("live streaming is not configured on this server");
    }

    const input = c.get("validated") as ScheduleLiveSessionInput;
    const created = await deps.scheduleLiveSession.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      title: input.title,
      scheduledAt: input.scheduledAt,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const list = await deps.listLiveSessions.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(list);
  });

  return app;
}
