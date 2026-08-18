import { Hono } from "hono";
import { z } from "zod";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { decodeKeysetCursor, type KeysetCursor } from "../domain/keyset-cursor";
import { validate } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";
import type { FeedTab } from "../application/use-cases/read-posts";

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;

const postBodySchema = z.object({
  body: z.string().min(1).max(MAX_POST_BODY_LENGTH),
});

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
    "userTokenIssuer" | "userRepository" | "createPost" | "editPost" | "deletePost" | "listFeed" | "listUserPosts"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/posts", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.createPost.execute({ authorId: c.get("userId"), body: input.body });
    return c.json(view, 201);
  });

  app.patch<"/posts/:id">("/posts/:id", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.editPost.execute({
      editorId: c.get("userId"),
      postId: c.req.param("id"),
      body: input.body,
    });
    return c.json(view);
  });

  app.delete<"/posts/:id">("/posts/:id", requireAuth, async (c) => {
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

  app.get<"/:handle/posts">("/:handle/posts", async (c) => {
    const { limit } = parseFeedQuery(undefined, c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const page = await deps.listUserPosts.execute({
      handle: c.req.param("handle"),
      limit,
      before,
    });
    return c.json(page);
  });

  return app;
}
