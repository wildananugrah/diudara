import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { db } from "../db/client";
import { appUsers, posts as postsTable, userSubscriptions, userTiers } from "../db/schema";
import { eq } from "drizzle-orm";
import { DrizzleMediaRepository } from "../infrastructure/repositories/drizzle-media.repository";

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

/**
 * A user holding a handle that `RegisterUser` now REFUSES.
 *
 * Signs up under a legal handle and rewrites the column afterwards, so only
 * the registration-time rule is bypassed — the row, the password hash and the
 * token are all the real thing, and the token is keyed on the user's id, so
 * renaming does not invalidate it.
 *
 * This exists because the routing test below must keep testing ROUTING. See
 * its docstring for why reserving the handle does not retire it.
 */
async function tokenForUserHoldingReservedHandle(
  a: ReturnType<typeof app>,
  handle: string,
  email: string
) {
  const placeholder = `held_${handle}`;
  const token = await tokenForValidUser(a, { handle: placeholder, email });
  await db.update(appUsers).set({ handle }).where(eq(appUsers.handle, placeholder));
  return token;
}

async function createPost(
  a: ReturnType<typeof app>,
  token: string,
  body: string,
  mediaIds?: string[]
) {
  return a.request("/users/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authed(token) },
    // `mediaIds` is OMITTED, not sent as undefined, when the caller passes
    // nothing — an absent key is what a text-only client sends, and PATCH
    // treats absent and empty differently (see its own tests below).
    body: JSON.stringify(mediaIds === undefined ? { body } : { body, mediaIds }),
  });
}

async function patchPost(
  a: ReturnType<typeof app>,
  token: string,
  id: string,
  payload: { body: string; mediaIds?: string[] }
) {
  return a.request(`/users/posts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify(payload),
  });
}

/**
 * Uploads `small.png` through the real `POST /users/media` and returns the new
 * media id. Written locally rather than imported from `media.test.ts` — no
 * test file in this codebase imports helpers from another.
 */
async function uploadFixture(a: ReturnType<typeof app>, token: string): Promise<string> {
  const bytes = await Bun.file(`${import.meta.dir}/../test-support/fixtures/small.png`).bytes();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), "small.png");

  const res = await a.request("/users/media", {
    method: "POST",
    headers: authed(token),
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

/**
 * A repository over the SAME database the app is using. Route tests build the
 * app through `bootstrap()`, which constructs its own storage adapter and its
 * own repositories that no test holds a handle on — the database is the one
 * place both sides meet, so it is where "the row survived, unclaimed" is
 * asserted. The bytes-survive half of that rule lives in
 * `write-post.test.ts`, where the fake storage adapter can be injected.
 */
function mediaRepo() {
  return new DrizzleMediaRepository(db);
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
    expect(Object.keys(body).sort()).toEqual([
      "author",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "lockedMediaCount",
      "media",
      "membersOnly",
    ]);
    expect(body.media).toEqual([]);
    // The author of a brand-new public post: nothing is gated and nothing is
    // hidden — the create response never locks, because it answers the author.
    expect(body.membersOnly).toBe(false);
    expect(body.lockedMediaCount).toBe(0);
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
 * route in the other, which is false: a user could hold the handle "posts" —
 * and a path like
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
 *
 * **`RESERVED_HANDLES` does not retire this test, and the handle is now
 * planted rather than registered.** Reserving the five colliding handles shuts
 * the registration door; it does not make the router correct. The two are
 * independent layers and this one is the one that decides what a request
 * RESOLVES to: the denylist can fall behind a newly added literal route (the
 * guard in `users.test.ts` catches that, but only after someone runs it), and
 * a row can reach `app_user` by a path that never passes `RegisterUser` at all
 * — an import, a support fix, a future admin tool. If the mount order were
 * swapped, every one of those users would be silently unreachable. So the
 * handle is written straight to the column here, and the routing property
 * stays pinned exactly as it was.
 */
describe("two routers on one prefix: userRoutes must be mounted before postRoutes", () => {
  it("a handle equal to postRoutes' own literal segment ('posts') does not shadow userRoutes' by-handle lookup or follow/unfollow", async () => {
    const a = app();
    await tokenForUserHoldingReservedHandle(a, "posts", "posts@example.com");
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

/**
 * Phase 4, Task 6 — spec §5.2, §5.3, §8 and §11.
 *
 * `mediaIds` is the COMPLETE desired list on both verbs, never a delta: the
 * client sends the images the post should hold when the request finishes, in
 * order.
 */
/**
 * Six syntactically-valid uuids, none of which need to exist, for asserting
 * the REFUSAL MESSAGE only: `.max()` on `mediaIds` runs inside
 * `validate(postBodySchema)` and reports one issue per parse regardless of
 * what the ids are, so a too-long array 400s with the schema's message
 * before ownership is ever checked.
 */
const SIX_MEDIA_IDS = Array.from(
  { length: 6 },
  (_, i) => `aaaaaaaa-0000-4000-8000-00000000000${i}`
);

/** Uploads `n` real, owned, unclaimed media ids — see its own callers for why real ids matter here. */
async function uploadFixtures(a: ReturnType<typeof app>, token: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await uploadFixture(a, token));
  return ids;
}

describe("Task 7: MAX_POST_IMAGES", () => {
  /**
   * Six ids that are ALL real, owned by the caller, and unclaimed — so
   * nothing but the count itself can produce a 400 here. Fake/unowned ids
   * would already 400 on ownership grounds even with no cap at all, which
   * would make this test pass for the wrong reason (measured: it does,
   * against `SIX_MEDIA_IDS` below, before the cap existed).
   */
  it("POST /users/posts: a post carrying more than the maximum images is a 400 — LITERAL 6 over a default limit of 5", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const sixOwnedIds = await uploadFixtures(a, token, 6);

    const res = await createPost(a, token, "banyak foto", sixOwnedIds);

    expect(res.status).toBe(400);
  });

  it("POST /users/posts: the refusal names the limit, in Bahasa — LITERAL 5", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "banyak foto", SIX_MEDIA_IDS);

    expect((await res.json()).error).toContain("maksimal 5 foto");
  });

  /**
   * Task 6 wired `mediaIds` into `PATCH` too, and the brief is explicit: an
   * edit that can add a sixth image while create refuses one would be the
   * obvious hole. Same schema, same route-level `.max()`, so this must 400
   * the same way create does — never reaching `editPost`. Real, owned,
   * unclaimed ids again, for the same reason as the create test above.
   */
  it("PATCH /users/posts/:id: an edit carrying more than the maximum images is ALSO a 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [id])).json();
    const sixOwnedIds = await uploadFixtures(a, token, 6);

    const res = await patchPost(a, token, post.id, { body: "halo lagi", mediaIds: sixOwnedIds });

    expect(res.status).toBe(400);
  });
});

describe("media on posts", () => {
  it("attaches media to a new post, in the order given", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const first = await uploadFixture(a, token);
    const second = await uploadFixture(a, token);

    const res = await createPost(a, token, "dua foto", [second, first]);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.media.map((image: { id: string }) => image.id)).toEqual([second, first]);
  });

  /**
   * The projection is closed on BOTH levels. A media entry carrying a bucket
   * key, a URL, `ownerId` or `postId` would hand a client either a path into
   * storage or a fact about who uploaded what.
   */
  it("keeps the projection closed — the post's keys and each image's keys", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);

    const post = await (await createPost(a, token, "satu foto", [id])).json();

    expect(Object.keys(post).sort()).toEqual([
      "author",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "lockedMediaCount",
      "media",
      "membersOnly",
    ]);
    expect(post.media).toHaveLength(1);
    expect(Object.keys(post.media[0]).sort()).toEqual(["height", "id", "width"]);
    expect(post.media[0].id).toBe(id);
    expect(post.media[0].width).toBeGreaterThan(0);
    expect(post.media[0].height).toBeGreaterThan(0);
  });

  /**
   * **The same closed projection, on the three responses nothing was asserting.**
   * Final whole-branch review, Minor 2: mutation-testing `toMediaView` reddened
   * exactly three tests — the view's own, `ListFeed`'s, and the create response
   * — while `GET /users/feed`, `GET /users/:handle/posts` and the `PATCH`
   * response asserted nothing about the key set at all. Safe today because
   * every one of them funnels through `toPostView`, and blind to a decoration
   * added at the route layer, which is precisely the shape a bucket key would
   * arrive in.
   */
  it("keeps the projection closed on the feed, a profile's posts, and a PATCH", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    const created = await (await createPost(a, token, "satu foto", [id])).json();

    const patched = await (
      await a.request(`/users/posts/${created.id}`, {
        method: "PATCH",
        headers: { ...authed(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "satu foto, diedit", mediaIds: [id] }),
      })
    ).json();
    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();
    const profile = await (await a.request(`/users/${VALID.handle}/posts`)).json();

    const POST_KEYS = [
      "author",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "lockedMediaCount",
      "media",
      "membersOnly",
    ];
    const MEDIA_KEYS = ["height", "id", "width"];
    for (const post of [patched, feed.posts[0], profile.posts[0]]) {
      expect(Object.keys(post).sort()).toEqual(POST_KEYS);
      expect(post.media).toHaveLength(1);
      expect(Object.keys(post.media[0]).sort()).toEqual(MEDIA_KEYS);
    }
  });

  it("refuses media that belongs to someone else — 400, and no post is created", async () => {
    const a = app();
    const token = await tokenForValidUser(a, {});
    const otherToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const theirs = await uploadFixture(a, otherToken);

    const res = await createPost(a, token, "halo", [theirs]);

    expect(res.status).toBe(400);
    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();
    expect(feed.posts).toHaveLength(0);
  });

  it("refuses a media id that has never existed — 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createPost(a, token, "halo", ["aaaaaaaa-0000-4000-8000-000000000000"]);

    expect(res.status).toBe(400);
  });

  /**
   * Review round 1, M2. An UNKNOWN id and SOMEONE ELSE'S id must come back
   * byte-identical, and nothing but this test defends that. Media ids are
   * handed out only to their uploader, so a distinct "foto tidak ditemukan"
   * would let anyone probe whether a uuid is a real image — an existence
   * oracle for other people's uploads, which is the defect class Phase 2's
   * review already found in signup, where a taken handle's 409 revealed
   * whether the accompanying email was registered.
   *
   * The two messages are asserted verbatim, per this repo's rule (never
   * against the constant they are checked against), and then against each
   * other — splitting them reddens this test by name rather than passing
   * quietly.
   */
  it("an unknown media id and someone else's return the SAME message — no existence oracle", async () => {
    const a = app();
    const token = await tokenForValidUser(a, {});
    const otherToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const theirs = await uploadFixture(a, otherToken);

    const unknown = await createPost(a, token, "halo", [
      "aaaaaaaa-0000-4000-8000-000000000000",
    ]);
    const notMine = await createPost(a, token, "halo", [theirs]);

    expect(unknown.status).toBe(400);
    expect(notMine.status).toBe(400);
    const unknownBody = await unknown.json();
    const notMineBody = await notMine.json();
    expect(unknownBody.error).toBe("foto tidak ditemukan atau bukan milik Anda");
    expect(notMineBody.error).toBe("foto tidak ditemukan atau bukan milik Anda");
    expect(unknownBody.error).toBe(notMineBody.error);
  });

  /**
   * The other two refusals are distinguishable on purpose — an id that is
   * yours but already on another post, and the same id twice, are both things
   * the composer can put right, so their copy says what happened. Asserted
   * verbatim, and asserted as DIFFERENT from the not-yours message above, so
   * collapsing all three into one generic string is a red test too.
   */
  it("says something different, in Bahasa, when the photo is on another post or listed twice", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    await createPost(a, token, "kiriman pertama", [id]);
    const spare = await uploadFixture(a, token);

    const taken = await createPost(a, token, "kiriman kedua", [id]);
    const duplicated = await createPost(a, token, "kiriman ketiga", [spare, spare]);

    expect(taken.status).toBe(400);
    expect(duplicated.status).toBe(400);
    expect((await taken.json()).error).toBe("foto sudah dipakai kiriman lain");
    expect((await duplicated.json()).error).toBe("foto yang sama tidak boleh dipakai dua kali");
  });

  it("refuses media already claimed by a DIFFERENT post — 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    await createPost(a, token, "kiriman pertama", [id]);

    const res = await createPost(a, token, "kiriman kedua", [id]);

    expect(res.status).toBe(400);
  });

  /**
   * The ONE clause that separates PATCH from POST (§5.2). Without it every
   * edit would reject its own images.
   */
  it("an edit may keep the post's OWN existing media", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [id])).json();

    const res = await patchPost(a, token, post.id, { body: "halo lagi", mediaIds: [id] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.media.map((image: { id: string }) => image.id)).toEqual([id]);
    expect(body.body).toBe("halo lagi");
  });

  it("an edit may add an image alongside the one already there", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const first = await uploadFixture(a, token);
    const second = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [first])).json();

    const res = await patchPost(a, token, post.id, {
      body: "halo",
      mediaIds: [first, second],
    });

    expect(res.status).toBe(200);
    expect((await res.json()).media.map((image: { id: string }) => image.id)).toEqual([
      first,
      second,
    ]);
  });

  /**
   * §8: removal sets `post_id` back to null and the worker's sweep collects
   * the row later. Asserting only that the post no longer shows the image
   * would pass just as well against an implementation that deleted the bytes
   * on the spot, so the row's own state is what is checked — through a
   * repository over the same database, since the app's instances are not
   * reachable from here.
   */
  it("removing an image UNCLAIMS it rather than deleting it", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const first = await uploadFixture(a, token);
    const second = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "dua foto", [first, second])).json();

    const res = await patchPost(a, token, post.id, { body: "dua foto", mediaIds: [first] });

    expect(res.status).toBe(200);
    expect((await res.json()).media.map((image: { id: string }) => image.id)).toEqual([first]);
    expect(await mediaRepo().findById(second)).toMatchObject({ postId: null });
    expect(await mediaRepo().findById(first)).toMatchObject({ postId: post.id });
  });

  it("an explicit empty mediaIds strips every image, unclaiming each row", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [id])).json();

    const res = await patchPost(a, token, post.id, { body: "halo", mediaIds: [] });

    expect(res.status).toBe(200);
    expect((await res.json()).media).toEqual([]);
    expect(await mediaRepo().findById(id)).toMatchObject({ postId: null });
  });

  /**
   * An OMITTED `mediaIds` says nothing about images — it is a text-only edit,
   * which is exactly what every PATCH in this file above sends. It must not
   * silently strip the post's photos.
   */
  it("a PATCH without mediaIds leaves the post's images alone", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const id = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [id])).json();

    const res = await patchPost(a, token, post.id, { body: "teks baru saja" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("teks baru saja");
    expect(body.media.map((image: { id: string }) => image.id)).toEqual([id]);
  });

  /** §5.3: what a reader saw is not what they would see now. */
  it("an image-only change still sets editedAt", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const first = await uploadFixture(a, token);
    const second = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "halo", [first])).json();
    expect(post.editedAt === null).toBe(true);

    const res = await patchPost(a, token, post.id, { body: "halo", mediaIds: [second] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("halo");
    expect(body.editedAt === null).toBe(false);
  });

  /**
   * Task 1's review left this deferred: nothing exercised `claim()` across two
   * posts, so a widened `WHERE` on its release step could unclaim ANOTHER
   * post's media with the suite still green. Both posts belong to the same
   * author here, so the only thing standing between them is the release
   * clause's `post_id = $1` — no ownership check would catch a bug in it.
   */
  it("editing one post never disturbs another post's media", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const [a1, a2, b1, b2] = [
      await uploadFixture(a, token),
      await uploadFixture(a, token),
      await uploadFixture(a, token),
      await uploadFixture(a, token),
    ];
    const postA = await (await createPost(a, token, "kiriman A", [a1, a2])).json();
    const postB = await (await createPost(a, token, "kiriman B", [b1, b2])).json();

    const res = await patchPost(a, token, postA.id, { body: "kiriman A", mediaIds: [a1] });
    expect(res.status).toBe(200);

    const repo = mediaRepo();
    expect((await repo.listForPost(postB.id)).map((row) => row.id)).toEqual([b1, b2]);
    expect(await repo.findById(a2)).toMatchObject({ postId: null });

    const authorPage = await (await a.request("/users/wildan/posts")).json();
    const shown = authorPage.posts.find((p: { id: string }) => p.id === postB.id);
    expect(shown.media.map((image: { id: string }) => image.id)).toEqual([b1, b2]);
  });

  /**
   * §11: an edit must be proven not to STEAL — specifically not from another
   * person's post. The refusal and the victim's post being untouched are both
   * asserted, because a check that rejected the request after already
   * unclaiming would satisfy only the first.
   */
  it("an edit cannot steal media out of another PERSON'S post", async () => {
    const a = app();
    const token = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const hers = await uploadFixture(a, rinaToken);
    const herPost = await (await createPost(a, rinaToken, "foto rina", [hers])).json();
    const mine = await (await createPost(a, token, "kiriman saya")).json();

    const res = await patchPost(a, token, mine.id, { body: "kiriman saya", mediaIds: [hers] });

    expect(res.status).toBe(400);
    expect(await mediaRepo().findById(hers)).toMatchObject({ postId: herPost.id });
    const rinaPage = await (await a.request("/users/rina/posts")).json();
    expect(rinaPage.posts[0].media.map((image: { id: string }) => image.id)).toEqual([hers]);
  });

  it("media reach the feed too, each post with its own images in order", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const [first, second, third] = [
      await uploadFixture(a, token),
      await uploadFixture(a, token),
      await uploadFixture(a, token),
    ];
    const withImages = await (await createPost(a, token, "berfoto", [second, first])).json();
    const withoutImages = await (await createPost(a, token, "tanpa foto")).json();
    const withOne = await (await createPost(a, token, "satu foto", [third])).json();

    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();

    const byId = new Map(
      feed.posts.map((post: { id: string; media: { id: string }[] }) => [
        post.id,
        post.media.map((image) => image.id),
      ])
    );
    expect(byId.get(withImages.id)).toEqual([second, first]);
    expect(byId.get(withoutImages.id)).toEqual([]);
    expect(byId.get(withOne.id)).toEqual([third]);
  });
});

/**
 * **BARRIER ONE, end to end through the real wiring** — `bootstrap()`'s own
 * `DrizzleUserSubscriptionRepository` and its one `SystemClock`, not a fake.
 * The use-case tests in `read-posts.test.ts` prove the gate's logic against a
 * fake that mirrors the query's predicate; these prove the composition root
 * actually handed that dependency over and that BOTH read routes resolve a
 * viewer to answer it for.
 *
 * The write path does not accept `visibility` yet — Task 5 of this phase adds
 * it — so a gated post is made by writing the column directly, the same
 * technique the reserved-handle helper above uses to reach a state the current
 * write path will not produce.
 */
describe("members-only posts: the projection never sends a media id to a non-member", () => {
  const RINA = { handle: "rina", email: "rina@example.com", displayName: "Rina" };
  const BUYER = { handle: "andi", email: "andi@example.com", displayName: "Andi" };

  async function userIdFor(handle: string): Promise<string> {
    const [row] = await db.select().from(appUsers).where(eq(appUsers.handle, handle));
    return row!.id;
  }

  /** Makes an existing post members-only. */
  async function gate(postId: string): Promise<void> {
    await db.update(postsTable).set({ visibility: "members" }).where(eq(postsTable.id, postId));
  }

  /**
   * A real membership row for (subscriber → owner), ending at `periodEnd`. A
   * tier comes first because `user_subscription_tier_owner_fk` makes a
   * subscription whose owner disagrees with its tier's owner impossible to
   * insert.
   */
  async function grantMembership(
    subscriberId: string,
    ownerId: string,
    periodEnd: Date
  ): Promise<void> {
    const [tier] = await db
      .insert(userTiers)
      .values({ ownerId, name: "Anggota", priceAmount: 50000, billingCycle: "monthly" })
      .returning();
    await db.insert(userSubscriptions).values({
      subscriberId,
      tierId: tier!.id,
      ownerId,
      status: "active",
      currentPeriodEnd: periodEnd,
    });
  }

  const IN_A_MONTH = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const YESTERDAY = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  /** Rina, one gated post with one image. Returns her token and the post id. */
  async function rinaWithAGatedPost(a: ReturnType<typeof app>) {
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await uploadFixture(a, token);
    const post = await (await createPost(a, token, "Behind the scenes", [mediaId])).json();
    await gate(post.id);
    return { token, postId: post.id as string, mediaId };
  }

  it("a signed-out reader gets the caption and NO media, on the feed and on the profile", async () => {
    const a = app();
    await rinaWithAGatedPost(a);

    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();
    const profile = await (await a.request("/users/rina/posts")).json();

    for (const post of [feed.posts[0], profile.posts[0]]) {
      expect(post.body).toBe("Behind the scenes");
      expect(post.media).toEqual([]);
      expect(post.membersOnly).toBe(true);
      expect(post.lockedMediaCount).toBe(1);
    }
  });

  /**
   * The closed projection in its LOCKED shape, at the route. A spot-check on
   * `media` alone passes against a response that leaked the id under some
   * other key, which is the entire failure mode of this phase (spec §10).
   */
  it("a locked response carries the same closed key set as an unlocked one", async () => {
    const a = app();
    const { token } = await rinaWithAGatedPost(a);

    const locked = (await (await a.request("/users/rina/posts")).json()).posts[0];
    const unlocked = (
      await (await a.request("/users/rina/posts", { headers: authed(token) })).json()
    ).posts[0];

    const POST_KEYS = [
      "author",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "lockedMediaCount",
      "media",
      "membersOnly",
    ];
    expect(Object.keys(locked).sort()).toEqual(POST_KEYS);
    expect(Object.keys(unlocked).sort()).toEqual(POST_KEYS);
  });

  it("no media id survives anywhere in a locked response", async () => {
    const a = app();
    const { mediaId } = await rinaWithAGatedPost(a);

    const body = await (await a.request("/users/feed?tab=untuk-anda")).text();

    expect(body).not.toContain(mediaId);
  });

  it("the AUTHOR always gets their own media back, on the feed and on the profile", async () => {
    const a = app();
    const { token, mediaId } = await rinaWithAGatedPost(a);

    const feed = await (
      await a.request("/users/feed?tab=untuk-anda", { headers: authed(token) })
    ).json();
    const profile = await (
      await a.request("/users/rina/posts", { headers: authed(token) })
    ).json();

    for (const post of [feed.posts[0], profile.posts[0]]) {
      expect(post.media.map((image: { id: string }) => image.id)).toEqual([mediaId]);
      expect(post.membersOnly).toBe(true);
      expect(post.lockedMediaCount).toBe(0);
    }
  });

  it("a signed-in reader who pays for nobody is locked out", async () => {
    const a = app();
    await rinaWithAGatedPost(a);
    const buyerToken = await tokenForValidUser(a, BUYER);

    const feed = await (
      await a.request("/users/feed?tab=untuk-anda", { headers: authed(buyerToken) })
    ).json();

    expect(feed.posts[0].media).toEqual([]);
    expect(feed.posts[0].lockedMediaCount).toBe(1);
  });

  it("a paying member gets the media", async () => {
    const a = app();
    const { mediaId } = await rinaWithAGatedPost(a);
    const buyerToken = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    const feed = await (
      await a.request("/users/feed?tab=untuk-anda", { headers: authed(buyerToken) })
    ).json();
    const profile = await (
      await a.request("/users/rina/posts", { headers: authed(buyerToken) })
    ).json();

    for (const post of [feed.posts[0], profile.posts[0]]) {
      expect(post.media.map((image: { id: string }) => image.id)).toEqual([mediaId]);
      expect(post.lockedMediaCount).toBe(0);
    }
  });

  /**
   * The row still reads `status = 'active'` — nothing has retired it, and 5b's
   * sweep may not run for hours (its §9). A status-only check would hand this
   * person every gated image they have stopped paying for.
   */
  it("a LAPSED member does NOT get the media — their period ended", async () => {
    const a = app();
    await rinaWithAGatedPost(a);
    const buyerToken = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), YESTERDAY());

    const feed = await (
      await a.request("/users/feed?tab=untuk-anda", { headers: authed(buyerToken) })
    ).json();

    expect(feed.posts[0].media).toEqual([]);
    expect(feed.posts[0].lockedMediaCount).toBe(1);
  });

  /**
   * A membership buys that creator's gated posts and nothing else. Paying Rina
   * must not unlock Budi — the gate answers per AUTHOR, and a set keyed on the
   * viewer alone would be exactly this bug.
   */
  it("paying one creator does not unlock another creator's gated post", async () => {
    const a = app();
    await rinaWithAGatedPost(a);
    const budiToken = await tokenForValidUser(a, VALID);
    const budiMedia = await uploadFixture(a, budiToken);
    const budiPost = await (await createPost(a, budiToken, "punya budi", [budiMedia])).json();
    await gate(budiPost.id);
    const buyerToken = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    const feed = await (
      await a.request("/users/feed?tab=untuk-anda", { headers: authed(buyerToken) })
    ).json();

    const byId = new Map(
      feed.posts.map((post: { id: string; media: { id: string }[] }) => [
        post.id,
        post.media.map((image) => image.id),
      ])
    );
    expect(byId.get(budiPost.id)).toEqual([]);
  });

  it("a public post is unaffected — media, membersOnly false, nothing hidden", async () => {
    const a = app();
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await uploadFixture(a, token);
    await createPost(a, token, "terbuka", [mediaId]);

    const feed = await (await a.request("/users/feed?tab=untuk-anda")).json();

    expect(feed.posts[0].media.map((image: { id: string }) => image.id)).toEqual([mediaId]);
    expect(feed.posts[0].membersOnly).toBe(false);
    expect(feed.posts[0].lockedMediaCount).toBe(0);
  });
});
