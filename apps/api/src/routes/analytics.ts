import { Hono } from "hono";
import { z } from "zod";
import { uuidParam, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

const communityParams = z.object({ communityId: uuidParam });

/**
 * The creator dashboard's read-only endpoints, mounted at `/communities`.
 *
 * MOUNTED THERE, AND WITH PER-ROUTE MIDDLEWARE RATHER THAN `use("*")`, and the
 * two facts are connected. Hono composes EVERY handler whose path matches, and a
 * `*` registered under `/communities` matches `/communities` ITSELF — so a
 * `use("*", validateParams({ communityId }))` here would fire on `GET /communities`
 * and `POST /communities`, find no `communityId` to validate, and turn the
 * community list and create endpoints into 400s. Probed against a real Hono app
 * before this was written; `analytics.test.ts` has a test that would catch a
 * `use("*")` creeping back in.
 *
 * `requireAuth` therefore comes first on each route, individually, which also
 * preserves the convention the tier and channel routes establish: an
 * unauthenticated request with a malformed id gets 401, not 400. Authentication is
 * not optional on any of these — the roster carries members' WhatsApp numbers.
 *
 * Every handler is a straight pass-through. The use-cases own the ownership
 * decision, because the repository owns it (see `AnalyticsRepositoryPort`), so
 * there is nothing for this layer to get wrong.
 */
export function analyticsRoutes(deps: Pick<Dependencies, "tokenIssuer" | "getCommunityMetrics">) {
  const app = new Hono<{ Variables: AuthVariables }>();

  // The explicit generic is load-bearing, not decoration: `validateParams` takes an
  // untyped `Context`, which otherwise pollutes Hono's path-parameter inference for
  // this route and leaves `c.req.param("communityId")` untyped. A cast would hide
  // that instead of fixing it. Same remedy as memberships.ts and tiers.ts.
  app.get<"/:communityId/metrics">(
    "/:communityId/metrics",
    requireAuth(deps.tokenIssuer),
    validateParams(communityParams),
    async (c) => {
      const metrics = await deps.getCommunityMetrics.execute({
        communityId: c.req.param("communityId"),
        creatorId: c.get("creatorId"),
      });
      return c.json(metrics);
    }
  );

  return app;
}
