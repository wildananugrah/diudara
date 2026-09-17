import { Hono } from "hono";
import type { Container } from "../container.ts";
import { type AppEnv, param, requireAuth, userId } from "./middleware.ts";
import type { PostType } from "../domain/types.ts";
import { ValidationError } from "../domain/errors.ts";
import { env } from "../config/env.ts";
import type { StreamAuthRequest } from "../application/LiveService.ts";

const asTypes = (raw: string | undefined): PostType[] | undefined =>
  raw ? (raw.split(",").filter(Boolean) as PostType[]) : undefined;

export function buildRoutes(c: Container) {
  const api = new Hono<AppEnv>();

  // ------------------------------------------------------------------ auth
  api.post("/auth/register", async (ctx) => {
    const body = await ctx.req.json<{ email: string; password: string; name: string }>();
    return ctx.json(await c.auth.register(body), 201);
  });

  api.post("/auth/login", async (ctx) => {
    const body = await ctx.req.json<{ email: string; password: string }>();
    return ctx.json(await c.auth.login(body));
  });

  api.get("/auth/me", requireAuth, async (ctx) => ctx.json(await c.auth.me(userId(ctx))));

  /**
   * The profile page. Each endpoint edits the account behind the TOKEN — there is
   * no user id in any path or body, so one signed-in user cannot address another.
   *
   * Split three ways because they have different costs: name/handle/colour save
   * on a session alone, while changing the email or the password re-checks the
   * current password (see AuthService for why).
   */
  api.patch("/auth/me", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ name?: string; handle?: string; avatarColor?: string }>();
    return ctx.json(await c.auth.updateProfile(userId(ctx), body));
  });

  api.patch("/auth/me/email", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ currentPassword: string; email: string }>();
    return ctx.json(await c.auth.changeEmail(userId(ctx), body));
  });

  api.patch("/auth/me/password", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ currentPassword: string; newPassword: string }>();
    return ctx.json(await c.auth.changePassword(userId(ctx), body));
  });

  // ------------------------------------------------------------- discovery
  api.get("/communities", async (ctx) => {
    const q = ctx.req.query();
    return ctx.json(await c.communities.discover({
      q: q.q, category: q.category, isLive: q.isLive === "true",
    }));
  });

  // Registered before "/communities/:id" so ":id" never swallows a POST to the
  // collection. Creates the community, its tiers, and the owner membership.
  api.post("/communities", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ draft?: unknown }>();
    return ctx.json(await c.communityBuilder.create(userId(ctx), body?.draft ?? body), 201);
  });

  // The AI co-builder. The browser never holds OPENROUTER_API_KEY; it posts the
  // transcript here and the server talks to OpenRouter.
  api.post("/ai/community-builder", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ messages?: unknown }>();
    return ctx.json(await c.communityBuilder.chat(body?.messages));
  });

  api.get("/categories", async (ctx) => ctx.json(await c.communities.categories()));
  api.get("/trending-tags", async (ctx) => ctx.json(await c.communities.trendingTags()));
  api.get("/me/communities", requireAuth, async (ctx) => ctx.json(await c.communities.mine(userId(ctx))));

  // Registered before /communities/:id so "me" is never read as a community id.
  api.get("/communities/:id", async (ctx) =>
    ctx.json(await c.communities.detail(param(ctx, "id"), ctx.get("userId"))));

  // ------------------------------------------------------------- community
  api.get("/communities/:id/feed", requireAuth, async (ctx) => {
    const q = ctx.req.query();
    return ctx.json(await c.communities.feed(param(ctx, "id"), userId(ctx), {
      tag: q.tag, topic: q.topic, q: q.q,
      sort: q.sort === "populer" ? "populer" : "terbaru",
      types: asTypes(q.types),
    }));
  });

  const feedOfType = (path: string, types: PostType[]) =>
    api.get(path, requireAuth, async (ctx) =>
      ctx.json(await c.communities.feed(param(ctx, "id"), userId(ctx), { types })));

  feedOfType("/communities/:id/announcements", ["pengumuman"]);
  feedOfType("/communities/:id/events", ["event"]);

  api.get("/communities/:id/members", requireAuth, async (ctx) =>
    ctx.json(await c.communities.members(param(ctx, "id"), userId(ctx))));
  // Owner-only. Marks the membership churned and cancels its subscription;
  // nothing is deleted, so the dashboard still reports the churn.
  api.delete("/communities/:id/members/:userId", requireAuth, async (ctx) =>
    ctx.json(await c.members.removeMember(param(ctx, "id"), userId(ctx), param(ctx, "userId"))));

  api.get("/communities/:id/materi", requireAuth, async (ctx) =>
    ctx.json(await c.communities.materi(param(ctx, "id"), userId(ctx))));
  // Materi CRUD. Groups hang off a community; items hang off a group, so they
  // get their own top-level prefix rather than a four-segment nested path.
  api.post("/communities/:id/materi", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ title: string }>();
    return ctx.json(await c.communities.createMateri(param(ctx, "id"), userId(ctx), body), 201);
  });

  api.patch("/materi/:syllabusId", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ title?: string; sortOrder?: number }>();
    return ctx.json(await c.communities.updateMateri(param(ctx, "syllabusId"), userId(ctx), body));
  });

  api.delete("/materi/:syllabusId", requireAuth, async (ctx) => {
    await c.communities.deleteMateri(param(ctx, "syllabusId"), userId(ctx));
    return ctx.body(null, 204);
  });

  api.post("/materi/:syllabusId/items", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{
      title: string; type: string; duration?: string; uploadId?: string | null; sourceUrl?: string | null;
    }>();
    return ctx.json(await c.communities.createMateriItem(param(ctx, "syllabusId"), userId(ctx), body), 201);
  });

  api.patch("/materi-items/:itemId", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{
      title?: string; type?: string; duration?: string; sortOrder?: number;
      uploadId?: string | null; sourceUrl?: string | null;
    }>();
    return ctx.json(await c.communities.updateMateriItem(param(ctx, "itemId"), userId(ctx), body));
  });

  api.delete("/materi-items/:itemId", requireAuth, async (ctx) => {
    await c.communities.deleteMateriItem(param(ctx, "itemId"), userId(ctx));
    return ctx.body(null, 204);
  });

  // Quiz questions for a materi item of type "quiz". Options are values, not
  // entities: every write carries the full set and replaces it.
  api.get("/materi-items/:itemId/quiz", requireAuth, async (ctx) =>
    ctx.json(await c.communities.quiz(param(ctx, "itemId"), userId(ctx))));

  api.post("/materi-items/:itemId/questions", requireAuth, async (ctx) => {
    const body = await ctx.req.json();
    return ctx.json(await c.communities.createQuizQuestion(param(ctx, "itemId"), userId(ctx), body), 201);
  });

  api.patch("/quiz-questions/:questionId", requireAuth, async (ctx) => {
    const body = await ctx.req.json();
    return ctx.json(await c.communities.updateQuizQuestion(param(ctx, "questionId"), userId(ctx), body));
  });

  api.delete("/quiz-questions/:questionId", requireAuth, async (ctx) => {
    await c.communities.deleteQuizQuestion(param(ctx, "questionId"), userId(ctx));
    return ctx.body(null, 204);
  });

  api.get("/communities/:id/documents", requireAuth, async (ctx) =>
    ctx.json(await c.communities.documents_(param(ctx, "id"), userId(ctx))));

  // Publishes an existing upload into the library. Two steps on purpose: the
  // file goes through POST /uploads first, so this stays a small JSON call.
  api.post("/communities/:id/documents", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ uploadId: string; name?: string }>();
    return ctx.json(await c.uploads.addDocument(param(ctx, "id"), userId(ctx), body), 201);
  });

  api.delete("/documents/:id", requireAuth, async (ctx) =>
    ctx.json(await c.uploads.removeDocument(param(ctx, "id"), userId(ctx))));
  api.get("/communities/:id/topics", requireAuth, async (ctx) =>
    ctx.json(await c.communities.topics(param(ctx, "id"), userId(ctx))));
  // The topic name is the identifier — there is no topics table to key on.
  api.delete("/communities/:id/topics/:topic", requireAuth, async (ctx) =>
    ctx.json(await c.communities.deleteTopic(
      param(ctx, "id"), userId(ctx), decodeURIComponent(param(ctx, "topic")),
    )));

  api.patch("/communities/:id/topics/:topic", requireAuth, async (ctx) => {
    const { name } = await ctx.req.json<{ name: string }>();
    return ctx.json(await c.communities.renameTopic(
      param(ctx, "id"), userId(ctx), decodeURIComponent(param(ctx, "topic")), name,
    ));
  });

  api.get("/communities/:id/stats", requireAuth, async (ctx) =>
    ctx.json(await c.communities.creatorStats(param(ctx, "id"), userId(ctx))));

  // ----------------------------------------------------------------- posts
  api.post("/communities/:id/posts", requireAuth, async (ctx) => {
    const body = await ctx.req.json();
    return ctx.json(await c.posts.create(param(ctx, "id"), userId(ctx), body), 201);
  });

  api.get("/posts/:postId", requireAuth, async (ctx) =>
    ctx.json(await c.posts.get(param(ctx, "postId"), userId(ctx))));

  api.patch("/posts/:postId", requireAuth, async (ctx) => {
    const body = await ctx.req.json();
    return ctx.json(await c.posts.update(param(ctx, "postId"), userId(ctx), body));
  });

  api.delete("/posts/:postId", requireAuth, async (ctx) => {
    await c.posts.remove(param(ctx, "postId"), userId(ctx));
    return ctx.body(null, 204);
  });

  api.get("/posts/:postId/comments", requireAuth, async (ctx) =>
    ctx.json(await c.posts.listComments(param(ctx, "postId"), userId(ctx))));

  api.post("/posts/:postId/comments", requireAuth, async (ctx) => {
    const { body } = await ctx.req.json<{ body: string }>();
    return ctx.json(await c.posts.addComment(param(ctx, "postId"), userId(ctx), body), 201);
  });

  api.post("/comments/:commentId/like", requireAuth, async (ctx) =>
    ctx.json(await c.posts.likeComment(param(ctx, "commentId"), userId(ctx))));

  // -------------------------------------------------------------- commerce
  api.get("/communities/:id/tiers", async (ctx) =>
    ctx.json(await c.checkout.listTiers(param(ctx, "id"))));
  api.get("/payment-methods", (ctx) => ctx.json(c.checkout.paymentMethods()));

  api.post("/communities/:id/subscriptions", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ tierId: string; method: string }>();
    return ctx.json(await c.checkout.subscribe(param(ctx, "id"), userId(ctx), body), 201);
  });

  // ------------------------------------------------------------------ chat
  api.get("/conversations", requireAuth, async (ctx) => ctx.json(await c.chat.list(userId(ctx))));

  api.post("/conversations", requireAuth, async (ctx) => {
    const { peerId } = await ctx.req.json<{ peerId: string }>();
    return ctx.json(await c.chat.openDirect(userId(ctx), peerId));
  });

  api.get("/conversations/:id/messages", requireAuth, async (ctx) =>
    ctx.json(await c.chat.messagesFor(param(ctx, "id"), userId(ctx))));

  api.post("/conversations/:id/messages", requireAuth, async (ctx) => {
    const body = await ctx.req.json<{ text: string; attachmentIds?: string[] }>();
    return ctx.json(await c.chat.send(param(ctx, "id"), userId(ctx), body), 201);
  });

  api.post("/conversations/:id/read", requireAuth, async (ctx) =>
    ctx.json(await c.chat.markRead(param(ctx, "id"), userId(ctx))));

  // --------------------------------------------------------------- uploads
  api.post("/uploads", requireAuth, async (ctx) => {
    const form = await ctx.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("Field 'file' wajib ada");
    return ctx.json(await c.uploads.upload(userId(ctx), file), 201);
  });

  api.get("/uploads/:id", async (ctx) => {
    const { stream, mime, filename } = await c.uploads.streamUpload(param(ctx, "id"));
    return new Response(stream, {
      headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"` },
    });
  });

  api.get("/documents/:id/download", requireAuth, async (ctx) => {
    const { stream, mime, filename } = await c.uploads.downloadDocument(param(ctx, "id"), userId(ctx));
    return new Response(stream, {
      headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"` },
    });
  });

  // ------------------------------------------------------------------ live
  api.get("/communities/:id/live", requireAuth, async (ctx) =>
    ctx.json(await c.live.forCommunity(param(ctx, "id"), userId(ctx))));
  api.get("/communities/:id/live/chat", requireAuth, async (ctx) =>
    ctx.json(await c.live.chat(param(ctx, "id"), userId(ctx))));
  api.post("/communities/:id/live/chat", requireAuth, async (ctx) => {
    const { body } = await ctx.req.json<{ body: string }>();
    return ctx.json(await c.live.postChat(param(ctx, "id"), userId(ctx), body), 201);
  });
  /**
   * The creator's ingest credentials. A GET that can CREATE a row — deliberately:
   * a community's live room does not exist until someone asks for its key, and an
   * admin opening the panel is that ask. It mints at most once; rotation is the
   * explicit POST below, never a side effect of looking.
   */
  api.get("/communities/:id/live/stream-key", requireAuth, async (ctx) =>
    ctx.json(await c.live.streamCredentials(param(ctx, "id"), userId(ctx))));
  api.post("/communities/:id/live/stream-key/rotate", requireAuth, async (ctx) =>
    ctx.json(await c.live.rotateStreamKey(param(ctx, "id"), userId(ctx))));

  /**
   * "Still watching." The viewer count is derived from these, and from nothing
   * else — see domain/livePresence.ts.
   */
  api.post("/communities/:id/live/heartbeat", requireAuth, async (ctx) =>
    ctx.json(await c.live.heartbeat(param(ctx, "id"), userId(ctx))));

  api.post("/communities/:id/live/watch-token", requireAuth, async (ctx) =>
    ctx.json(await c.live.watchToken(param(ctx, "id"), userId(ctx))));

  // --------------------------------------------------------- notifications
  /**
   * Personal only: everything here is addressed to the token's user, and no
   * endpoint accepts a user id. `unread-count` is separate from the list because
   * the bell badge polls it every 30s and should cost one indexed COUNT.
   */
  api.get("/notifications", requireAuth, async (ctx) =>
    ctx.json(await c.notifications.list(userId(ctx), {
      unreadOnly: ctx.req.query("unreadOnly") === "true",
    })));

  api.get("/notifications/unread-count", requireAuth, async (ctx) =>
    ctx.json(await c.notifications.unreadCount(userId(ctx))));

  api.patch("/notifications/read-all", requireAuth, async (ctx) =>
    ctx.json(await c.notifications.markAllRead(userId(ctx))));

  // Declared AFTER /read-all: Hono matches in order, and ":id" would otherwise
  // swallow "read-all" as an id.
  api.patch("/notifications/:id/read", requireAuth, async (ctx) =>
    ctx.json(await c.notifications.markRead(param(ctx, "id"), userId(ctx))));

  // -------------------------------------------------------------- webhooks
  api.post("/webhooks/payment", async (ctx) => {
    const body = await ctx.req.json<{
      gatewayRef: string; status: "paid" | "failed";
      communityId: string; userId: string; tierId: string;
    }>();
    return ctx.json(await c.checkout.confirmPayment(body));
  });

  /**
   * MediaMTX's stream lifecycle. Unlike the auth call below, these ARE shell
   * (`wget`) invocations, so the secret travels as a header — see
   * infra/mediamtx.yml's runOnOnline/runOnOffline.
   *
   * Payload, captured from a real publish rather than taken from docs:
   *   {"hook":"online"|"offline","streamKey":"c/<key>"}
   */
  api.post("/webhooks/mediamtx/lifecycle", async (ctx) => {
    if (!env.MEDIAMTX_WEBHOOK_SECRET || ctx.req.header("X-Mediamtx-Secret") !== env.MEDIAMTX_WEBHOOK_SECRET) {
      return ctx.json({ error: "forbidden" }, 401);
    }
    const body = await ctx.req
      .json<{ hook?: string; streamKey?: string }>()
      .catch(() => ({} as { hook?: string; streamKey?: string }));
    return ctx.json(await c.live.handleLifecycle(body.hook ?? "", body.streamKey ?? ""));
  });

  /**
   * MediaMTX's publish/read authorisation, asked before any media flows.
   *
   * The secret says the question came from OUR MediaMTX; it says nothing about
   * whether THIS publisher may use THIS path, which is what LiveService.authorise
   * decides. Both are needed: the container is the only legitimate caller, and a
   * legitimate caller still relays whatever a stranger on :1935 asked for.
   *
   * MediaMTX cannot send headers on this call — the shared secret arrives as a
   * query parameter instead, see infra/docker-compose.yml's MTX_AUTHHTTPADDRESS.
   *
   * Payload (v1.20.0): {user, password, token, ip, action, path, protocol, id,
   * query, userAgent}. Only `action` and `path` carry a decision.
   */
  api.post("/webhooks/mediamtx/auth", async (ctx) => {
    if (!env.MEDIAMTX_WEBHOOK_SECRET || ctx.req.query("secret") !== env.MEDIAMTX_WEBHOOK_SECRET) {
      return ctx.json({ error: "forbidden" }, 401);
    }
    const body = await ctx.req.json<StreamAuthRequest>().catch(() => ({}) as StreamAuthRequest);
    const decision = await c.live.authorise(body);
    // MediaMTX reads the STATUS, not the body: any 2xx allows, anything else
    // denies. The body is for our own logs.
    return ctx.json(decision, decision.allow ? 200 : 401);
  });

  return api;
}
