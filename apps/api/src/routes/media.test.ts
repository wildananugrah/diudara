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
