import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { db } from "../db/client";
import { appUsers, posts as postsTable, userSubscriptions, userTiers } from "../db/schema";

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

/** Mirrors `posts.test.ts`'s `tokenForValidUser`. */
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

const fixture = (name: string) =>
  Bun.file(`${import.meta.dir}/../test-support/fixtures/${name}`).bytes();

describe("POST /users/media", () => {
  it("accepts a multipart upload and returns id, width and height", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const form = new FormData();
    form.append("file", new Blob([await fixture("small.png")], { type: "image/png" }), "small.png");

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["height", "id", "width"]);
    expect(typeof body.id).toBe("string");
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
  });

  it("requires auth", async () => {
    const a = app();
    const res = await a.request("/users/media", { method: "POST", body: new FormData() });
    expect(res.status).toBe(401);
  });

  it("rejects a text file with 400 and Bahasa copy naming the working formats", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const form = new FormData();
    // The lie in `type` below is deliberate: the file's own header decides
    // its format, not the client-supplied Content-Type.
    form.append("file", new Blob([await fixture("not-an-image.txt")], { type: "image/png" }), "x.png");

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    // Literal, per this repo's own rule: assert the text, never the constant
    // it is checked against — `image.ts`'s own message, reused rather than
    // duplicated by this route.
    expect(body.error).toBe("Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.");
  });

  it("rejects a request with no file field", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const form = new FormData();

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });

    expect(res.status).toBe(400);
  });

  /**
   * **EVERY refusal this route can answer with carries a machine-readable
   * `code`, and the client BRANCHES on it.**
   *
   * Final whole-branch review. The web's upload copy used to infer the reason
   * from the bare status — "any 400 from this route is an unsupported format" —
   * which held only while there were three 400s and two of them were
   * unreachable. The pixel bound below is a fourth. Without a code, a 45
   * MEGAPIXEL photo is described to its owner as "foto iPhone (HEIC) belum
   * didukung", which is confidently wrong rather than merely vague.
   *
   * The codes are asserted as LITERALS, never as `UPLOAD_ERROR_CODE.x`, because
   * they are a wire contract: renaming the constant must not be able to change
   * what goes over the wire without reddening something.
   */
  it("labels an unsupported format with a machine-readable code", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const form = new FormData();
    form.append("file", new Blob([await fixture("not-an-image.txt")], { type: "image/png" }), "x.png");

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("media_unsupported_format");
  });

  it("labels a missing file with its own code", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: new FormData(),
    });

    expect((await res.json()).code).toBe("media_missing_file");
  });

  /**
   * A 5.5 KB file that decodes to 45 megapixels — see `image.test.ts` and
   * `MAX_UPLOAD_PIXELS` for the measurements. Driven through the ROUTE, not
   * just the domain, because the code and the status are what the client reads.
   */
  it("refuses a small file with enormous dimensions, with its own code", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    const form = new FormData();
    form.append(
      "file",
      new Blob([await fixture("oversized-dimensions.png")], { type: "image/png" }),
      "big.png"
    );

    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("media_too_many_pixels");
    expect(body.error).toBe(
      "Resolusi foto terlalu besar (maksimal 40 megapiksel). Perkecil ukuran foto lalu unggah ulang."
    );
  });

  /**
   * **Spec §10: "rejected before it is read into memory."** `bodyLimit` runs
   * ahead of `c.req.formData()`, so an over-size body is refused off the
   * Content-Length without the route ever buffering it. 413, not 400 — the same
   * status the production nginx answers with for the same reason, which is what
   * lets the client hold ONE branch for both (see `errorCopy.ts`).
   */
  it("answers 413 to a body far over the limit, without buffering it", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/media", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/octet-stream" },
      // Never materialised: `bodyLimit` refuses on the declared length.
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);

    const oversized = await a.request("/users/media", {
      method: "POST",
      headers: {
        ...authed(token),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(11 * 1024 * 1024),
      },
      body: new Uint8Array(0),
    });

    expect(oversized.status).toBe(413);
  });
});

/**
 * WebP's magic number: a RIFF container (bytes 0-3) whose form type (bytes
 * 8-11, RIFF's chunk size sits in between) is WEBP. Checked against the
 * BODY ITSELF, never the `Content-Type` header — a route that lied about its
 * header, or answered with a JSON body like `{"url": "..."}`, would still
 * fail this even though a header-only check would wave it through.
 */
function isWebp(bytes: Uint8Array): boolean {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
}

describe("GET /users/media/:id and /thumb", () => {
  let a: ReturnType<typeof app>;
  let storage: ReturnType<typeof bootstrap>["mediaStorage"];
  let mediaRepository: ReturnType<typeof bootstrap>["mediaRepository"];
  let token: string;

  beforeEach(async () => {
    // `a`, `storage` and `mediaRepository` come from the SAME `bootstrap()`
    // call — Task 4's `POST /users/media` (behind `a`) and the fakes this
    // block pokes at directly (`storage.remove`, `mediaRepository.deleteIfUnclaimed`)
    // must be the ones the app is actually wired to, not fakes the test built
    // itself.
    const deps = bootstrap();
    a = createApp(deps);
    storage = deps.mediaStorage;
    mediaRepository = deps.mediaRepository;
    token = await tokenForValidUser(a);
  });

  async function uploadFixture(app: ReturnType<typeof createApp>, tok: string, name: string) {
    const form = new FormData();
    form.append("file", new Blob([await fixture(name)], { type: "image/png" }), name);
    const res = await app.request("/users/media", {
      method: "POST",
      headers: authed(tok),
      body: form,
    });
    const body = await res.json();
    return body.id as string;
  }

  it("streams the full image as bytes, with an image content type", async () => {
    const id = await uploadFixture(a, token, "small.png");

    const res = await a.request(`/users/media/${id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect((await res.bytes()).length).toBeGreaterThan(0);
  });

  // Review round 1, I2: the full route had this assertion and the thumb
  // route did not — a mutation deleting the thumb route's own null-check on
  // `mediaStorage.get` stayed green because nothing exercised that code path.
  it("streams the thumbnail as bytes, with an image content type", async () => {
    const id = await uploadFixture(a, token, "small.png");

    const res = await a.request(`/users/media/${id}/thumb`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect((await res.bytes()).length).toBeGreaterThan(0);
  });

  it("streams the thumbnail, and it is SMALLER than the full image", async () => {
    const id = await uploadFixture(a, token, "photo-with-gps.jpg");

    const full = await (await a.request(`/users/media/${id}`)).bytes();
    const thumb = await (await a.request(`/users/media/${id}/thumb`)).bytes();

    // Proves the two routes serve different variants rather than the same object
    // twice — an assertion on status alone passes against that bug. NOTE this
    // comparison alone is not enough to prove neither route redirects: a 302's
    // empty body is ALSO "smaller than the full image" — see the PROXIES tests
    // below, which is why size-comparison and proxy-vs-redirect are two
    // separate tests rather than one combined into the other.
    expect(thumb.length).toBeLessThan(full.length);
  });

  /**
   * Spec §5.1. This is the assertion the whole phase's shape exists to satisfy,
   * and Phase 6's paywall is built on it holding.
   *
   * Checked against the BODY's own WebP magic number, not just headers — a
   * `{"url": "..."}` JSON response has no `Location` header and no bucket
   * hostname in its headers either, so a header-only check cannot tell it
   * apart from the real bytes.
   */
  async function expectProxiesRealBytes(path: string) {
    const res = await a.request(path, { redirect: "manual" });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(302);
    expect(res.headers.get("location")).toBe(null);
    const headers = JSON.stringify([...res.headers.entries()]);
    expect(headers).not.toMatch(/biznetgio|amazonaws|s3\./i);

    const bytes = await res.bytes();
    expect(isWebp(bytes)).toBe(true);
  }

  // Review round 1, C1 (Critical): this test used to check the full route
  // ONLY. A mutation turning the THUMB handler into a 302-to-a-bucket-URL
  // left the suite at 12/12 green, because "streams the thumbnail... SMALLER"
  // above measures a redirect's EMPTY body as smaller than the full image —
  // the exact property that test exists to catch is the one a redirect
  // satisfies by accident. Both routes now get the full PROXIES assertions,
  // independently.
  it("PROXIES on the full route: never a redirect, never a bucket hostname, and the body is really the image", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await expectProxiesRealBytes(`/users/media/${id}`);
  });

  it("PROXIES on the thumb route: never a redirect, never a bucket hostname, and the body is really the image", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await expectProxiesRealBytes(`/users/media/${id}/thumb`);
  });

  it("404s an unknown id", async () => {
    expect((await a.request("/users/media/8a1f0e6e-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("404s an unknown id on the thumb route", async () => {
    expect(
      (await a.request("/users/media/8a1f0e6e-0000-4000-8000-000000000000/thumb")).status
    ).toBe(404);
  });

  it("404s a row whose bytes are missing, rather than 500ing", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await storage.remove(id);

    expect((await a.request(`/users/media/${id}`)).status).toBe(404);
  });

  // Review round 1, I2: same guard as the full route's test above, pinned
  // separately for the thumb route — deleting `mediaStorage.get`'s null
  // check on ONLY the thumb handler used to leave the suite green.
  it("404s a row whose thumb bytes are missing, rather than 500ing", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await storage.remove(id);

    expect((await a.request(`/users/media/${id}/thumb`)).status).toBe(404);
  });

  // Review round 1, I3 (Important): deleting the `mediaRepository.findById`
  // lookup from a handler used to leave the suite green, because
  // `mediaStorage.get` also returns `null` for a plain unknown id — nothing
  // distinguished "never existed" from "row gone, bytes orphaned". This test
  // creates exactly that gap (delete the row, leave the bytes) so only the
  // row lookup — not the storage lookup — can catch it. Also the anchor
  // Phase 6's entitlement check will read from: without this row, there is
  // nothing to check tier/ownership against.
  it("404s when the row has been deleted from the database but its bytes remain in storage (full route)", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await mediaRepository.deleteIfUnclaimed(id);

    expect((await a.request(`/users/media/${id}`)).status).toBe(404);
  });

  it("404s when the row has been deleted from the database but its bytes remain in storage (thumb route)", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await mediaRepository.deleteIfUnclaimed(id);

    expect((await a.request(`/users/media/${id}/thumb`)).status).toBe(404);
  });

  // Not in the brief's own list, but called out in its prose: the precedent
  // is Phase 3's I3 ruling on malformed post ids (`routes/posts.ts`) — a
  // malformed id is a client error caught before any repository call, never
  // a raw `invalid input syntax for type uuid` 500 from the database driver.
  it("400s a malformed id on the full route", async () => {
    expect((await a.request("/users/media/not-a-uuid")).status).toBe(400);
  });

  it("400s a malformed id on the thumb route", async () => {
    expect((await a.request("/users/media/not-a-uuid/thumb")).status).toBe(400);
  });

  it("sets long-lived, immutable caching on the bytes it returns", async () => {
    const id = await uploadFixture(a, token, "small.png");

    const res = await a.request(`/users/media/${id}`);

    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  // Review round 1, I2: same as the content-type/missing-bytes pair above —
  // the full route had this assertion, the thumb route did not.
  it("sets long-lived, immutable caching on the thumbnail bytes it returns", async () => {
    const id = await uploadFixture(a, token, "small.png");

    const res = await a.request(`/users/media/${id}/thumb`);

    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

/**
 * **BARRIER TWO — the route refuses an id it never sent** (spec §6.2, §6.4).
 *
 * Barrier one (Task 3) strips media ids out of the projection, so a non-member
 * is never handed one. That is not a paywall on its own: a paying member holds
 * legitimate ids and can forward one — a link in a group chat, a screenshot of
 * a URL. **Every test below is written as though barrier one did not exist**,
 * because for an id obtained any other way, it doesn't: each one hands this
 * route a real gated id directly and asserts what it does with it.
 *
 * `/users/media/:id` and `/users/media/:id/thumb` are two handlers, gated
 * independently, so every scenario here is asserted TWICE. Phase 4 split them
 * so they would be "not one line a future change could gate halfway", and
 * review round 1's C1 on this very file records what a suite that covers only
 * the full route misses. The thumbnail is the one the feed actually renders.
 *
 * The write path does not accept `visibility` yet — Task 5 of this phase adds
 * it — so a gated post is made by writing the column directly, the same
 * technique `posts.test.ts`'s barrier-one block uses.
 */
describe("members-only media: the route refuses an id it never sent", () => {
  const RINA = { handle: "rina", email: "rina@example.com", displayName: "Rina" };
  const BUYER = { handle: "andi", email: "andi@example.com", displayName: "Andi" };
  const STRANGER = { handle: "sinta", email: "sinta@example.com", displayName: "Sinta" };

  let a: ReturnType<typeof app>;

  beforeEach(() => {
    a = app();
  });

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

  async function upload(token: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([await fixture("small.png")], { type: "image/png" }), "small.png");
    const res = await a.request("/users/media", {
      method: "POST",
      headers: authed(token),
      body: form,
    });
    return (await res.json()).id as string;
  }

  async function createPost(token: string, body: string, mediaIds: string[]) {
    const res = await a.request("/users/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ body, mediaIds }),
    });
    return (await res.json()) as { id: string };
  }

  /** Rina, one MEMBERS-ONLY post holding one image. */
  async function rinaWithAGatedImage() {
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await upload(token);
    const post = await createPost(token, "Behind the scenes", [mediaId]);
    await gate(post.id);
    return { token, mediaId, postId: post.id };
  }

  /** Rina, one PUBLIC post holding one image. */
  async function rinaWithAPublicImage() {
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await upload(token);
    const post = await createPost(token, "terbuka", [mediaId]);
    return { token, mediaId, postId: post.id };
  }

  const full = (id: string) => `/users/media/${id}`;
  const thumb = (id: string) => `/users/media/${id}/thumb`;

  /**
   * 404, never 403 — media ids are stripped from the projection, so they are
   * not public knowledge and a 403 would confirm which ids exist. It is also
   * what both routes already answer for a missing row, so gated and absent are
   * indistinguishable from outside (spec §6.2).
   */
  async function expectRefused(path: string, headers: Record<string, string> = {}) {
    const res = await a.request(path, { headers });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  }

  /**
   * The bytes really arrived — checked against the body's own WebP magic
   * number and a `Location` header that must not exist, because a 302 to a
   * signed URL would hand the caller a URL outliving the check that produced
   * it. `cacheControl` is asserted as a LITERAL: the header is decided by the
   * same check that decided the bytes, and a shared cache holding gated images
   * is a failure no status-code assertion would ever catch (spec §8.1).
   */
  async function expectServed(
    path: string,
    cacheControl: string,
    headers: Record<string, string> = {}
  ) {
    const res = await a.request(path, { headers, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBe(null);
    expect(res.headers.get("cache-control")).toBe(cacheControl);
    expect(isWebp(await res.bytes())).toBe(true);
  }

  it("a signed-out caller gets 404 for a members-only post's image — not 403, which would confirm it exists", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    await expectRefused(full(mediaId));
  });

  it("a signed-out caller gets 404 for a members-only post's THUMBNAIL", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    await expectRefused(thumb(mediaId));
  });

  /**
   * The row still reads `status = 'active'` — nothing has retired it, and 5b's
   * sweep may not run for hours. A status-only check would serve this person
   * every gated image they have stopped paying for. This is where 5b's
   * retirement work becomes visible.
   */
  it("a LAPSED member gets 404", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), YESTERDAY());

    await expectRefused(full(mediaId), authed(buyer));
  });

  it("a LAPSED member gets 404 on the thumbnail", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), YESTERDAY());

    await expectRefused(thumb(mediaId), authed(buyer));
  });

  it("a paying member gets the bytes", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    await expectServed(full(mediaId), "private, no-store", authed(buyer));
  });

  it("a paying member gets the thumbnail bytes", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    await expectServed(thumb(mediaId), "private, no-store", authed(buyer));
  });

  it("the author gets their own bytes", async () => {
    const { token, mediaId } = await rinaWithAGatedImage();
    await expectServed(full(mediaId), "private, no-store", authed(token));
  });

  it("the author gets their own thumbnail bytes", async () => {
    const { token, mediaId } = await rinaWithAGatedImage();
    await expectServed(thumb(mediaId), "private, no-store", authed(token));
  });

  /**
   * Asserted on the LITERAL header. The bytes and the header come from one
   * decision, so this cannot be satisfied by a 200 whose caching was computed
   * somewhere else — and a `public` header here would license an nginx layer
   * or a CDN to replay this member's gated image to a stranger without ever
   * re-entering the handler.
   */
  it("a gated response is never publicly cacheable", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    const res = await a.request(full(mediaId), { headers: authed(buyer) });

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a gated THUMBNAIL response is never publicly cacheable", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    const res = await a.request(thumb(mediaId), { headers: authed(buyer) });

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  /**
   * The AUTHOR is served, and is still served `private, no-store`: `gated`
   * describes the MEDIA, not the caller. A creator's own browser cache is
   * shared with whoever else uses that device, and a year-long `immutable`
   * entry for a gated image is the same hole one step removed.
   */
  it("the author's own gated bytes are not publicly cacheable either", async () => {
    const { token, mediaId } = await rinaWithAGatedImage();

    const res = await a.request(full(mediaId), { headers: authed(token) });

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("the author's own gated THUMBNAIL is not publicly cacheable either", async () => {
    const { token, mediaId } = await rinaWithAGatedImage();

    const res = await a.request(thumb(mediaId), { headers: authed(token) });

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a public post's image keeps the immutable cache", async () => {
    const { mediaId } = await rinaWithAPublicImage();

    const res = await a.request(full(mediaId));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("a public post's THUMBNAIL keeps the immutable cache", async () => {
    const { mediaId } = await rinaWithAPublicImage();

    const res = await a.request(thumb(mediaId));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  /**
   * **THE POINT OF THIS PHASE.** The projection never sends this id to a
   * non-member — this test hands it over anyway, exactly as a member
   * forwarding a link would, with a stranger's own valid session. If barrier
   * one were deleted entirely, this is the assertion that would still hold.
   */
  it("BARRIER TWO ALONE: an id obtained legitimately by a member is refused to a non-member", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());
    // The member really can fetch it — otherwise the refusal below would prove
    // nothing about entitlement, only that the id was broken.
    await expectServed(full(mediaId), "private, no-store", authed(buyer));

    const stranger = await tokenForValidUser(a, STRANGER);
    await expectRefused(full(mediaId), authed(stranger));
  });

  it("BARRIER TWO ALONE: a forwarded THUMBNAIL id is refused to a non-member", async () => {
    const { mediaId } = await rinaWithAGatedImage();
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());
    await expectServed(thumb(mediaId), "private, no-store", authed(buyer));

    const stranger = await tokenForValidUser(a, STRANGER);
    await expectRefused(thumb(mediaId), authed(stranger));
  });

  /**
   * A membership buys that creator's gated images and nothing else. The gate
   * answers per AUTHOR; a check keyed on "is this viewer a member of anybody"
   * would be exactly this bug.
   */
  it("paying one creator does not unlock another creator's gated image", async () => {
    await rinaWithAGatedImage();
    const budi = await tokenForValidUser(a, VALID);
    const budiMedia = await upload(budi);
    const budiPost = await createPost(budi, "punya budi", [budiMedia]);
    await gate(budiPost.id);
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    await expectRefused(full(budiMedia), authed(buyer));
  });

  it("paying one creator does not unlock another creator's gated THUMBNAIL", async () => {
    await rinaWithAGatedImage();
    const budi = await tokenForValidUser(a, VALID);
    const budiMedia = await upload(budi);
    const budiPost = await createPost(budi, "punya budi", [budiMedia]);
    await gate(budiPost.id);
    const buyer = await tokenForValidUser(a, BUYER);
    await grantMembership(await userIdFor("andi"), await userIdFor("rina"), IN_A_MONTH());

    await expectRefused(thumb(budiMedia), authed(buyer));
  });

  /**
   * Spec §6.3. Unclaimed media (`post_id is null`) has no post and therefore
   * no visibility to read: it stays ungated and publicly cacheable, exactly as
   * before this phase. The id is known only to its uploader, who is the only
   * person who could have received it.
   */
  it("unclaimed media — no post, so no visibility — is served ungated to a signed-out caller", async () => {
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await upload(token);

    await expectServed(full(mediaId), "public, max-age=31536000, immutable");
  });

  it("an unclaimed THUMBNAIL is served ungated to a signed-out caller", async () => {
    const token = await tokenForValidUser(a, RINA);
    const mediaId = await upload(token);

    await expectServed(thumb(mediaId), "public, max-age=31536000, immutable");
  });

  /**
   * Spec §6.3. Deleting a post does not un-gate its images: the row is
   * soft-deleted and this route keeps serving it exactly as it does today, so
   * the gate must still read the visibility of a post no projection will ever
   * show again.
   */
  it("media on a SOFT-DELETED members-only post is still refused to a non-member", async () => {
    const { token, mediaId, postId } = await rinaWithAGatedImage();
    await a.request(`/users/posts/${postId}`, { method: "DELETE", headers: authed(token) });

    await expectRefused(full(mediaId));
  });

  it("the THUMBNAIL of a soft-deleted members-only post is still refused to a non-member", async () => {
    const { token, mediaId, postId } = await rinaWithAGatedImage();
    await a.request(`/users/posts/${postId}`, { method: "DELETE", headers: authed(token) });

    await expectRefused(thumb(mediaId));
  });
});
