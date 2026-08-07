import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function signup(body: unknown) {
  return app().request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(body: unknown) {
  return app().request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { name: "Budi", email: "budi@example.com", password: "supersecret123" };

describe("POST /auth/signup", () => {
  it("creates a creator and returns a token", async () => {
    const res = await signup(VALID);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.creator.email).toBe("budi@example.com");
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".").length).toBe(3);
  });

  it("never includes the password hash in the response", async () => {
    const res = await signup(VALID);
    const text = await res.text();
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("argon2");
  });

  it("rejects a duplicate email with 409", async () => {
    await signup(VALID);
    const res = await signup({ ...VALID, name: "Someone Else" });
    expect(res.status).toBe(409);
  });

  it("rejects a short password with 400", async () => {
    const res = await signup({ ...VALID, password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app().request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("returns a token for correct credentials", async () => {
    await signup(VALID);
    const res = await login({ email: VALID.email, password: VALID.password });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).token).toBe("string");
  });

  it("accepts a differently-cased email", async () => {
    await signup(VALID);
    const res = await login({ email: "BUDI@Example.COM", password: VALID.password });
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
