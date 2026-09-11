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

async function postToCommunity(
  a: ReturnType<typeof app>,
  token: string,
  slug: string,
  body: Record<string, unknown>
) {
  return a.request(`/communities/${slug}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authed(token) },
    body: JSON.stringify(body),
  });
}

describe("GET and POST /communities/:slug/posts", () => {
  it("GET is readable signed out — 200", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/posts");

    expect(res.status).toBe(200);
  });

  it("POST requires auth — 401", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "halo" }),
    });

    expect(res.status).toBe(401);
  });

  it("POST by a non-member is 403", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const strangerToken = await tokenForValidUser(a, {
      handle: "rina",
      email: "rina@example.com",
    });

    const res = await postToCommunity(a, strangerToken, "kelas-desain", { body: "halo" });

    expect(res.status).toBe(403);
  });

  it("POST with type pengumuman by a member (not the owner) is 403", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const memberToken = await tokenForValidUser(a, {
      handle: "rina",
      email: "rina@example.com",
    });
    await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(memberToken),
    });

    const res = await postToCommunity(a, memberToken, "kelas-desain", {
      body: "halo",
      type: "pengumuman",
    });

    expect(res.status).toBe(403);
  });

  it("an unknown slug is 404 on both GET and POST", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const getRes = await a.request("/communities/tidak-ada/posts");
    expect(getRes.status).toBe(404);

    const postRes = await postToCommunity(a, token, "tidak-ada", { body: "halo" });
    expect(postRes.status).toBe(404);
  });
});

/** 15 September 2026, 16:00 WIB — and 18:00 WIB. */
const STARTS_AT = "2026-09-15T09:00:00.000Z";
const ENDS_AT = "2026-09-15T11:00:00.000Z";

const AN_EVENT = {
  body: "kelas tatap muka daring",
  type: "kegiatan",
  event: { title: "Trigonometri lanjutan", startsAt: STARTS_AT },
};

describe("POST /communities/:slug/posts — kegiatan", () => {
  it("the owner may post one, and the schedule comes back on the post", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await postToCommunity(a, token, "kelas-desain", {
      ...AN_EVENT,
      event: { ...AN_EVENT.event, endsAt: ENDS_AT, location: "Online via Zoom" },
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("kegiatan");
    expect(body.event).toEqual({
      title: "Trigonometri lanjutan",
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      location: "Online via Zoom",
    });
  });

  it("a plain member may not — 403, the same rule pengumuman takes", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const memberToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(memberToken),
    });

    const res = await postToCommunity(a, memberToken, "kelas-desain", AN_EVENT);

    expect(res.status).toBe(403);
  });

  /**
   * The refinement reaching the ROUTE's schema, not just the shared one. The
   * route `.extend()`s the fields to inject the `maxPostImages` cap, which
   * returns a fresh ZodObject carrying none of the source's refinements — so
   * without the explicit re-apply, this request would 201 and write a
   * kegiatan with no schedule. That is the exact regression this asserts.
   */
  it("a kegiatan with no schedule is 400, not a dateless event", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await postToCommunity(a, token, "kelas-desain", {
      body: "kelas tanpa tanggal",
      type: "kegiatan",
    });

    expect(res.status).toBe(400);
  });

  it("a diskusi carrying a schedule is 400 — the other half of the same rule", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await postToCommunity(a, token, "kelas-desain", {
      body: "diskusi biasa",
      type: "diskusi",
      event: { title: "Menyelinap", startsAt: STARTS_AT },
    });

    expect(res.status).toBe(400);
  });

  it("an endsAt before its startsAt is 400, not a constraint violation", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await postToCommunity(a, token, "kelas-desain", {
      ...AN_EVENT,
      event: { ...AN_EVENT.event, endsAt: "2026-09-15T08:00:00.000Z" },
    });

    // 400 and not 500: the CHECK would also refuse this, but a constraint
    // violation reaches the client as an opaque server error it cannot act on.
    expect(res.status).toBe(400);
  });

  it("a diskusi still comes back with event: null — the key set stays closed", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await postToCommunity(a, token, "kelas-desain", { body: "halo" });

    expect((await res.json()).event).toBeNull();
  });
});

describe("GET /communities/:slug/events", () => {
  it("is readable signed out, and lists the month ascending", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    await postToCommunity(a, token, "kelas-desain", {
      body: "kedua",
      type: "kegiatan",
      event: { title: "Kedua", startsAt: "2026-09-20T13:00:00.000Z" },
    });
    await postToCommunity(a, token, "kelas-desain", AN_EVENT);

    const res = await a.request("/communities/kelas-desain/events?month=2026-09");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: { title: string }) => e.title)).toEqual([
      "Trigonometri lanjutan",
      "Kedua",
    ]);
    expect(body.events[0].author.handle).toBe("wildan");
  });

  it("another month is empty rather than a 404", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    await postToCommunity(a, token, "kelas-desain", AN_EVENT);

    const res = await a.request("/communities/kelas-desain/events?month=2026-10");

    expect(res.status).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  /**
   * A user can edit this query string, so a malformed one must not be an
   * error page — it falls back to the current WIB month.
   */
  it("a malformed month falls back rather than erroring", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/events?month=besok");

    expect(res.status).toBe(200);
  });

  it("an unknown slug is 404", async () => {
    const a = app();

    expect((await a.request("/communities/tidak-ada/events")).status).toBe(404);
  });

  /** The literal segment must win over `:slug` — the ordering the route file relies on. */
  it("does not collide with GET /communities/:slug", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/events");

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("events");
  });
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function documentForm(
  name = "Rangkuman Trigonometri.pdf",
  type = "application/pdf",
  bytes: Uint8Array = PDF_BYTES
) {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type }));
  return form;
}

async function uploadDocument(
  a: ReturnType<typeof app>,
  token: string,
  slug: string,
  form = documentForm()
) {
  return a.request(`/communities/${slug}/documents`, {
    method: "POST",
    headers: authed(token),
    body: form,
  });
}

async function joinAs(a: ReturnType<typeof app>, handle: string, email: string) {
  const token = await tokenForValidUser(a, { handle, email });
  await a.request("/communities/kelas-desain/join", { method: "POST", headers: authed(token) });
  return token;
}

describe("POST /communities/:slug/documents", () => {
  it("the owner uploads and gets the row back, with no URL on it", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await uploadDocument(a, token, "kelas-desain");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "byteSize",
      "contentType",
      "createdAt",
      "id",
      "name",
      "uploader",
    ]);
    expect(body.name).toBe("Rangkuman Trigonometri.pdf");
    expect(body.byteSize).toBe(5);
  });

  it("a plain member may not — 403", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const memberToken = await joinAs(a, "rina", "rina@example.com");

    expect((await uploadDocument(a, memberToken, "kelas-desain")).status).toBe(403);
  });

  it("requires auth — 401", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/documents", {
      method: "POST",
      body: documentForm(),
    });

    expect(res.status).toBe(401);
  });

  it("a body with no file part is 400 with the missing-file code", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/documents", {
      method: "POST",
      headers: authed(token),
      body: new FormData(),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("document_missing_file");
  });

  it("a JSON body is 400, not a 500 from formData() throwing", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await a.request("/communities/kelas-desain/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ file: "nope" }),
    });

    expect(res.status).toBe(400);
  });

  it.each([
    ["an executable type", "text/html", "document_unsupported_format"],
    ["a scriptable image", "image/svg+xml", "document_unsupported_format"],
    ["an archive", "application/zip", "document_unsupported_format"],
  ])("%s is refused with its code", async (_label, type, code) => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await uploadDocument(a, token, "kelas-desain", documentForm("x.html", type));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
  });

  it("a name that sanitises to nothing is 400 with the invalid-name code", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);

    const res = await uploadDocument(a, token, "kelas-desain", documentForm("../.."));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("document_invalid_name");
  });

  it("an unknown slug is 404", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    expect((await uploadDocument(a, token, "tidak-ada")).status).toBe(404);
  });
});

describe("GET /communities/:slug/documents", () => {
  it("is readable signed out, and says the visitor may not download", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    await uploadDocument(a, token, "kelas-desain");

    const res = await a.request("/communities/kelas-desain/documents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents.map((d: { name: string }) => d.name)).toEqual([
      "Rangkuman Trigonometri.pdf",
    ]);
    // So the client never renders a download control that would fail.
    expect(body.viewerMayDownload).toBe(false);
  });

  it("tells a member they may download", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    await uploadDocument(a, ownerToken, "kelas-desain");
    const memberToken = await joinAs(a, "rina", "rina@example.com");

    const res = await a.request("/communities/kelas-desain/documents", {
      headers: authed(memberToken),
    });

    expect((await res.json()).viewerMayDownload).toBe(true);
  });

  it("an unknown slug is 404", async () => {
    expect((await app().request("/communities/tidak-ada/documents")).status).toBe(404);
  });
});

describe("GET /communities/:slug/documents/:id", () => {
  async function withDocument() {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const created = await (await uploadDocument(a, ownerToken, "kelas-desain")).json();
    return { a, ownerToken, id: created.id as string };
  }

  /**
   * **The three security headers, asserted together on one response.**
   *
   * They work as a SET: the allowlist without `nosniff` is defeated by the
   * browser's own sniffing, and `nosniff` without `attachment` still renders
   * a correctly-labelled HTML file. Three separate tests would each pass
   * while the set was broken.
   */
  it("serves the bytes with attachment, nosniff and a private cache", async () => {
    const { a, ownerToken, id } = await withDocument();

    const res = await a.request(`/communities/kelas-desain/documents/${id}`, {
      headers: authed(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toStartWith("attachment; ");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // Decided by the same check that decided the bytes — a shared cache must
    // never hold a gated document.
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it("the filename survives in both Content-Disposition forms", async () => {
    const { a, ownerToken, id } = await withDocument();

    const res = await a.request(`/communities/kelas-desain/documents/${id}`, {
      headers: authed(ownerToken),
    });

    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain('filename="Rangkuman Trigonometri.pdf"');
    expect(disposition).toContain("filename*=UTF-8''Rangkuman%20Trigonometri.pdf");
  });

  it("a member may download", async () => {
    const { a, id } = await withDocument();
    const memberToken = await joinAs(a, "rina", "rina@example.com");

    const res = await a.request(`/communities/kelas-desain/documents/${id}`, {
      headers: authed(memberToken),
    });

    expect(res.status).toBe(200);
  });

  it.each([
    ["a signed-out visitor", false],
    ["a signed-in non-member", true],
  ])("%s gets 404, never 403", async (_label, signedIn) => {
    const { a, id } = await withDocument();
    const headers = signedIn
      ? authed(await tokenForValidUser(a, { handle: "asing", email: "asing@example.com" }))
      : undefined;

    const res = await a.request(`/communities/kelas-desain/documents/${id}`, { headers });

    // 404 and not 403: a 403 confirms the document exists to somebody who may
    // not have it.
    expect(res.status).toBe(404);
  });

  it("an unknown id is 404", async () => {
    const { a, ownerToken } = await withDocument();
    const res = await a.request(
      "/communities/kelas-desain/documents/ffffffff-0000-4000-8000-000000000000",
      { headers: authed(ownerToken) }
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /communities/:slug/documents/:id", () => {
  it("the owner deletes, and the document leaves the list", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    const created = await (await uploadDocument(a, token, "kelas-desain")).json();

    const res = await a.request(`/communities/kelas-desain/documents/${created.id}`, {
      method: "DELETE",
      headers: authed(token),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    const list = await (await a.request("/communities/kelas-desain/documents")).json();
    expect(list.documents).toEqual([]);
  });

  it("a member may not — 403", async () => {
    const a = app();
    const ownerToken = await tokenForValidUser(a);
    await createCommunity(a, ownerToken, KELAS);
    const created = await (await uploadDocument(a, ownerToken, "kelas-desain")).json();
    const memberToken = await joinAs(a, "rina", "rina@example.com");

    const res = await a.request(`/communities/kelas-desain/documents/${created.id}`, {
      method: "DELETE",
      headers: authed(memberToken),
    });

    expect(res.status).toBe(403);
  });

  it("deleting twice is 404 the second time", async () => {
    const a = app();
    const token = await tokenForValidUser(a);
    await createCommunity(a, token, KELAS);
    const created = await (await uploadDocument(a, token, "kelas-desain")).json();
    const del = () =>
      a.request(`/communities/kelas-desain/documents/${created.id}`, {
        method: "DELETE",
        headers: authed(token),
      });

    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(404);
  });
});
