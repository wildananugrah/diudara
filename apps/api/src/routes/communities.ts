import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  COMMUNITY_CATEGORIES,
  DEFAULT_COMMUNITY_LIST_LIMIT,
  DEFAULT_COMMUNITY_MEMBER_LIMIT,
  MAX_COMMUNITY_SEARCH_LENGTH,
  DOCUMENT_ERROR_CODE,
  MAX_DOCUMENT_BYTES,
  createCommunityPostFields,
  createCommunitySchema,
  refineCommunityPostEvent,
} from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { DocumentRejectedError, contentDispositionFor } from "../domain/document";
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

/** Bahasa, like every other member-facing refusal — `errorCopy.ts`'s rule. */
const NO_DOCUMENT_MESSAGE = "berkas wajib disertakan";

/**
 * Multipart framing costs bytes beyond the file itself — boundaries, part
 * headers, the trailing terminator. Without this allowance a file at exactly
 * `MAX_DOCUMENT_BYTES` is refused by the body limit before the handler can
 * give the honest answer. The same constant and reason as `routes/media.ts`.
 */
const MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024;

/**
 * Every document is member-gated, so there is no ungated variant of this
 * header to pick between — unlike media, which serves public and gated images
 * from one route. `no-store` rather than a max-age: a document is small
 * enough that re-fetching costs little, and a cached copy surviving a
 * membership ending is a worse trade.
 */
const GATED_DOCUMENT_CACHE_CONTROL = "private, no-store";

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
    | "listCommunityEvents"
    | "uploadCommunityDocument"
    | "listCommunityDocuments"
    | "downloadCommunityDocument"
    | "deleteCommunityDocument"
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
  const communityPostBodySchema = createCommunityPostFields
    .extend({
      mediaIds: z
        .array(z.string().uuid())
        .max(deps.maxPostImages, `maksimal ${deps.maxPostImages} foto per kiriman`)
        .optional(),
    })
    // RE-APPLIED, not re-implemented. `.extend()` returns a fresh ZodObject
    // that carries none of the source's refinements, so without this line the
    // one path that actually receives community posts would accept a
    // `kegiatan` with no schedule. Sharing the function is what keeps the two
    // schemas' rules from drifting.
    .superRefine(refineCommunityPostEvent);

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
        event?: { title: string; startsAt: string; endsAt?: string; location?: string };
      };
      const view = await deps.createCommunityPost.execute({
        slug: c.req.param("slug"),
        authorId: c.get("userId"),
        body: input.body,
        type: input.type,
        mediaIds: input.mediaIds,
        // ISO strings in, `Date`s onward — the boundary where the wire's
        // representation stops and the domain's begins, and the LAST place
        // that conversion is cheap. Both timestamps already parsed cleanly:
        // the schema's `isoInstant` refused anything `new Date()` reads as
        // NaN, so these constructions cannot produce an Invalid Date.
        ...(input.event === undefined
          ? {}
          : {
              event: {
                title: input.event.title,
                startsAt: new Date(input.event.startsAt),
                ...(input.event.endsAt === undefined
                  ? {}
                  : { endsAt: new Date(input.event.endsAt) }),
                ...(input.event.location === undefined
                  ? {}
                  : { location: input.event.location }),
              },
            }),
      });
      return c.json(view, 201);
    }
  );

  // DECLARED BEFORE `/:slug` for the same literal-wins reason `posts` above
  // is. `?month=YYYY-MM` is a WIB month; absent or malformed means the WIB
  // month containing the clock's now, and `wibMonthRange` owns both rules —
  // the route does no date parsing of its own and reads no clock of its own.
  app.get<"/:slug/events">("/:slug/events", async (c) => {
    return c.json(
      await deps.listCommunityEvents.execute({
        slug: c.req.param("slug"),
        month: c.req.query("month"),
      })
    );
  });

  // ---- Phase 4a, the document library -------------------------------------
  //
  // EVERY route sits under `/:slug/documents…`, so `documents` never appears
  // as the first segment after `/communities` and a community slugged
  // `documents` shadows nothing. That is why `RESERVED_COMMUNITY_SLUGS` needs
  // no new entry, unlike the `comments` literal Phase 2 had to reserve under
  // `/users/`.

  app.get<"/:slug/documents">("/:slug/documents", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    return c.json(
      await deps.listCommunityDocuments.execute({ slug: c.req.param("slug"), viewerId })
    );
  });

  app.post<"/:slug/documents">(
    "/:slug/documents",
    // AUTH FIRST, deliberately, the ordering `POST /users/media` documents: a
    // body ceiling is a resource guard, and a stranger with no session should
    // be turned away before this process reasons about their body at all.
    requireAuth,
    bodyLimit({ maxSize: MAX_DOCUMENT_BYTES + MULTIPART_ENVELOPE_ALLOWANCE }),
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        // A body that is not multipart at all. Without this it reaches
        // `errorHandler` as an unhandled TypeError and becomes a 500 — a
        // caller error answered as if the server broke.
        throw new ValidationError(NO_DOCUMENT_MESSAGE, DOCUMENT_ERROR_CODE.missingFile);
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ValidationError(NO_DOCUMENT_MESSAGE, DOCUMENT_ERROR_CODE.missingFile);
      }

      try {
        const view = await deps.uploadCommunityDocument.execute({
          slug: c.req.param("slug"),
          uploaderId: c.get("userId"),
          name: file.name,
          contentType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        return c.json(view, 201);
      } catch (err) {
        // `DocumentRejectedError` is a plain Error, not an AppError — only
        // this layer knows to render it, and it carries the domain's own code
        // onto the wire. Matched on the BASE class so a later refusal added in
        // `domain/document.ts` reaches the client correctly labelled without
        // this route changing. The shape `routes/media.ts` established for
        // `ImageRejectedError`.
        if (err instanceof DocumentRejectedError) {
          throw new ValidationError(err.message, err.code);
        }
        throw err;
      }
    }
  );

  // Spec §"The security decision". This handler reads the bytes and writes
  // them into the response BY HAND, on purpose — a redirect to a signed URL
  // would hand the caller something that outlives the check that produced it,
  // and the member gate would become a decision made once that the internet
  // keeps forever. `routes/media.ts` carries the same warning at length.
  // DO NOT "optimise" this into a redirect.
  app.get<"/:slug/documents/:id">("/:slug/documents/:id", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    // Throws NotFoundError for absent, deleted, wrong-community AND refused —
    // one answer for all four, so none is distinguishable by probing.
    const document = await deps.downloadCommunityDocument.execute({
      slug: c.req.param("slug"),
      id: c.req.param("id"),
      viewerId,
    });

    return c.body(new Uint8Array(document.bytes), 200, {
      // The row's stored type, which is what the CLIENT declared on upload and
      // is untrusted as a claim about the bytes. The two headers below are
      // what make serving it safe, and they are not optional extras — see the
      // spec. They hold as a SET; removing any one defeats the others.
      "Content-Type": document.contentType,
      "Content-Disposition": contentDispositionFor(document.name),
      "X-Content-Type-Options": "nosniff",
      // Decided by the SAME check that decided the bytes, never computed
      // separately: computed apart the two can disagree, and a shared cache
      // then holds gated documents and serves them to strangers — a failure
      // no assertion on this route's status code would ever catch.
      "Cache-Control": GATED_DOCUMENT_CACHE_CONTROL,
    });
  });

  app.delete<"/:slug/documents/:id">("/:slug/documents/:id", requireAuth, async (c) => {
    return c.json(
      await deps.deleteCommunityDocument.execute({
        slug: c.req.param("slug"),
        id: c.req.param("id"),
        viewerId: c.get("userId"),
      })
    );
  });

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
