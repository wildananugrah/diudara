import { Hono } from "hono";
import { z } from "zod";
import { uuidParam, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * The owner's decisions on free-community join requests, mounted at
 * `/communities/:communityId/join-requests`.
 *
 * `DecideJoinRequest` owns every decision (ownership, the already-decided
 * check, the activity_log write); this layer only authenticates, checks the
 * two path parameters are uuids, and hands the result back — same shape as
 * `routes/memberships.ts`.
 */
export function joinRequestRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "listJoinRequests" | "decideJoinRequest">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));
  // `:communityId` comes from the parent mount path, so it is in scope for every
  // route here — see `validateParams`' own comment for why a `use("*")`
  // middleware cannot also see `:requestId`, which belongs to a single route.
  app.use("*", validateParams(z.object({ communityId: uuidParam })));

  app.get("/", async (c) => {
    const rows = await deps.listJoinRequests.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(rows);
  });

  // The explicit generic on each route is load-bearing, not decoration — see
  // `routes/tiers.ts`'s own comment: an untyped Context inside a shared
  // handler would otherwise pollute Hono's path-parameter inference here.
  app.post<"/:requestId/approve">(
    "/:requestId/approve",
    validateParams(z.object({ requestId: uuidParam })),
    async (c) => {
      const result = await deps.decideJoinRequest.execute({
        communityId: c.req.param("communityId")!,
        creatorId: c.get("creatorId"),
        requestId: c.req.param("requestId")!,
        decision: "approved",
      });
      return c.json(result);
    }
  );

  app.post<"/:requestId/reject">(
    "/:requestId/reject",
    validateParams(z.object({ requestId: uuidParam })),
    async (c) => {
      const result = await deps.decideJoinRequest.execute({
        communityId: c.req.param("communityId")!,
        creatorId: c.get("creatorId"),
        requestId: c.req.param("requestId")!,
        decision: "rejected",
      });
      return c.json(result);
    }
  );

  return app;
}
