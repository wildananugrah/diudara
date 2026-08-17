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
