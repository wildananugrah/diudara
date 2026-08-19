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
