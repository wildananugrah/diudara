import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../application/errors";
import { decodeActivityCursor, type ActivityCursor } from "../domain/activity-feed";
import { uuidParam, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

const communityParams = z.object({ communityId: uuidParam });

/** Page size when the caller does not ask for one. */
const DEFAULT_PAGE_LIMIT = 25;

/**
 * Largest page a caller may ask for.
 *
 * A CAP THAT REFUSES rather than one that silently clamps. `?limit=100000` is
 * either a mistake or an attempt to make the API read a creator's whole history
 * into memory in one request; answering 25 rows to a request for 100 000 would hide
 * which of the two it was, and a client that silently gets less than it asked for
 * has no way to tell a short page from the end of the feed.
 */
const MAX_PAGE_LIMIT = 100;

/**
 * `?limit=` and `?before=`, parsed and validated.
 *
 * Takes the two raw strings rather than a `Context`, on purpose: an untyped
 * `Context` parameter pollutes Hono's path-parameter inference wherever it is
 * threaded through (the reason the route registrations below carry explicit
 * generics), and a helper that never sees one cannot do that.
 *
 * `limit` is `coerce.number().int()` and NOT `parseInt`: `parseInt("1.5")` is 1 and
 * `parseInt("12abc")` is 12, so a malformed value would be silently accepted as a
 * different number than the caller wrote.
 */
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  before: z.string().min(1).optional(),
});

function parsePageQuery(rawLimit: string | undefined, rawBefore: string | undefined): {
  limit: number;
  before?: ActivityCursor;
} {
  const parsed = pageQuerySchema.safeParse({
    // Omitted rather than passed as `undefined`-from-empty-string: `?limit=` would
    // otherwise coerce to 0 and fail the minimum with a confusing message.
    ...(rawLimit === undefined || rawLimit === "" ? {} : { limit: rawLimit }),
    ...(rawBefore === undefined || rawBefore === "" ? {} : { before: rawBefore }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `invalid page parameters: limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`
    );
  }

  const limit = parsed.data.limit ?? DEFAULT_PAGE_LIMIT;
  if (parsed.data.before === undefined) return { limit };

  const before = decodeActivityCursor(parsed.data.before);
  if (before === null) {
    // 400, not "start from the beginning". A corrupted cursor treated as absent
    // makes a "load more" button loop over page 1 for ever with nothing to show the
    // reader that anything is wrong.
    throw new ValidationError("invalid `before` cursor — use the nextCursor from a previous page");
  }
  return { limit, before };
}

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
export function analyticsRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "getCommunityMetrics" | "getCommunityActivity">
) {
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

  app.get<"/:communityId/activity">(
    "/:communityId/activity",
    requireAuth(deps.tokenIssuer),
    validateParams(communityParams),
    async (c) => {
      const page = parsePageQuery(c.req.query("limit"), c.req.query("before"));
      const feed = await deps.getCommunityActivity.execute({
        communityId: c.req.param("communityId"),
        creatorId: c.get("creatorId"),
        limit: page.limit,
        ...(page.before === undefined ? {} : { before: page.before }),
      });
      return c.json(feed);
    }
  );

  return app;
}
