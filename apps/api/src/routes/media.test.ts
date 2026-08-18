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
});

describe("GET /users/media/:id and /thumb", () => {
  let a: ReturnType<typeof app>;
  let storage: ReturnType<typeof bootstrap>["mediaStorage"];
  let token: string;

  beforeEach(async () => {
    // `a` and `storage` come from the SAME `bootstrap()` call — Task 4's
    // `POST /users/media` (behind `a`) and the fake this block pokes at
    // directly with `storage.remove` must be the one adapter the app is
    // actually wired to, not a second fake the test built itself.
    const deps = bootstrap();
    a = createApp(deps);
    storage = deps.mediaStorage;
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

  it("streams the thumbnail, and it is SMALLER than the full image", async () => {
    const id = await uploadFixture(a, token, "photo-with-gps.jpg");

    const full = await (await a.request(`/users/media/${id}`)).bytes();
    const thumb = await (await a.request(`/users/media/${id}/thumb`)).bytes();

    // Proves the two routes serve different variants rather than the same object
    // twice — an assertion on status alone passes against that bug.
    expect(thumb.length).toBeLessThan(full.length);
  });

  /**
   * Spec §5.1. This is the assertion the whole phase's shape exists to satisfy,
   * and Phase 6's paywall is built on it holding.
   */
  it("PROXIES: never a redirect, and never a bucket hostname in any header", async () => {
    const id = await uploadFixture(a, token, "small.png");

    const res = await a.request(`/users/media/${id}`, { redirect: "manual" });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(302);
    expect(res.headers.get("location")).toBe(null);
    const headers = JSON.stringify([...res.headers.entries()]);
    expect(headers).not.toMatch(/biznetgio|amazonaws|s3\./i);
  });

  it("404s an unknown id", async () => {
    expect((await a.request("/users/media/8a1f0e6e-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("404s a row whose bytes are missing, rather than 500ing", async () => {
    const id = await uploadFixture(a, token, "small.png");
    await storage.remove(id);

    expect((await a.request(`/users/media/${id}`)).status).toBe(404);
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
});
