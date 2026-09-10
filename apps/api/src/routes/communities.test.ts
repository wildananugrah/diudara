import { beforeEach, describe, expect, it } from "bun:test";
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

/**
 * Signs up (if not already) and logs in `VALID`, returning the bearer token —
 * the same helper `routes/users.test.ts` uses, and for the same reason: these
 * tests drive the REAL signup and login routes rather than minting a token
 * from the issuer directly, so an auth change that breaks the routes breaks
 * these too.
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

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function createCommunity(
  a: ReturnType<typeof app>,
  token: string,
  body: Record<string, unknown>
) {
  return a.request("/communities", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify(body),
  });
}

const KELAS = { name: "Kelas Desain", category: "Skill Digital" };

describe("POST /communities", () => {
  it("is 401 without a token", async () => {
    const res = await app().request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(KELAS),
    });
    expect(res.status).toBe(401);
  });

  it("is 201 and answers with the derived slug", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createCommunity(a, token, KELAS);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("kelas-desain");
    expect(body.memberCount).toBe(1);
    expect(body.viewerIsOwner).toBe(true);
  });

  it("is 400 for a category outside the six", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await createCommunity(a, token, { name: "Kelas Bola", category: "Olahraga" });

    expect(res.status).toBe(400);
  });

  it("is 409 the second time the same name is used", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await createCommunity(a, token, KELAS);

    expect(res.status).toBe(409);
  });
});

describe("GET /communities", () => {
  it("lists them without a token", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.communities.map((c: { slug: string }) => c.slug)).toEqual(["kelas-desain"]);
  });

  it("filters by category", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    await createCommunity(a, token, { name: "Bimbel SBMPTN", category: "Bimbel & Ujian" });

    const res = await a.request(`/communities?category=${encodeURIComponent("Skill Digital")}`);

    const body = await res.json();
    expect(body.communities.map((c: { slug: string }) => c.slug)).toEqual(["kelas-desain"]);
  });

  it("searches by name", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    await createCommunity(a, token, { name: "Bimbel SBMPTN", category: "Bimbel & Ujian" });

    const res = await a.request("/communities?q=bimbel");

    const body = await res.json();
    expect(body.communities.map((c: { slug: string }) => c.slug)).toEqual(["bimbel-sbmptn"]);
  });
});

describe("GET /communities/:slug", () => {
  it("is 404 for a slug nobody holds", async () => {
    const res = await app().request("/communities/tidak-ada");
    expect(res.status).toBe(404);
  });

  it("reports viewerIsMember as null for a signed-out reader", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viewerIsMember).toBe(null);
    expect(body.ownerHandle).toBe("wildan");
  });
});

describe("POST and DELETE /communities/:slug/join", () => {
  it("is 401 without a token", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/join", { method: "POST" });

    expect(res.status).toBe(401);
  });

  it("joining twice stays 200 { member: true } and moves the count once", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const joinerToken = await tokenForValidUser(a, {
      handle: "rina",
      email: "rina@example.com",
    });

    const first = await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(joinerToken),
    });
    const second = await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(joinerToken),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ member: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ member: true });

    const detail = await (await a.request("/communities/kelas-desain")).json();
    expect(detail.memberCount).toBe(2);
  });

  it("leaving is 200 { member: false }", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const joinerToken = await tokenForValidUser(a, {
      handle: "rina",
      email: "rina@example.com",
    });
    await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(joinerToken),
    });

    const res = await a.request("/communities/kelas-desain/join", {
      method: "DELETE",
      headers: authed(joinerToken),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: false });
  });

  it("is 409 when the owner tries to leave their own community", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);

    const res = await a.request("/communities/kelas-desain/join", {
      method: "DELETE",
      headers: authed(ownerToken),
    });

    expect(res.status).toBe(409);
  });
});

describe("GET /communities/:slug/members", () => {
  it("lists the owner first", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const joinerToken = await tokenForValidUser(a, {
      handle: "rina",
      email: "rina@example.com",
    });
    await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(joinerToken),
    });

    const res = await a.request("/communities/kelas-desain/members");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.map((m: { handle: string }) => m.handle)).toEqual(["wildan", "rina"]);
    expect(body.capped).toBe(false);
  });
});
