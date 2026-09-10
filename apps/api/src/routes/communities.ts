import { Hono } from "hono";
import { z } from "zod";
import {
  COMMUNITY_CATEGORIES,
  DEFAULT_COMMUNITY_LIST_LIMIT,
  DEFAULT_COMMUNITY_MEMBER_LIMIT,
  MAX_COMMUNITY_SEARCH_LENGTH,
  createCommunityPostSchema,
  createCommunitySchema,
} from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { validate } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import { parseBefore, parseFeedLimit } from "./posts";
import type { Dependencies } from "../bootstrap";

/**
 * `?q=`/`?category=`/`?limit=` for the browse grid, mirroring
 * `parseExploreQuery` in `routes/users.ts` — including its reason for
 * OMITTING an empty `limit` rather than passing it through: `?limit=` would
 * otherwise coerce to 0 and fail the minimum with a confusing message.
 *
 * The category is checked against the six here as well as in
 * `BrowseCommunities`, so a malformed query is a 400 that names the field
 * rather than a generic one. The use-case's own check is not redundant — it
 * is what protects a caller that is not this route.
 */
const browseQuerySchema = z.object({
  q: z.string().max(MAX_COMMUNITY_SEARCH_LENGTH).optional(),
  category: z.enum(COMMUNITY_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(DEFAULT_COMMUNITY_LIST_LIMIT).optional(),
});

function parseBrowseQuery(raw: {
  q: string | undefined;
  category: string | undefined;
  limit: string | undefined;
}) {
  const parsed = browseQuerySchema.safeParse({
    ...(raw.q === undefined ? {} : { q: raw.q }),
    ...(raw.category === undefined || raw.category === "" ? {} : { category: raw.category }),
    ...(raw.limit === undefined || raw.limit === "" ? {} : { limit: raw.limit }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `invalid query: q must be at most ${MAX_COMMUNITY_SEARCH_LENGTH} characters, ` +
        `category must be one of the ${COMMUNITY_CATEGORIES.length} known categories, ` +
        `limit must be an integer between 1 and ${DEFAULT_COMMUNITY_LIST_LIMIT}`
    );
  }
  return {
    q: parsed.data.q,
    category: parsed.data.category,
    limit: parsed.data.limit ?? DEFAULT_COMMUNITY_LIST_LIMIT,
  };
}

const memberListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DEFAULT_COMMUNITY_MEMBER_LIMIT).optional(),
});

function parseMemberListLimit(raw: string | undefined): number {
  const parsed = memberListQuerySchema.safeParse({
    ...(raw === undefined || raw === "" ? {} : { limit: raw }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `invalid limit: must be an integer between 1 and ${DEFAULT_COMMUNITY_MEMBER_LIMIT}`
    );
  }
  return parsed.data.limit ?? DEFAULT_COMMUNITY_MEMBER_LIMIT;
}

/**
 * `/communities` — Phase 1's core.
 *
 * SIX ROUTES, TWO AUTH SHAPES, and the split is the same one `routes/streams.ts`
 * documents:
 *
 *  - `POST /communities` and both directions of `/:slug/join` are yours,
 *    behind `requireUserAuth`.
 *  - `GET /communities`, `GET /communities/:slug` and
 *    `GET /communities/:slug/members` are PUBLIC, using `resolveViewerId`,
 *    which degrades a missing, expired or epoch-stale token to `null` instead
 *    of throwing. That is what lets a detail response distinguish an
 *    anonymous visitor (`viewerIsMember: null`) from a signed-in non-member
 *    (`false`) — the join button reads differently for each, so collapsing
 *    them would invite a signed-out visitor to tap a button that cannot work.
 *
 * `:slug` needs no `validateParams` guard of the kind `routes/streams.ts`
 * applies to its uuid `:id`: `community.slug` is a `varchar`, so an arbitrary
 * string reaching it is a clean miss and a 404 from the use-case, never a
 * failing cast with the SQL on stderr.
 *
 * No `try`/`catch` anywhere below — `app.onError(errorHandler)` turns a thrown
 * `AppError` into its response.
 */
export function communityRoutes(
  deps: Pick<
    Dependencies,
    | "userTokenIssuer"
    | "userRepository"
    | "createCommunity"
    | "getCommunity"
    | "joinCommunity"
    | "browseCommunities"
    | "listCommunityMembers"
    | "createCommunityPost"
    | "listCommunityFeed"
    | "maxPostImages"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);
  // Built ONCE per router instance from THIS process's resolved
  // `maxPostImages`, the same per-call construction `routes/posts.ts`
  // `buildPostBodySchema` documents: `createCommunityPostSchema` deliberately
  // carries no `.max()` (the cap is a runtime env var, not a shared
  // constant), so an unbounded `mediaIds` array would otherwise reach the
  // media-claim path.
  const communityPostBodySchema = createCommunityPostSchema.extend({
    mediaIds: z
      .array(z.string().uuid())
      .max(deps.maxPostImages, `maksimal ${deps.maxPostImages} foto per kiriman`)
      .optional(),
  });

  app.post("/", requireAuth, validate(createCommunitySchema), async (c) => {
    const input = c.get("validated") as {
      name: string;
      category: string;
      description?: string;
    };
    const created = await deps.createCommunity.execute({
      ownerId: c.get("userId"),
      name: input.name,
      category: input.category,
      description: input.description ?? null,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const { q, category, limit } = parseBrowseQuery({
      q: c.req.query("q"),
      category: c.req.query("category"),
      limit: c.req.query("limit"),
    });
    return c.json(await deps.browseCommunities.execute({ search: q, category, limit }));
  });

  // DECLARED BEFORE `/:slug` so the literal `posts` segment wins over the
  // `:slug` param capture — the same literal-wins ordering `app.ts` documents
  // for its own mount order.
  app.get<"/:slug/posts">("/:slug/posts", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    return c.json(
      await deps.listCommunityFeed.execute({
        slug: c.req.param("slug"),
        viewerId,
        before: parseBefore(c.req.query("before")),
        limit: parseFeedLimit(c.req.query("limit")),
      })
    );
  });

  app.post<"/:slug/posts">(
    "/:slug/posts",
    requireAuth,
    validate(communityPostBodySchema),
    async (c) => {
      const input = c.get("validated") as {
        body: string;
        type: string;
        mediaIds?: string[];
      };
      const view = await deps.createCommunityPost.execute({
        slug: c.req.param("slug"),
        authorId: c.get("userId"),
        body: input.body,
        type: input.type,
        mediaIds: input.mediaIds,
      });
      return c.json(view, 201);
    }
  );

  app.get<"/:slug">("/:slug", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    return c.json(
      await deps.getCommunity.execute({ slug: c.req.param("slug"), viewerId })
    );
  });

  app.get<"/:slug/members">("/:slug/members", async (c) => {
    return c.json(
      await deps.listCommunityMembers.execute({
        slug: c.req.param("slug"),
        limit: parseMemberListLimit(c.req.query("limit")),
      })
    );
  });

  app.post<"/:slug/join">("/:slug/join", requireAuth, async (c) => {
    return c.json(
      await deps.joinCommunity.execute({
        userId: c.get("userId"),
        slug: c.req.param("slug"),
        action: "join",
      })
    );
  });

  app.delete<"/:slug/join">("/:slug/join", requireAuth, async (c) => {
    return c.json(
      await deps.joinCommunity.execute({
        userId: c.get("userId"),
        slug: c.req.param("slug"),
        action: "leave",
      })
    );
  });

  return app;
}
