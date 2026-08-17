import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function signup(body: unknown) {
  return app().request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(body: unknown) {
  return app().request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = {
  handle: "wildan",
  email: "wildan@example.com",
  password: "supersecret123",
  displayName: "Wildan",
};

/** Signs up (if not already) and logs in `VALID`, returning the bearer token. */
async function tokenForValidUser(a = app()) {
  await a.request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(VALID),
  });
  const res = await a.request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: VALID.email, password: VALID.password }),
  });
  const body = await res.json();
  return body.token as string;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("POST /users/signup", () => {
  it("creates a user and returns ONLY { ok: true } — no user, no token", async () => {
    const res = await signup(VALID);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("never includes the password hash in the response", async () => {
    const res = await signup(VALID);
    const text = await res.text();
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("argon2");
  });

  it("THE CENTRAL GUARANTEE: signing up as '@Wildan' then 'wildan' is a conflict, not two users", async () => {
    const first = await signup({ ...VALID, handle: "@Wildan", email: "first@example.com" });
    expect(first.status).toBe(201);

    const second = await signup({ ...VALID, handle: "wildan", email: "second@example.com" });
    expect(second.status).toBe(409);

    // Only the first account exists — confirm via login, since signup returns
    // nothing identifying an account. The second signup's email must never
    // have been consumed either, since its create() should have failed on
    // the handle collision before ever reaching the unique index for email —
    // but the strongest proof is simply that only ONE of the two emails can
    // log in as a fresh account: the first can, and did.
    const loginFirst = await login({ email: "first@example.com", password: VALID.password });
    expect(loginFirst.status).toBe(200);
  });

  it("rejects a duplicate handle with 409 — handles are public, this is safe to reveal", async () => {
    await signup(VALID);
    const res = await signup({ ...VALID, handle: "wildan", email: "someoneelse@example.com" });
    expect(res.status).toBe(409);
  });

  it("REGRESSION (critical): a taken handle 409s even when the request's email is ALSO already registered", async () => {
    // Handles are public (`/@wildan` is browsable), so an attacker needs
    // only one known handle to probe this. An earlier version checked email
    // first and returned early, so a taken handle's 409 depended on whether
    // the ACCOMPANYING email happened to be free — 201 for a registered
    // email, 409 for an unregistered one — turning a deliberately public
    // fact (handle taken) into an oracle for a deliberately hidden one
    // (email registered).
    const first = await signup({ ...VALID, handle: "wildan", email: "registered@example.com" });
    expect(first.status).toBe(201);

    const registeredEmailProbe = await signup({
      ...VALID,
      handle: "wildan",
      email: "registered@example.com",
    });
    const unknownEmailProbe = await signup({
      ...VALID,
      handle: "wildan",
      email: "never-signed-up@example.com",
    });

    // Both probes collide on the SAME handle, so both must 409 the SAME
    // way — the email's registration status must not change the outcome.
    expect(registeredEmailProbe.status).toBe(409);
    expect(unknownEmailProbe.status).toBe(409);
  });

  it("returns 201 with { ok: true } for a duplicate email — indistinguishable from a fresh signup", async () => {
    const fresh = await signup(VALID);
    expect(fresh.status).toBe(201);

    const duplicate = await signup({ ...VALID, handle: "someoneelse", email: VALID.email });
    expect(duplicate.status).toBe(fresh.status);
    expect(await duplicate.json()).toEqual({ ok: true });
  });

  it("does not create a second account for a duplicate email", async () => {
    await signup(VALID);
    await signup({ ...VALID, handle: "someoneelse", email: VALID.email });

    // The second handle must never have been claimed — proof that no row
    // was inserted for the duplicate-email attempt.
    const res = await signup({ ...VALID, handle: "someoneelse", email: "brandnew@example.com" });
    expect(res.status).toBe(201);
  });

  it("resolves a race for one handle to a single 201 and 409s, never a 500", async () => {
    const a = app();
    const attempts = 3;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        a.request("/users/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...VALID, handle: "racer", email: `racer${i}@example.com` }),
        })
      )
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(attempts - 1);
    expect(statuses).not.toContain(500);
  });

  it("rejects a short password with 400", async () => {
    const res = await signup({ ...VALID, password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid handle (after normalisation) with 400", async () => {
    const res = await signup({ ...VALID, handle: "ab" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app().request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("accepts signup without a WhatsApp number", async () => {
    const res = await signup(VALID);
    expect(res.status).toBe(201);
  });
});

describe("POST /users/login", () => {
  it("returns a token and public profile for correct credentials", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: VALID.password });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".").length).toBe(3);
    expect(body.user.handle).toBe("wildan");
    expect(body.user.email).toBe(VALID.email);
    expect(body.user.displayName).toBe(VALID.displayName);
  });

  it("never includes the password hash in the response", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: VALID.password });
    const text = await res.text();
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("argon2");
  });

  it("accepts a differently-cased email", async () => {
    await signup(VALID);
    const res = await login({ email: "WILDAN@Example.COM", password: VALID.password });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password with 401", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("returns an identical response for an unknown email and a wrong password", async () => {
    await signup(VALID);
    const unknown = await login({ email: "nobody@example.com", password: VALID.password });
    const wrong = await login({ email: VALID.email, password: "wrong-password" });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });
});

describe("GET /users/by-handle/:handle", () => {
  it("returns EXACTLY handle/displayName/bio/createdAt — no email, no anything else", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/by-handle/wildan");
    expect(res.status).toBe(200);

    const body = await res.json();
    // Assert on the response body's ACTUAL keys, not on the type — extra
    // properties (email, whatsappNumber, id, sessionEpoch) would pass a
    // structural-type check silently even though they must never appear
    // here. This is the form that catches that.
    expect(Object.keys(body).sort()).toEqual(["bio", "createdAt", "displayName", "handle"]);
    expect(body.handle).toBe("wildan");
    expect(body.displayName).toBe(VALID.displayName);
    expect(body.email).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(VALID.email);
  });

  it("404s for an unknown handle", async () => {
    const res = await app().request("/users/by-handle/nobody-at-all");
    expect(res.status).toBe(404);
  });

  it("a handle sent with a leading @ still resolves — normalizeHandle is forgiving, not a 404", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/by-handle/%40wildan");
    expect(res.status).toBe(200);
    expect((await res.json()).handle).toBe("wildan");
  });
});

describe("GET /users/me", () => {
  it("requires auth — no Authorization header is a 401", async () => {
    const res = await app().request("/users/me");
    expect(res.status).toBe(401);
  });

  it("rejects a garbage bearer token with 401", async () => {
    const res = await app().request("/users/me", { headers: authed("not-a-real-token") });
    expect(res.status).toBe(401);
  });

  it("returns the caller's own profile, INCLUDING email — driven through the real requireUserAuth middleware", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", { headers: authed(token) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "email",
      "handle",
      "whatsappNumber",
    ]);
    expect(body.email).toBe(VALID.email);
    expect(body.handle).toBe("wildan");
  });

  it("401s a token whose sessionEpoch was bumped by a REAL setPasswordAndBumpEpoch call — not a fake", async () => {
    // The only other place this comparison is exercised is a Task 2 unit
    // test against a hand-written fake repository, where sessionEpoch is a
    // plain JS number on both sides. Here it is a Postgres `integer` read
    // back through Drizzle, compared against a JWT numeric claim — a
    // serialisation or type mismatch on that path would be invisible to the
    // fake, and would silently make "a password reset ends every session" a
    // no-op.
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const loginRes = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: VALID.email, password: VALID.password }),
    });
    const { token, user } = (await loginRes.json()) as { token: string; user: { id: string } };

    const before = await a.request("/users/me", { headers: authed(token) });
    expect(before.status).toBe(200);

    const bumped = await deps.userRepository.setPasswordAndBumpEpoch(user.id, "irrelevant-hash");
    expect(bumped).toBe(true);

    const after = await a.request("/users/me", { headers: authed(token) });
    expect(after.status).toBe(401);
  });
});

describe("PATCH /users/me", () => {
  it("requires auth — no Authorization header is a 401", async () => {
    const res = await app().request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "New Name" }),
    });
    expect(res.status).toBe(401);
  });

  it("updates the display name", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ displayName: "Wildan Baru" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Assert on the response body's ACTUAL keys, not on the type — PATCH
    // returns the widest of the three profile shapes (email AND
    // whatsappNumber included), so it is the one most exposed by a handler
    // that spreads instead of projecting. Both GET routes assert this; PATCH
    // did not, and a handler returning `{ ...updated, sessionEpoch: 7, id:
    // "leaked" }` passed every existing PATCH test.
    expect(Object.keys(body).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "email",
      "handle",
      "whatsappNumber",
    ]);
    expect(body.displayName).toBe("Wildan Baru");

    const confirm = await a.request("/users/me", { headers: authed(token) });
    expect((await confirm.json()).displayName).toBe("Wildan Baru");
  });

  it("rejects a garbage bearer token with 401", async () => {
    const res = await app().request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed("not-a-real-token") },
      body: JSON.stringify({ displayName: "New Name" }),
    });
    expect(res.status).toBe(401);
  });

  it("clears the bio with an EXPLICIT null", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const setBio = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ bio: "hello world" }),
    });
    expect(setBio.status).toBe(200);
    expect((await setBio.json()).bio).toBe("hello world");

    const clearBio = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ bio: null }),
    });
    expect(clearBio.status).toBe(200);
    expect((await clearBio.json()).bio).toBeNull();
  });

  it("normalises a whitespace-only bio to null, not an empty string", async () => {
    // Otherwise "no bio" has two representations in the column (`null` and
    // `""`), and a consumer rendering `bio ?? "Belum ada bio"` would show a
    // blank instead of the fallback.
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ bio: "   " }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bio).toBeNull();

    const confirm = await a.request("/users/me", { headers: authed(token) });
    expect((await confirm.json()).bio).toBeNull();
  });

  it("an ABSENT bio leaves the existing value alone", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ bio: "keep me" }),
    });

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ displayName: "Only Name Changed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bio).toBe("keep me");
  });

  it("rejects an empty patch with 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("CANNOT change the handle: PATCH { handle } alone is a 400 (stripped, leaving an empty patch), and the handle never changes", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ handle: "someone-else" }),
    });
    expect(res.status).toBe(400);

    // Confirm via the real lookup route, not just that the PATCH 400'd.
    const stillThere = await a.request("/users/by-handle/wildan");
    expect(stillThere.status).toBe(200);
    const gone = await a.request("/users/by-handle/someone-else");
    expect(gone.status).toBe(404);
  });

  it("a handle alongside a valid field is still rejected as 400 if handle is the ONLY effective key — but a genuinely valid field survives Zod's silent strip", async () => {
    // `handle` is stripped silently by Zod; `displayName` alone is a valid,
    // non-empty patch, so this succeeds — it is the mirror image of the
    // handle-only case above, proving the strip (not a body-shape rejection)
    // is what is happening.
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ handle: "someone-else", displayName: "Still Wildan" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Still Wildan");
    expect(body.handle).toBe("wildan");
  });
});
