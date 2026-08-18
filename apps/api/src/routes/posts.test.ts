import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { errorHandler } from "../http/error-handler";
import type { AuthVariables } from "../http/auth.middleware";
import { userRoutes } from "./users";
import { postRoutes } from "./posts";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

const VALID = {
  handle: "wildan",
  email: "wildan@example.com",
  password: "supersecret123",
  displayName: "Wildan",
};

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Signs up (if not already) and logs in `VALID`, returning the bearer token —
 * mirrors `users.test.ts`'s `tokenForValidUser`.
 */
async function tokenForValidUser(a = app(), overrides: Partial<typeof VALID> = {}) {
  const account = { ...VALID, ...overrides };
  await a.request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  const res = await a.request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const body = await res.json();
  return body.token as string;
}

async function createPost(a: ReturnType<typeof app>, token: string, body: string) {
  return a.request("/users/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify({ body }),
  });
}

describe("POST /users/posts", () => {
  it("requires auth — no Authorization header is a 401", async () => {
    const res = await app().request("/users/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "halo" }),
    });
    expect(res.status).toBe(401);
  });

  it("201s for a signed-in caller, with EXACTLY the wire keys", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "halo dunia");
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["author", "body", "createdAt", "editedAt", "id"]);
    expect(Object.keys(body.author).sort()).toEqual(["displayName", "handle"]);
    expect(body.body).toBe("halo dunia");
    expect(body.editedAt === null).toBe(true);
    expect(body.author.handle).toBe("wildan");
  });

  it("rejects an empty body with 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "");
    expect(res.status).toBe(400);
  });

  it("rejects a body over 1000 characters with 400 — LITERAL 1001", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "a".repeat(1001));
    expect(res.status).toBe(400);
  });

  it("accepts a body of exactly 1000 characters", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "a".repeat(1000));
    expect(res.status).toBe(201);
  });
});

describe("GET /users/feed", () => {
  it("tab=untuk-anda with NO Authorization header is 200 — the whole reason the split exists (§5.1)", async () => {
    const res = await app().request("/users/feed?tab=untuk-anda");
    expect(res.status).toBe(200);
  });

  it("tab=mengikuti with NO Authorization header is 401", async () => {
    const res = await app().request("/users/feed?tab=mengikuti");
    expect(res.status).toBe(401);
  });

  it("tab=mengikuti WITH a session is 200", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/feed?tab=mengikuti", { headers: authed(token) });
    expect(res.status).toBe(200);
  });

  it("defaults to tab=untuk-anda when tab is omitted — no header needed", async () => {
    const res = await app().request("/users/feed");
    expect(res.status).toBe(200);
  });

  it("rejects an unrecognised tab with 400", async () => {
    const res = await app().request("/users/feed?tab=nonsense");
    expect(res.status).toBe(400);
  });

  it("rejects a garbage ?before= with 400 — NOT a silent restart at page 1", async () => {
    const res = await app().request("/users/feed?before=garbage");
    expect(res.status).toBe(400);
  });

  it("rejects ?limit=999 with 400 — the cap is a refusal, not a silent clamp (LITERAL 50)", async () => {
    const res = await app().request("/users/feed?limit=999");
    expect(res.status).toBe(400);
  });

  it("accepts the maximum allowed ?limit=50", async () => {
    const res = await app().request("/users/feed?limit=50");
    expect(res.status).toBe(200);
  });

  it("untuk-anda shows every author's posts, newest first", async () => {
    const a = app();
    const wildanToken = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    await createPost(a, wildanToken, "post pertama wildan");
    await createPost(a, rinaToken, "post pertama rina");

    const res = await a.request("/users/feed?tab=untuk-anda");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts).toHaveLength(2);
    // Newest first: rina's post was created after wildan's.
    expect(body.posts[0].body).toBe("post pertama rina");
    expect(body.posts[1].body).toBe("post pertama wildan");
  });

  it("mengikuti shows only posts by authors the viewer follows, and excludes the viewer's own", async () => {
    const a = app();
    const wildanToken = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const budiToken = await tokenForValidUser(a, { handle: "budi", email: "budi@example.com" });

    await createPost(a, wildanToken, "wildan's own post");
    await createPost(a, rinaToken, "rina's post, followed");
    await createPost(a, budiToken, "budi's post, not followed");

    await a.request("/users/rina/follow", { method: "POST", headers: authed(wildanToken) });

    const res = await a.request("/users/feed?tab=mengikuti", { headers: authed(wildanToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].body).toBe("rina's post, followed");
  });
});

describe("GET /users/:handle/posts", () => {
  it("200s for an unauthenticated caller, author-scoped", async () => {
    const a = app();
    const wildanToken = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    await createPost(a, wildanToken, "wildan's post");
    await createPost(a, rinaToken, "rina's post");

    const res = await a.request("/users/wildan/posts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].body).toBe("wildan's post");
  });

  it("404s an unknown handle", async () => {
    const res = await app().request("/users/tidak-ada/posts");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /users/posts/:id", () => {
  it("200s and sets editedAt when the author edits their own post", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const created = await (await createPost(a, token, "sebelum diedit")).json();

    const res = await a.request(`/users/posts/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ body: "sesudah diedit" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("sesudah diedit");
    expect(body.editedAt === null).toBe(false);
  });

  it("403s — asserted as a STATUS CODE — when another user edits it, and does not change the body", async () => {
    const a = app();
    const authorToken = await tokenForValidUser(a, {});
    const strangerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const created = await (await createPost(a, authorToken, "kiriman asli")).json();

    const res = await a.request(`/users/posts/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(strangerToken) },
      body: JSON.stringify({ body: "diubah paksa" }),
    });
    expect(res.status).toBe(403);

    const confirm = await (await a.request("/users/wildan/posts")).json();
    expect(confirm.posts[0].body).toBe("kiriman asli");
  });

  it("requires auth — no Authorization header is a 401", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const created = await (await createPost(a, token, "kiriman")).json();

    const res = await a.request(`/users/posts/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "baru" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /users/posts/:id", () => {
  it("403s — asserted as a STATUS CODE — when another user deletes it", async () => {
    const a = app();
    const authorToken = await tokenForValidUser(a, {});
    const strangerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const created = await (await createPost(a, authorToken, "punya wildan")).json();

    const res = await a.request(`/users/posts/${created.id}`, {
      method: "DELETE",
      headers: authed(strangerToken),
    });
    expect(res.status).toBe(403);
  });

  it("200s both times when the author deletes their own post twice — idempotent", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const created = await (await createPost(a, token, "akan dihapus")).json();

    const first = await a.request(`/users/posts/${created.id}`, {
      method: "DELETE",
      headers: authed(token),
    });
    expect(first.status).toBe(200);

    const second = await a.request(`/users/posts/${created.id}`, {
      method: "DELETE",
      headers: authed(token),
    });
    expect(second.status).toBe(200);
  });

  it("a deleted post is absent from GET /users/feed?tab=untuk-anda AND from GET /users/:handle/posts", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const kept = await (await createPost(a, token, "tetap ada")).json();
    const removed = await (await createPost(a, token, "akan dihapus")).json();

    const del = await a.request(`/users/posts/${removed.id}`, {
      method: "DELETE",
      headers: authed(token),
    });
    expect(del.status).toBe(200);

    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();
    expect(feed.posts.map((p: { id: string }) => p.id)).not.toContain(removed.id);
    expect(feed.posts.map((p: { id: string }) => p.id)).toContain(kept.id);

    const authorPosts = await (await a.request("/users/wildan/posts")).json();
    expect(authorPosts.posts.map((p: { id: string }) => p.id)).not.toContain(removed.id);
    expect(authorPosts.posts.map((p: { id: string }) => p.id)).toContain(kept.id);
  });

  it("requires auth — no Authorization header is a 401", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const created = await (await createPost(a, token, "kiriman")).json();

    const res = await a.request(`/users/posts/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

/**
 * Task 2's step 8: `routes/posts.ts` and `routes/users.ts` are TWO Hono
 * sub-apps mounted at the SAME `/users` prefix (`app.ts`). A literal segment
 * one router owns (`/posts`, `/feed` here; `/signup`, `/me`, `/explore` there)
 * must never be shadowed by the other router's `:handle`/`:id` param, in
 * EITHER mount order — this is what proves that rather than assumes it, by
 * actually swapping the two lines against a throwaway app built the same way
 * `app.ts` builds the real one.
 */
describe("two routers on one prefix: /users/:handle/posts and /users/:handle/followers both resolve, regardless of mount order", () => {
  async function seedWildanWithOnePostAndOneFollower() {
    const deps = bootstrap();
    const a = createApp(deps);
    const wildanToken = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await createPost(a, wildanToken, "halo dari wildan");
    await a.request("/users/wildan/follow", { method: "POST", headers: authed(rinaToken) });
    return a;
  }

  it("resolves both in the real app's actual mount order (posts, then users)", async () => {
    const a = await seedWildanWithOnePostAndOneFollower();

    const posts = await a.request("/users/wildan/posts");
    expect(posts.status).toBe(200);
    expect((await posts.json()).posts).toHaveLength(1);

    const followers = await a.request("/users/wildan/followers");
    expect(followers.status).toBe(200);
    expect(await followers.json()).toHaveLength(1);
  });

  it("resolves both with the mount order SWAPPED (users, then posts) — proves the order is not load-bearing", async () => {
    const deps = bootstrap();
    const swapped = new Hono<{ Variables: AuthVariables }>();
    swapped.onError(errorHandler);
    // Deliberately the OPPOSITE order from app.ts's real
    // `app.route("/users", postRoutes(deps)); app.route("/users", userRoutes(deps));`.
    swapped.route("/users", userRoutes(deps));
    swapped.route("/users", postRoutes(deps));

    const wildanToken = await tokenForValidUser(swapped, {});
    const rinaToken = await tokenForValidUser(swapped, { handle: "rina", email: "rina@example.com" });
    await createPost(swapped, wildanToken, "halo dari wildan");
    await swapped.request("/users/wildan/follow", { method: "POST", headers: authed(rinaToken) });

    const posts = await swapped.request("/users/wildan/posts");
    expect(posts.status).toBe(200);
    expect((await posts.json()).posts).toHaveLength(1);

    const followers = await swapped.request("/users/wildan/followers");
    expect(followers.status).toBe(200);
    expect(await followers.json()).toHaveLength(1);
  });
});
