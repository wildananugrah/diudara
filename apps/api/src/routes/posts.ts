import { Hono } from "hono";
import { z } from "zod";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { decodeKeysetCursor, type KeysetCursor } from "../domain/keyset-cursor";
import { uuidParam, validate, validateParams } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";
import type { FeedTab } from "../application/use-cases/read-posts";

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;

/**
 * Review round 1, I5: this used to check `.max()` on the RAW body, while
 * `write-post.ts`'s `requireBody` trims BEFORE checking — so a 1000-character
 * body with surrounding whitespace was accepted by the use case and rejected
 * here (measured: 400). Task 5's composer reads the same
 * `MAX_POST_BODY_LENGTH` and will count trimmed length, so route and use case
 * disagreeing about what "1000 characters" means is the exact cross-layer
 * defect that constant exists to prevent. `.trim()` here makes both sides
 * measure the same text; `requireBody`'s check stays the authority for
 * emptiness (see its own docstring for why trim-then-validate, in that
 * order) — deliberately no `.min(1)` here, so a whitespace-only or empty body
 * reaches `requireBody` and gets ITS Indonesian message rather than a raw
 * English Zod one at this layer.
 */
/**
 * Task 7 of images. `maxPostImages` is `bootstrap()`'s resolved
 * `MAX_POST_IMAGES` (default 5) — a runtime env var rather than a shared
 * constant (images design spec §6), which is exactly why this schema is now
 * built PER CALL instead of once at module load: it must read whatever this
 * process actually resolved, not a value baked in before `postRoutes` ever
 * saw its deps.
 *
 * Enforced on BOTH `POST` and `PATCH` — this one schema is shared by both
 * routes below, so an edit cannot add a sixth image while create refuses
 * one. The message is Bahasa and names the limit: a refusal for too many
 * images is a `ValidationError`, and every `ValidationError` a person can
 * hit on this router speaks Bahasa (`NotFoundError` is the only exception
 * in this codebase, and stays English everywhere).
 */
function buildPostBodySchema(maxPostImages: number) {
  return z.object({
    body: z.string().trim().max(MAX_POST_BODY_LENGTH),
    /**
     * The COMPLETE desired list of images, in order — not a delta (spec §5.2).
     * `.optional()` is load-bearing on PATCH: an OMITTED `mediaIds` is a
     * text-only edit that leaves the post's images alone, while an explicit `[]`
     * removes them all. Zod strips unknown keys, so the two are distinguishable
     * here only because the field is declared.
     *
     * Ownership — mine, and unclaimed or already this post's — is `write-post.ts`'s
     * to decide; this layer only says the ids are shaped like ids AND that there
     * are not too many of them. A non-uuid would otherwise reach a uuid column
     * and 500, the same defect `:id` params were fixed for; an over-the-cap
     * array would otherwise reach `requireAttachable` and be accepted in full,
     * since Task 6 deliberately left the cap for this task to add.
     */
    mediaIds: z
      .array(z.string().uuid())
      .max(maxPostImages, `maksimal ${maxPostImages} foto per kiriman`)
      .optional(),
  });
}

const postIdParams = z.object({ id: uuidParam });

const feedQuerySchema = z.object({
  tab: z.enum(["untuk-anda", "mengikuti"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FEED_PAGE_SIZE).optional(),
});

function parseFeedQuery(rawTab: string | undefined, rawLimit: string | undefined) {
  const parsed = feedQuerySchema.safeParse({
    ...(rawTab === undefined || rawTab === "" ? {} : { tab: rawTab }),
    ...(rawLimit === undefined || rawLimit === "" ? {} : { limit: rawLimit }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `permintaan tidak valid: tab harus untuk-anda atau mengikuti, dan limit 1-${MAX_FEED_PAGE_SIZE}`
    );
  }
  return {
    tab: (parsed.data.tab ?? "untuk-anda") as FeedTab,
    limit: parsed.data.limit ?? DEFAULT_FEED_PAGE_SIZE,
  };
}

/**
 * A malformed `?before=` is a 400, never "no cursor". Treating it as absent
 * restarts the list at page 1, so a "Muat lebih banyak" button with a corrupt
 * cursor loops for ever showing the same rows — see `keyset-cursor.ts`.
 */
function parseBefore(raw: string | undefined): KeysetCursor | null {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeKeysetCursor(raw);
  if (cursor === null) throw new ValidationError("penanda halaman tidak valid");
  return cursor;
}

export function postRoutes(
  deps: Pick<
    Dependencies,
    | "userTokenIssuer"
    | "userRepository"
    | "createPost"
    | "editPost"
    | "deletePost"
    | "listFeed"
    | "listUserPosts"
    | "maxPostImages"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);
  // Built ONCE per router instance from THIS process's resolved
  // `maxPostImages`, then shared by both `POST` and `PATCH` below — see
  // `buildPostBodySchema`'s own docstring for why it is a function rather
  // than the module-level constant it used to be.
  const postBodySchema = buildPostBodySchema(deps.maxPostImages);

  app.post("/posts", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string; mediaIds?: string[] };
    const view = await deps.createPost.execute({
      authorId: c.get("userId"),
      body: input.body,
      mediaIds: input.mediaIds,
    });
    return c.json(view, 201);
  });

  // Review round 1, I3: an `:id` that is not a uuid used to reach
  // `ownershipOf`, which queries a uuid column — Postgres throws and the
  // request 500s with the failing SQL on stderr. `validateParams` (the same
  // idiom `routes/communities.ts`'s `/:id` uses) rejects it as a 400 before
  // any repository call, matching how a malformed `?before=` is already
  // handled: a bad id is a bad request, not a silent reinterpretation. A
  // well-formed but UNKNOWN uuid still reaches the use case and 404s there.
  app.patch<"/posts/:id">(
    "/posts/:id",
    requireAuth,
    validateParams(postIdParams),
    validate(postBodySchema),
    async (c) => {
      const input = c.get("validated") as { body: string; mediaIds?: string[] };
      const view = await deps.editPost.execute({
        editorId: c.get("userId"),
        postId: c.req.param("id"),
        body: input.body,
        mediaIds: input.mediaIds,
      });
      return c.json(view);
    }
  );

  app.delete<"/posts/:id">("/posts/:id", requireAuth, validateParams(postIdParams), async (c) => {
    await deps.deletePost.execute({ deleterId: c.get("userId"), postId: c.req.param("id") });
    return c.json({ deleted: true });
  });

  // §5.1: `untuk-anda` is PUBLIC and `mengikuti` requires a session. `/beranda`
  // is a publicly reachable page, so an auth-only feed endpoint would break a
  // page a signed-out visitor can open — the cross-layer shape this project
  // keeps finding. Hence `resolveViewerId` (which degrades to null) plus an
  // explicit 401 for the one tab that cannot work without a viewer.
  app.get("/feed", async (c) => {
    const { tab, limit } = parseFeedQuery(c.req.query("tab"), c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    if (tab === "mengikuti" && viewerId === null) {
      return c.json({ error: "masuk untuk melihat kiriman yang Anda ikuti" }, 401);
    }
    const page = await deps.listFeed.execute({ tab, viewerId, limit, before });
    return c.json(page);
  });

  // A profile page is publicly reachable, exactly like `/beranda` — hence
  // `resolveViewerId`, which degrades to `null` rather than rejecting, and no
  // 401 here. Phase 6 is why this route resolves a viewer at all: the paywall
  // gate is answered per VIEWER, so a signed-out reader gets a gated post's
  // caption and none of its images while its author gets all of them.
  app.get<"/:handle/posts">("/:handle/posts", async (c) => {
    const { limit } = parseFeedQuery(undefined, c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const page = await deps.listUserPosts.execute({
      handle: c.req.param("handle"),
      viewerId,
      limit,
      before,
    });
    return c.json(page);
  });

  return app;
}
