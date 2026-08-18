import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";

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

  /**
   * Review round 1, I5: the route used to check `.max()` on the RAW body,
   * while the use case trims first — so exactly 1000 significant characters
   * surrounded by whitespace (1004 raw characters) was accepted by
   * `CreatePost` but rejected here. The schema now trims before measuring,
   * so both sides agree on what "1000 characters" means.
   */
  it("accepts exactly 1000 characters plus surrounding whitespace — the route and the use case must agree", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, `  ${"a".repeat(1000)}  `);
    expect(res.status).toBe(201);
    expect((await res.json()).body).toBe("a".repeat(1000));
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

  /**
   * Review round 1, M6: verified working by probe but previously unpinned —
   * this endpoint calls the same `parseBefore` as `/users/feed`, and a
   * regression here would not be caught by that route's own tests.
   */
  it("rejects a garbage ?before= with 400 — NOT a silent restart at page 1", async () => {
    const a = app();
    await tokenForValidUser(a, {});

    const res = await a.request("/users/wildan/posts?before=garbage");
    expect(res.status).toBe(400);
  });

  /**
   * Review round 1, M6: a full pagination round trip, not just "the cursor
   * points somewhere" (`post-views.test.ts`) or "the repository was asked for
   * limit + 1" (`read-posts.test.ts`) — this is the only test that drives
   * `?before=<cursor>` through a real HTTP request and confirms page 2
   * contains what page 1 promised, with no overlap and a null terminal cursor.
   */
  it("pages end to end: page 1's nextCursor fetches page 2, which is the last page", async () => {
    const a = app();
    const token = await tokenForValidUser(a, {});
    const first = await (await createPost(a, token, "post pertama")).json();
    const second = await (await createPost(a, token, "post kedua")).json();
    const third = await (await createPost(a, token, "post ketiga")).json();

    const page1Res = await a.request("/users/wildan/posts?limit=2");
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.posts.map((p: { id: string }) => p.id)).toEqual([third.id, second.id]);
    expect(page1.nextCursor === null).toBe(false);

    const page2Res = await a.request(
      `/users/wildan/posts?limit=2&before=${encodeURIComponent(page1.nextCursor)}`
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.posts.map((p: { id: string }) => p.id)).toEqual([first.id]);
    expect(page2.nextCursor === null).toBe(true);
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

  /**
   * Review round 1, I3: `not-a-uuid` used to reach `ownershipOf`, which
   * queries a uuid column directly — Postgres throws and the request 500s.
   * `validateParams` now rejects it as a 400 before any repository call, the
   * same "bad input is a 400, not a silent reinterpretation or a crash" rule
   * a malformed `?before=` already follows.
   */
  it("rejects a malformed (non-uuid) :id with 400, not a 500", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/posts/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ body: "baru" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /users/posts/:id", () => {
  /**
   * Review round 1, I3: same malformed-id guard as PATCH above, checked
   * independently since `validateParams` is applied per-route.
   */
  it("rejects a malformed (non-uuid) :id with 400, not a 500", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/posts/not-a-uuid", {
      method: "DELETE",
      headers: authed(token),
    });
    expect(res.status).toBe(400);
  });

  /**
   * Review round 1, M6: a well-formed uuid that never existed must 404 — the
   * "idempotent" ruling above is specifically about a post that DID exist
   * and was already deleted, not about an id nobody ever created.
   */
  it("404s a well-formed uuid that never existed", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/posts/aaaaaaaa-0000-4000-8000-000000000000", {
      method: "DELETE",
      headers: authed(token),
    });
    expect(res.status).toBe(404);
  });
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
 * Task 2 review round 1, C1/C2. This exercises `app.ts`'s OWN exported
 * `createApp` (via the `app()` helper above), not a locally reconstructed
 * stand-in — round 1's version of this test built its own throwaway Hono
 * instance and asserted only `/:handle/posts` and `/:handle/followers`, two
 * shapes that never collided in either mount order, so it could never go red
 * from a real `app.ts` regression. It also claimed (in both the test and a
 * code comment) that no route in either router shares a literal shape with a
 * route in the other, which is false: nothing reserves a handle
 * (`domain/handle.ts`'s pattern is `/^[a-z0-9_]{3,30}$/`, no denylist), so a
 * user can register the handle "posts" — and a path like
 * `/users/by-handle/posts` then matches BOTH `userRoutes`' literal
 * `/by-handle/:handle` (handle="posts") AND `postRoutes`' literal
 * `/:handle/posts` (handle="by-handle"); `/users/posts/follow` matches BOTH
 * `userRoutes`' `/:handle/follow` (handle="posts") AND `postRoutes`'
 * `/posts/:id` (id="follow", not a uuid — see I3 for why that no longer 500s
 * either way). Whichever router is mounted FIRST wins the ambiguous match.
 *
 * `userRoutes` must be mounted first: mounting `postRoutes` first turns a
 * handle equal to one of ITS literal segments ("posts", "feed") into a user
 * who can never view their own `/by-handle/:handle` profile and can never
 * unfollow through `DELETE /:handle/follow`. This test proves that against
 * the real, exported app rather than assuming it.
 */
describe("two routers on one prefix: userRoutes must be mounted before postRoutes", () => {
  it("a handle equal to postRoutes' own literal segment ('posts') does not shadow userRoutes' by-handle lookup or follow/unfollow", async () => {
    const a = app();
    await tokenForValidUser(a, { handle: "posts", email: "posts@example.com" });
    const otherToken = await tokenForValidUser(a, { handle: "lain", email: "lain@example.com" });

    // Must resolve userRoutes' GET /by-handle/:handle with handle="posts" —
    // NOT postRoutes' GET /:handle/posts with handle="by-handle", which
    // would 404 (no user is named "by-handle").
    const profile = await a.request("/users/by-handle/posts");
    expect(profile.status).toBe(200);
    expect((await profile.json()).handle).toBe("posts");

    // Must resolve userRoutes' POST/DELETE /:handle/follow with
    // handle="posts" — NOT postRoutes' PATCH/DELETE /posts/:id with
    // id="follow". The DELETE case is the one that used to fail: a
    // non-uuid id reaching `ownershipOf` before I3's param validation existed.
    const follow = await a.request("/users/posts/follow", {
      method: "POST",
      headers: authed(otherToken),
    });
    expect(follow.status).toBe(200);
    expect(await follow.json()).toEqual({ following: true });

    const unfollow = await a.request("/users/posts/follow", {
      method: "DELETE",
      headers: authed(otherToken),
    });
    expect(unfollow.status).toBe(200);
    expect(await unfollow.json()).toEqual({ following: false });
  });
});
