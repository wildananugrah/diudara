import { Hono } from "hono";
import { z } from "zod";
import { uuidParam, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * The creator's manual "remove this member" action, mounted at
 * `/communities/:communityId/members`.
 *
 * Thin on purpose: `RevokeChannelAccess` owns every decision, because Phase 5's
 * churn detection calls the same use-case with no request, no Context and no
 * bearer token. All this layer does is authenticate, check the two path
 * parameters are uuids, and hand the result back.
 *
 * The response carries `automated` and a per-channel `reason` verbatim from the
 * use-case: a creator who is told only "revoked" would not learn that they still
 * have to remove the member from a WhatsApp group themselves.
 */
export function membershipRoutes(deps: Pick<Dependencies, "tokenIssuer" | "revokeChannelAccess">) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));
  // `:communityId` comes from the parent mount path, so it is in scope for every
  // route here. `:memberId` belongs to this one route, so it is validated on the
  // route — a `use("*")` middleware cannot see it (see validateParams).
  app.use("*", validateParams(z.object({ communityId: uuidParam })));

  // The explicit generic is load-bearing, not decoration: `validate`/
  // `validateParams` take an untyped `Context`, which otherwise pollutes Hono's
  // path-parameter inference for this route and makes `c.req.param("memberId")`
  // untyped. A cast would hide it instead of fixing it.
  app.post<"/:memberId/revoke">(
    "/:memberId/revoke",
    validateParams(z.object({ memberId: uuidParam })),
    async (c) => {
      const result = await deps.revokeChannelAccess.execute({
        communityId: c.req.param("communityId")!,
        creatorId: c.get("creatorId"),
        memberId: c.req.param("memberId")!,
      });
      return c.json(result);
    }
  );

  return app;
}
