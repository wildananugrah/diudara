import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { appUsers } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { FakeEmailAdapter } from "../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../infrastructure/messaging/fake-messaging.adapter";
import { BunPasswordHasher } from "../infrastructure/auth/bun-password.hasher";
import { RegisterUser } from "../application/use-cases/register-user";
import { DEFAULT_EXPLORE_LIMIT } from "../application/use-cases/explore-users";
import { clientIp } from "./users";
import { isReservedHandle, isValidHandle } from "../domain/handle";

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

/**
 * Signs up (if not already) and logs in `VALID`, returning the bearer token.
 * `overrides` merges over `VALID` before either call — Task 2's follow tests
 * need a SECOND, distinct account on the same `app()` instance, e.g.
 * `tokenForValidUser(a, { handle: "rina", email: "rina@example.com" })`.
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

async function requestReset(body: unknown, a = app()) {
  return a.request("/users/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function completeReset(body: unknown, a = app()) {
  return a.request("/users/password-reset/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pulls the 64-char hex reset token out of the link in a sent email/WhatsApp body. */
function extractToken(body: string): string {
  const match = /\/reset\/([0-9a-f]{64})/.exec(body);
  if (!match) throw new Error(`no reset token found in message body: ${body}`);
  return match[1];
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

  /**
   * **Reserved handles.** `/users` mounts literal segments — `/users/feed`,
   * `/users/signup` — beside the parameterised `/users/:handle/follow` and
   * `/users/:handle/posts`. Registering one of those literals as a handle gives
   * that account a permanently unreachable profile and makes it followable but
   * never unfollowable. Task 2's review fixed the mount-order half of this
   * (C1) and parked the rest.
   *
   * 409 rather than 400: `SignupPage.describe()` already turns a 409 into
   * "Handle ini sudah digunakan. Coba handle lain." — true from where the
   * person is standing, in Bahasa, and actionable, with no web change. A 400
   * from a use case carries no `fieldErrors`, so it would show a vaguer
   * sentence than the one this already produces.
   */
  it("rejects each reserved handle with 409, and none of them creates an account", async () => {
    for (const handle of ["posts", "feed", "signup", "login", "explore"]) {
      const res = await signup({ ...VALID, handle, email: `${handle}@example.com` });
      expect({ handle, status: res.status }).toEqual({ handle, status: 409 });

      // The email must be untouched too — a reserved handle rejected AFTER the
      // insert would leave a row behind and burn the address. Proven by the
      // address still being free for a real signup, not by reading the table.
      const rescue = await signup({
        ...VALID,
        handle: `real_${handle}`,
        email: `${handle}@example.com`,
      });
      expect(rescue.status).toBe(201);
    }
  });

  it("normalises before deciding: @Posts and  FEED  are reserved too", async () => {
    const withAt = await signup({ ...VALID, handle: "@Posts", email: "a@example.com" });
    expect(withAt.status).toBe(409);

    const padded = await signup({ ...VALID, handle: "  FEED  ", email: "b@example.com" });
    expect(padded.status).toBe(409);
  });

  it("a handle that merely CONTAINS a reserved word still registers", async () => {
    const res = await signup({ ...VALID, handle: "postscript", email: "c@example.com" });
    expect(res.status).toBe(201);
  });

  /**
   * **The guard that keeps `RESERVED_HANDLES` honest.** It re-derives the
   * collision set from the app's OWN routing table rather than from a second
   * hand-written list, so `app.route("/users", ...)` gaining `/users/trending`
   * tomorrow fails here instead of stranding whoever registered `trending`.
   *
   * Subset, not equality: reserving MORE than the routes require is safe
   * (a future product decision might reserve `admin`), reserving less is the
   * bug. `isValidHandle` is the filter because a segment nobody can register
   * — `me`, `by-handle`, `password-reset` — needs no protecting.
   */
  it("every literal /users segment a handle could shadow is in RESERVED_HANDLES", () => {
    const shadowable = new Set<string>();
    for (const route of app().routes) {
      if (!route.path.startsWith("/users/")) continue;
      const segment = route.path.slice("/users/".length).split("/")[0];
      if (segment === undefined || segment.startsWith(":")) continue;
      if (isValidHandle(segment)) shadowable.add(segment);
    }

    // A POSITIVE control: if this ever reads zero segments the assertion below
    // passes vacuously and the guard silently stops guarding.
    expect(shadowable.size).toBeGreaterThanOrEqual(5);

    const unprotected = [...shadowable].filter((segment) => !isReservedHandle(segment)).sort();
    expect(unprotected).toEqual([]);
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
    // Whole-branch review item 4: this was the only one of the four
    // response shapes with no key assertion — by-handle, /users/me and
    // PATCH /users/me all pin `Object.keys(body).sort()`, login did not.
    // Replacing `AuthenticateUser`'s explicit `user: { id, handle, email,
    // displayName }` projection with `user: { ...profile }` (a spread of the
    // full `UserRecord`) left 60 pass / 0 fail and typecheck green, leaking
    // `bio`, `whatsappNumber`, `createdAt` and `sessionEpoch`. This is what
    // catches that.
    expect(Object.keys(body.user).sort()).toEqual(["displayName", "email", "handle", "id"]);
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
  it("returns EXACTLY handle/displayName/bio/createdAt/followerCount/followingCount/viewerFollows — no email, no anything else", async () => {
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
    expect(Object.keys(body).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "followerCount",
      "followingCount",
      "handle",
      "viewerFollows",
    ]);
    expect(body.handle).toBe("wildan");
    expect(body.displayName).toBe(VALID.displayName);
    expect(body.followerCount).toBe(0);
    expect(body.followingCount).toBe(0);
    // No session sent — anonymous viewer. Must be `null`, not `false`.
    expect(body.viewerFollows).toBeNull();
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

  it("viewerFollows is false for a signed-in viewer who does not follow the target", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const viewerToken = await tokenForValidUser(a, { handle: "viewer", email: "viewer@example.com" });

    const res = await a.request("/users/by-handle/wildan", { headers: authed(viewerToken) });
    expect(res.status).toBe(200);
    expect((await res.json()).viewerFollows).toBe(false);
  });

  it("viewerFollows is true once the signed-in viewer follows the target", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const viewerToken = await tokenForValidUser(a, { handle: "viewer", email: "viewer@example.com" });

    const follow = await a.request("/users/wildan/follow", {
      method: "POST",
      headers: authed(viewerToken),
    });
    expect(follow.status).toBe(200);

    const res = await a.request("/users/by-handle/wildan", { headers: authed(viewerToken) });
    expect(res.status).toBe(200);
    expect((await res.json()).viewerFollows).toBe(true);
  });

  it("an invalid bearer token on a PUBLIC route degrades to anonymous, not a 401", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/by-handle/wildan", { headers: authed("garbage") });
    expect(res.status).toBe(200);
    expect((await res.json()).viewerFollows).toBeNull();
  });
});

describe("POST /users/:handle/follow and DELETE /users/:handle/follow", () => {
  it("requires auth — no Authorization header is a 401 for follow", async () => {
    const res = await app().request("/users/wildan/follow", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("requires auth — no Authorization header is a 401 for unfollow", async () => {
    const res = await app().request("/users/wildan/follow", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("follows and returns 200 { following: true } for a signed-in caller", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    const res = await a.request("/users/wildan/follow", {
      method: "POST",
      headers: authed(followerToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: true });
  });

  it("following again is idempotent — still 200 { following: true }, count does not double", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(followerToken) });
    const second = await a.request("/users/wildan/follow", {
      method: "POST",
      headers: authed(followerToken),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ following: true });

    const profile = await a.request("/users/by-handle/wildan");
    expect((await profile.json()).followerCount).toBe(1);
  });

  it("unfollows and returns 200 { following: false }", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(followerToken) });
    const res = await a.request("/users/wildan/follow", {
      method: "DELETE",
      headers: authed(followerToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: false });
  });

  it("unfollowing someone never followed is idempotent — 200 { following: false }, no error", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    const res = await a.request("/users/wildan/follow", {
      method: "DELETE",
      headers: authed(followerToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: false });
  });

  it("404s for an unknown handle", async () => {
    const a = app();
    const followerToken = await tokenForValidUser(a, {});

    const res = await a.request("/users/nobody-at-all/follow", {
      method: "POST",
      headers: authed(followerToken),
    });
    expect(res.status).toBe(404);
  });

  it("REJECTS a self-follow with 409 and the exact Indonesian message — refused by the use case, not the database", async () => {
    const a = app();
    const token = await tokenForValidUser(a, {});

    const res = await a.request("/users/wildan/follow", {
      method: "POST",
      headers: authed(token),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "tidak bisa mengikuti akun sendiri" });
  });

  it("a handle sent with a leading @ still resolves for follow", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    const res = await a.request("/users/%40wildan/follow", {
      method: "POST",
      headers: authed(followerToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: true });
  });
});

describe("GET /users/:handle/followers and GET /users/:handle/following", () => {
  it("404s followers for an unknown handle", async () => {
    const res = await app().request("/users/nobody-at-all/followers");
    expect(res.status).toBe(404);
  });

  it("404s following for an unknown handle", async () => {
    const res = await app().request("/users/nobody-at-all/following");
    expect(res.status).toBe(404);
  });

  it("returns the three public fields for a follower — no id, no email", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const followerToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(followerToken) });

    const res = await a.request("/users/wildan/followers");
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    // `viewerFollows` joins the projection in the final review's item 1 — the
    // three list endpoints each answer it per row now, exactly the shape
    // `/by-handle/:handle` already returned. Still no `id`, still no `email`.
    expect(Object.keys(rows[0]).sort()).toEqual(["bio", "displayName", "handle", "viewerFollows"]);
    expect(rows[0].handle).toBe("rina");

    const followingRes = await a.request("/users/rina/following");
    expect(followingRes.status).toBe(200);
    const followingRows = await followingRes.json();
    expect(followingRows).toHaveLength(1);
    // Mirrors the `/followers` key-set assertion just above — before this,
    // `/following` had no route-level key-set coverage at all (coverage
    // asymmetry review round 2 flagged as a Minor; `ListFollows` uses the
    // SAME `FollowListRow` projection for both directions, but nothing said
    // so for this one).
    expect(Object.keys(followingRows[0]).sort()).toEqual([
      "bio",
      "displayName",
      "handle",
      "viewerFollows",
    ]);
    expect(followingRows[0].handle).toBe("wildan");
  });

  it("returns an empty array, not an error, when nobody follows the target", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/wildan/followers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  /**
   * FINAL REVIEW, MUST-FIX ITEM 1. These three list endpoints returned only
   * `["bio","displayName","handle"]` with or without a token, so every row on
   * `/@you/mengikuti` — the list of everyone you follow, by definition —
   * rendered "Ikuti". Task 6 measured the consequence in a real browser: tap 1
   * was a silent no-op re-follow, tap 2 was the real DELETE, so unfollowing
   * from a list took two taps and the first did nothing visible.
   *
   * `viewerFollows` here means exactly what it means on `/by-handle/:handle`:
   * `null` for an anonymous request, `boolean` for a signed-in one. It is
   * `false` on the viewer's OWN row, not some third value — the API emits no
   * self-signal, and a client must decide "is this me?" by comparing handles
   * (see `FollowButton`'s own docstring). That is a binding ledger ruling and
   * these tests pin it rather than change it.
   */
  it("anonymous: every row's viewerFollows is null, never false", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await a.request("/users/wildan/follow", { method: "POST", headers: authed(rinaToken) });

    const followers = await (await a.request("/users/wildan/followers")).json();
    const following = await (await a.request("/users/rina/following")).json();

    expect(followers).toHaveLength(1);
    expect(followers[0].viewerFollows).toBeNull();
    expect(following).toHaveLength(1);
    expect(following[0].viewerFollows).toBeNull();
  });

  it("signed in: viewerFollows is true for a row the viewer follows and false for one they do not", async () => {
    const a = app();
    // wildan follows rina, and nobody else.
    const wildanToken = await tokenForValidUser(a, {});
    await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await tokenForValidUser(a, { handle: "budi", email: "budi@example.com" });
    const rinaAndBudiFollowTarget = await tokenForValidUser(a, {
      handle: "target",
      email: "target@example.com",
    });
    void rinaAndBudiFollowTarget;
    await a.request("/users/rina/follow", { method: "POST", headers: authed(wildanToken) });

    // Both rina and budi follow `target`, so /target/followers has two rows —
    // one wildan follows, one wildan does not. A single request, two answers.
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    const budiToken = await tokenForValidUser(a, { handle: "budi", email: "budi@example.com" });
    await a.request("/users/target/follow", { method: "POST", headers: authed(rinaToken) });
    await a.request("/users/target/follow", { method: "POST", headers: authed(budiToken) });

    const rows = await (
      await a.request("/users/target/followers", { headers: authed(wildanToken) })
    ).json();

    expect(rows).toHaveLength(2);
    const byHandle = Object.fromEntries(rows.map((r: { handle: string; viewerFollows: unknown }) => [r.handle, r.viewerFollows]));
    expect(byHandle.rina).toBe(true);
    expect(byHandle.budi).toBe(false);
  });

  it("signed in: the viewer's OWN row is false, not null and not true — no self-signal", async () => {
    const a = app();
    const wildanToken = await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    // wildan and rina both follow `target`, so wildan sees its own row in the list.
    await tokenForValidUser(a, { handle: "target", email: "target@example.com" });
    await a.request("/users/target/follow", { method: "POST", headers: authed(wildanToken) });
    await a.request("/users/target/follow", { method: "POST", headers: authed(rinaToken) });

    const rows = await (
      await a.request("/users/target/followers", { headers: authed(wildanToken) })
    ).json();

    const own = rows.find((r: { handle: string }) => r.handle === "wildan");
    expect(own).toBeDefined();
    expect(own.viewerFollows).toBe(false);
  });

  it("an invalid bearer token on these PUBLIC lists degrades to anonymous, not a 401", async () => {
    const a = app();
    await tokenForValidUser(a, {});
    const rinaToken = await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await a.request("/users/wildan/follow", { method: "POST", headers: authed(rinaToken) });

    const res = await a.request("/users/wildan/followers", { headers: authed("not-a-jwt") });

    // Same contract `/by-handle/:handle` already has: `resolveViewerId` never
    // throws on these routes, so a stale token from a previous session must not
    // lock a visitor out of browsing — it degrades to the anonymous view.
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows[0].viewerFollows).toBeNull();
  });

  /**
   * Review round 2, IMPORTANT 1: `DEFAULT_FOLLOW_LIST_LIMIT` used to be
   * declared TWICE — once (tested) inside `ListFollows`, and once (untested)
   * as a private duplicate in `routes/users.ts`. Since `parseFollowListLimit`
   * always resolves a concrete number before calling `ListFollows.execute`,
   * the ROUTE's own constant was the one actually reachable from an HTTP
   * request with no `?limit=` — and it had zero coverage: changing it from
   * 50 to 5 left every one of the 73 route tests green. `routes/users.ts`
   * now imports the single, tested `DEFAULT_FOLLOW_LIST_LIMIT` rather than
   * declaring its own; this seeds MORE than that default and pins the count
   * on the real HTTP path, so a regression of either kind (a reintroduced
   * duplicate, or a changed value) fails here.
   */
  it("defaults to 50 rows with no ?limit=, even when more than 50 people follow the target", async () => {
    const a = app();
    await tokenForValidUser(a, {});

    const followerTokens = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        tokenForValidUser(a, { handle: `follower${i}`, email: `follower${i}@example.com` })
      )
    );
    await Promise.all(
      followerTokens.map((token) =>
        a.request("/users/wildan/follow", { method: "POST", headers: authed(token) })
      )
    );

    const res = await a.request("/users/wildan/followers");
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(50);
    // EXPLICIT TIMEOUT, because this test signs up 61 real users and every
    // signup pays for an argon2id hash — deliberately expensive, and the one
    // cost here that scales with the box rather than with the code. Measured at
    // ~224ms per hash on a slower machine, which puts the 61 of them alone over
    // Bun's 5000ms default and made this the only red in the whole suite there.
    // The assertion above is unchanged; only the wall-clock allowance moved, and
    // 30s is still far under anything a real regression in this endpoint would
    // need. Seeding the users directly would be faster but would stop exercising
    // the real HTTP signup path these tokens come from.
  }, 30_000);

  it("rejects an out-of-range ?limit= with 400", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/wildan/followers?limit=101");
    expect(res.status).toBe(400);
  });

  /**
   * Review round 2, IMPORTANT 2: the ONLY existing limit test was
   * `?limit=101 -> 400`, which passes even if `MAX_FOLLOW_LIST_LIMIT` were
   * lowered to 25 — nothing pinned the boundary from the accepting side.
   * `?limit=100 -> 200` closes that: lowering the cap below 100 now fails
   * this test specifically, not just the rejection test.
   */
  it("accepts the maximum allowed ?limit=100", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/wildan/followers?limit=100");
    expect(res.status).toBe(200);
  });
});

/**
 * Seeds `count` users directly through the database rather than via
 * `POST /users/signup` — signup hashes a real password (argon2, through
 * `BunPasswordHasher`), and seeding two dozen-plus users that way is both
 * slow and, under root-level parallel-workspace load, exactly the shape of
 * test that has hit the documented CPU-contention timeout before (see the
 * followers/following `defaults to 50 rows` test above/`diudara-named-flakes`
 * item 6). Nothing here exercises signup, so bypassing it is not a coverage
 * loss — it only needs `count` real rows in `app_user` to exist.
 */
async function seedManyDirectly(count: number, prefix: string): Promise<void> {
  await db.insert(appUsers).values(
    Array.from({ length: count }, (_unused, i) => ({
      handle: `${prefix}${i}`,
      email: `${prefix}${i}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: `${prefix} ${i}`,
    }))
  );
}

/**
 * `GET /users/explore` — Jelajah, the discovery screen a new user with an
 * empty follow graph lands on. Public, unauthenticated, like `by-handle`
 * and the followers/following lists above.
 */
describe("GET /users/explore", () => {
  it("with no ?q: returns both lists and an empty results — the screen's default state, not an error", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/explore");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.results).toEqual([]);
    expect(body.newest.length).toBeGreaterThan(0);
    expect(body.mostFollowed.length).toBeGreaterThan(0);
  });

  it("a whitespace-only ?q= behaves identically to no ?q at all", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request(`/users/explore?q=${encodeURIComponent("   ")}`);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });

  it("with a ?q, returns matching users in results, alongside both other lists", async () => {
    const a = app();
    await tokenForValidUser(a, { handle: "wildan", email: "wildan@example.com" });
    await tokenForValidUser(a, {
      handle: "budi",
      email: "budi@example.com",
      displayName: "Budi Santoso",
    });

    const res = await a.request("/users/explore?q=wild");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.results).toHaveLength(1);
    expect(body.results[0].handle).toBe("wildan");
    expect(body.newest.length).toBeGreaterThan(0);
    expect(body.mostFollowed.length).toBeGreaterThan(0);
  });

  it("returns only the three public fields in every list — no id, no email", async () => {
    const a = app();
    await tokenForValidUser(a, { handle: "wildan", email: "wildan@example.com" });

    const res = await a.request("/users/explore?q=wild");
    const body = await res.json();

    for (const list of [body.results, body.newest, body.mostFollowed]) {
      expect(list.length).toBeGreaterThan(0);
      for (const row of list) {
        expect(Object.keys(row).sort()).toEqual(["bio", "displayName", "handle", "viewerFollows"]);
      }
    }
  });

  it("requires no session — an anonymous request (no Authorization header) succeeds", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/explore");
    expect(res.status).toBe(200);
  });

  /**
   * Final review, item 1 — Jelajah's rows too, and across ALL THREE of its
   * lists in one response. `FollowRow` renders the same component on `/jelajah`
   * as on the two list pages, so a per-row answer here is what stops "Ikuti"
   * appearing next to somebody the visitor already follows.
   */
  it("anonymous: viewerFollows is null in every one of the three lists", async () => {
    const a = app();
    await tokenForValidUser(a, { handle: "wildan", email: "wildan@example.com" });

    const body = await (await a.request("/users/explore?q=wild")).json();

    for (const list of [body.results, body.newest, body.mostFollowed]) {
      expect(list.length).toBeGreaterThan(0);
      for (const row of list) expect(row.viewerFollows).toBeNull();
    }
  });

  it("signed in: viewerFollows is true for the followed account and false for the viewer's own row", async () => {
    const a = app();
    const wildanToken = await tokenForValidUser(a, {});
    await tokenForValidUser(a, { handle: "rina", email: "rina@example.com" });
    await tokenForValidUser(a, { handle: "budi", email: "budi@example.com" });
    await a.request("/users/rina/follow", { method: "POST", headers: authed(wildanToken) });

    const body = await (
      await a.request("/users/explore?limit=100", { headers: authed(wildanToken) })
    ).json();

    const byHandle = Object.fromEntries(
      body.newest.map((r: { handle: string; viewerFollows: unknown }) => [r.handle, r.viewerFollows])
    );
    expect(byHandle.rina).toBe(true);
    expect(byHandle.budi).toBe(false);
    // Your own row appears in "Akun terbaru" and must not claim you follow
    // yourself — `false`, the same no-self-signal `/by-handle/:handle` uses.
    expect(byHandle.wildan).toBe(false);
  });

  /**
   * THE GUARANTEE, proven end-to-end over real HTTP rather than only inside
   * the repository test: Jelajah's search box must never become an oracle
   * for whether an email address is registered. See
   * `drizzle-user.repository.test.ts`'s identically-named-in-spirit
   * guarantee test for the full rationale (Phase 1's 215ms->1.75ms timing
   * closure this would otherwise undo in one line).
   */
  it("the guarantee: searching a registered user's email address returns zero results", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID, email: "rahasia@example.com" }),
    });

    const res = await a.request(`/users/explore?q=${encodeURIComponent("rahasia@example.com")}`);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);

    const localPartRes = await a.request("/users/explore?q=rahasia");
    expect((await localPartRes.json()).results).toEqual([]);
  });

  /**
   * THE OTHER HALF OF THE SAME GUARANTEE, at the ROUTE layer — final review
   * M3. Adding `ilike(appUsers.email, pattern)` to `searchPublic`'s `or(...)`
   * failed TWO tests (the repository guarantee and the route one above);
   * adding `ilike(appUsers.whatsappNumber, pattern)` failed only ONE, because
   * there was no route-level WhatsApp counterpart. Low risk — it is one query
   * and one `or(...)`, so the repository test does cover the real code path —
   * but the asymmetry is the exact shape this project keeps getting caught by,
   * and Task 6's browser gate searched two registered EMAIL addresses and
   * never a WhatsApp number.
   *
   * The number must be seeded NON-NULL for this to be able to fail at all:
   * every other search test on this router leaves `whatsapp_number` NULL, and
   * `NULL ILIKE '...'` matches nothing, so the mutation would sail past them.
   * That is review round 1's Important 1 on the repository side, restated
   * here because the same trap applies to the same column.
   *
   * The prefix (`+62812`) is searched as well as the exact number: a prefix
   * match is what `searchPublic` actually builds (`<query>%`), so an exact-only
   * assertion would pass even against a pattern that matched every Indonesian
   * mobile number in the table.
   */
  it("the guarantee: searching a registered user's WhatsApp number returns zero results", async () => {
    const a = app();
    const res = await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID, whatsappNumber: "+6281234567890" }),
    });
    expect(res.status).toBe(201);
    // The number really is stored — otherwise the two assertions below would
    // be vacuous for the same reason a NULL column makes them vacuous.
    const [stored] = await db.select({ whatsappNumber: appUsers.whatsappNumber }).from(appUsers);
    expect(stored?.whatsappNumber).toBe("+6281234567890");

    const exact = await a.request(`/users/explore?q=${encodeURIComponent("+6281234567890")}`);
    expect(exact.status).toBe(200);
    expect((await exact.json()).results).toEqual([]);

    const prefix = await a.request(`/users/explore?q=${encodeURIComponent("+62812")}`);
    expect(prefix.status).toBe(200);
    expect((await prefix.json()).results).toEqual([]);
  });

  it("rejects an out-of-range ?limit= with 400", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/explore?limit=101");
    expect(res.status).toBe(400);
  });

  // Same "test both sides of the boundary" discipline as the followers/
  // following `?limit=100` test above — Task 2's review found the FOURTH
  // instance of a cap that could be silently lowered with only the
  // rejection side under test.
  it("accepts the maximum allowed ?limit=100", async () => {
    const a = app();
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await a.request("/users/explore?limit=100");
    expect(res.status).toBe(200);
  });

  /**
   * Review round 1, Important 3: `DEFAULT_EXPLORE_LIMIT` was imported from
   * the single tested source (unlike Task 2's `DEFAULT_FOLLOW_LIST_LIMIT`
   * duplicate), but nothing on the real HTTP path pinned its VALUE —
   * changing `20` to `1` left the whole suite green. Mirrors
   * `routes/users.test.ts`'s own `defaults to 50 rows with no ?limit=`
   * test for the followers list: seed more than the default and pin the
   * exact row count with no `?limit=` on the request.
   *
   * The expected count below is the LITERAL `20`, deliberately NOT
   * `DEFAULT_EXPLORE_LIMIT` — asserting against the same constant the
   * production code reads would make this test move in lockstep with any
   * regression to that constant and pass vacuously, exactly the trap this
   * test exists to catch. Only the SEED count below uses the import, so a
   * future change to the default doesn't also require hand-editing how
   * many rows get seeded.
   */
  it("defaults to 20 rows per list with no ?limit=, even when more exist", async () => {
    const a = app();
    await seedManyDirectly(DEFAULT_EXPLORE_LIMIT + 5, "explorer");

    const res = await a.request("/users/explore");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.newest).toHaveLength(20);
    expect(body.mostFollowed).toHaveLength(20);
  });

  /**
   * Review round 1, Minor: `q` had no length bound at all — every other
   * user-supplied string on this router does (`handle` 31, `displayName`
   * 255, `bio` 300). Both sides of the boundary, same discipline as the
   * `?limit=` pair above.
   */
  it("rejects a ?q= longer than 100 characters with 400", async () => {
    const a = app();
    const res = await a.request(`/users/explore?q=${"a".repeat(101)}`);
    expect(res.status).toBe(400);
  });

  it("accepts a ?q= of exactly 100 characters", async () => {
    const a = app();
    const res = await a.request(`/users/explore?q=${"a".repeat(100)}`);
    expect(res.status).toBe(200);
  });
});

/**
 * Task 7 of images. Public and cheap — the web fetches this once at boot to
 * learn how many photos a post may carry, since it is a static nginx build
 * and cannot read the API's own `MAX_POST_IMAGES` env var (images design
 * spec §6). Deliberately unauthenticated: a composer that has not signed in
 * yet still needs to know the limit.
 */
describe("GET /users/limits", () => {
  it("reports the configured maximum, without auth — LITERAL 5", async () => {
    const res = await app().request("/users/limits");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxPostImages: 5 });
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

  /**
   * Whole-branch review item 1: `whatsappNumber` was written only at signup
   * (`userSignupSchema`) and never had an update path — a typo or a skipped
   * number at signup was permanent. Round-trip/clear/absent, driven through
   * the real HTTP route, mirroring the bio trio immediately above.
   */
  it("sets a whatsappNumber that was previously absent — the round-trip", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ whatsappNumber: "+6281234567890" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).whatsappNumber).toBe("+6281234567890");

    const confirm = await a.request("/users/me", { headers: authed(token) });
    expect((await confirm.json()).whatsappNumber).toBe("+6281234567890");
  });

  it("clears the whatsappNumber with an EXPLICIT null", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ whatsappNumber: "+6281234567890" }),
    });

    const cleared = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ whatsappNumber: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).whatsappNumber).toBeNull();
  });

  it("an ABSENT whatsappNumber leaves the existing value alone", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ whatsappNumber: "+6281234567890" }),
    });

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ displayName: "Only Name Changed Again" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).whatsappNumber).toBe("+6281234567890");
  });

  it("rejects a malformed whatsappNumber with 400", async () => {
    const a = app();
    const token = await tokenForValidUser(a);

    const res = await a.request("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authed(token) },
      body: JSON.stringify({ whatsappNumber: "not-a-number" }),
    });
    expect(res.status).toBe(400);
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

/**
 * Review finding F4's pinning test: `clientIp` must read the LAST
 * `X-Forwarded-For` entry, not the first — mutating it back to the first
 * entry must fail this test. Driven through a real Hono `Context` (a
 * throwaway app with one route) rather than a hand-built fake, since
 * `Context` has no small, stable shape worth faking.
 */
describe("clientIp", () => {
  function ipApp() {
    const a = new Hono();
    a.get("/ip", (c) => c.json({ ip: clientIp(c) }));
    return a;
  }

  it("returns null when the header is absent", async () => {
    const res = await ipApp().request("/ip");
    expect((await res.json()).ip).toBeNull();
  });

  it("returns the single entry when there is only one", async () => {
    const res = await ipApp().request("/ip", { headers: { "X-Forwarded-For": "203.0.113.42" } });
    expect((await res.json()).ip).toBe("203.0.113.42");
  });

  it("returns the LAST entry of a multi-hop chain, not the first — the first is client-supplied", async () => {
    const res = await ipApp().request("/ip", {
      headers: { "X-Forwarded-For": "9.9.9.9, 10.0.0.1, 172.16.0.5" },
    });
    expect((await res.json()).ip).toBe("172.16.0.5");
  });

  it("trims whitespace around the last entry", async () => {
    const res = await ipApp().request("/ip", {
      headers: { "X-Forwarded-For": "9.9.9.9,   172.16.0.5  " },
    });
    expect((await res.json()).ip).toBe("172.16.0.5");
  });

  it("returns null for an empty header", async () => {
    const res = await ipApp().request("/ip", { headers: { "X-Forwarded-For": "" } });
    expect((await res.json()).ip).toBeNull();
  });
});

describe("POST /users/password-reset/request", () => {
  it("returns 200 { ok: true } for an unknown email", async () => {
    const res = await requestReset({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 200 { ok: true } for a KNOWN email, and sends a real reset link over email", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const res = await requestReset({ email: VALID.email }, a);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const email = deps.email as FakeEmailAdapter;
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(VALID.email);
  });

  it("the known-email and unknown-email responses are byte-identical — enumeration safety", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    const known = await requestReset({ email: VALID.email }, a);
    const unknown = await requestReset({ email: "nobody-at-all@example.com" }, a);

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app().request("/users/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing email with 400", async () => {
    const res = await requestReset({});
    expect(res.status).toBe(400);
  });

  it("still returns 200 { ok: true } once the per-account rate limit (3/hour) is exceeded, and stops sending", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });

    for (let i = 0; i < 3; i++) {
      const res = await requestReset({ email: VALID.email }, a);
      expect(res.status).toBe(200);
    }
    const email = deps.email as FakeEmailAdapter;
    expect(email.sent).toHaveLength(3);

    const fourth = await requestReset({ email: VALID.email }, a);
    expect(fourth.status).toBe(200);
    expect(await fourth.json()).toEqual({ ok: true });
    expect(email.sent).toHaveLength(3);
  });
});

describe("POST /users/password-reset/complete", () => {
  it("rejects an unknown token with 401", async () => {
    const res = await completeReset({ token: "a".repeat(64), newPassword: "brand-new-password" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app().request("/users/password-reset/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a short new password with 400", async () => {
    const res = await completeReset({ token: "a".repeat(64), newPassword: "short" });
    expect(res.status).toBe(400);
  });

  /**
   * Step 3 / Step 6 of the task brief, together: a full round trip through the
   * REAL routes — signup, log in, request a reset, extract the real token from
   * the real (fake-adapter) email, complete the reset, and confirm three
   * things a fake repository could not: the OLD password stops working, the
   * NEW one works, and — the assertion the epoch mechanism exists for — the
   * OLD session token is rejected by the real `requireUserAuth` middleware
   * once the reset lands. Mirrors the equivalent test in the `GET /users/me`
   * block above (Task 3's `setPasswordAndBumpEpoch` proof), but driven
   * through `CompletePasswordReset` rather than the repository directly.
   */
  it("sets a new password and ends every existing session — the OLD bearer token 401s afterwards", async () => {
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
    const { token: oldToken } = (await loginRes.json()) as { token: string };

    const stillGood = await a.request("/users/me", { headers: authed(oldToken) });
    expect(stillGood.status).toBe(200);

    await requestReset({ email: VALID.email }, a);
    const email = deps.email as FakeEmailAdapter;
    expect(email.sent).toHaveLength(1);
    const resetToken = extractToken(email.sent[0].body);

    const completeRes = await completeReset({ token: resetToken, newPassword: "brand-new-password" }, a);
    expect(completeRes.status).toBe(200);
    expect(await completeRes.json()).toEqual({ ok: true });

    // THE session-epoch proof: the token minted before the reset is dead.
    const afterReset = await a.request("/users/me", { headers: authed(oldToken) });
    expect(afterReset.status).toBe(401);

    // The OLD password no longer works.
    const oldPasswordLogin = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: VALID.email, password: VALID.password }),
    });
    expect(oldPasswordLogin.status).toBe(401);

    // The NEW password does.
    const newPasswordLogin = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: VALID.email, password: "brand-new-password" }),
    });
    expect(newPasswordLogin.status).toBe(200);
  });

  it("rejects the SAME token a second time — completing a reset consumes it", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    await requestReset({ email: VALID.email }, a);
    const email = deps.email as FakeEmailAdapter;
    const resetToken = extractToken(email.sent[0].body);

    const first = await completeReset({ token: resetToken, newPassword: "brand-new-password" }, a);
    expect(first.status).toBe(200);

    const second = await completeReset({ token: resetToken, newPassword: "yet-another-password" }, a);
    expect(second.status).toBe(401);
  });

  it("invalidates every OTHER outstanding token for the user, not just the one that was used", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const email = deps.email as FakeEmailAdapter;

    await requestReset({ email: VALID.email }, a);
    await requestReset({ email: VALID.email }, a);
    expect(email.sent).toHaveLength(2);
    const firstToken = extractToken(email.sent[0].body);
    const secondToken = extractToken(email.sent[1].body);

    const completed = await completeReset({ token: firstToken, newPassword: "brand-new-password" }, a);
    expect(completed.status).toBe(200);

    // The SECOND, never-used link is now dead too.
    const secondAttempt = await completeReset({ token: secondToken, newPassword: "another-password" }, a);
    expect(secondAttempt.status).toBe(401);
  });
});

describe("POST /users/signup — Task 5's existing-email notice", () => {
  it("sends exactly one message to the existing account's channel, and the response is byte-identical to a fresh signup's", async () => {
    const deps = bootstrap();
    const a = createApp(deps);

    const fresh = await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const freshStatus = fresh.status;
    const freshBody = await fresh.json();

    const email = deps.email as FakeEmailAdapter;
    expect(email.sent).toHaveLength(0);

    const duplicate = await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID, handle: "someoneelse" }),
    });

    expect(duplicate.status).toBe(freshStatus);
    expect(await duplicate.json()).toEqual(freshBody);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(VALID.email);
  });

  it("falls back to WhatsApp for the notice when the existing owner has a number and email is disabled", async () => {
    // `email` is only `null` when RESEND_API_KEY/EMAIL_FROM are unset AND
    // NODE_ENV is outside RELAXED_NODE_ENVS — not reachable from `bootstrap()`
    // under `NODE_ENV=test`. This drives `RegisterUser` directly instead,
    // proving the SAME wiring `bootstrap()` would produce on a box with no
    // email provider: `deps.messaging.notifier` is what `RegisterUser` is
    // constructed with either way.
    const deps = bootstrap();
    const notifier = deps.messaging.notifier as FakeMessagingAdapter;
    // A throwaway, never-limiting signup-notice ledger and a real-time
    // clock — this test is about the CHANNEL fallback, not the rate limit,
    // which has its own dedicated tests in register-user.test.ts.
    const useCase = new RegisterUser(
      deps.userRepository,
      new BunPasswordHasher(),
      null,
      notifier,
      { async countForUserSince() { return 0; }, async record() {} },
      { now: () => new Date() }
    );

    await deps.userRepository.create({
      handle: "existing",
      email: "existing@example.com",
      whatsappNumber: "+6281234567890",
      passwordHash: "irrelevant",
      displayName: "Existing",
    });

    const result = await useCase.execute({ ...VALID, handle: "newhandle", email: "existing@example.com" });

    expect(result).toEqual({ ok: true });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe("+6281234567890");
  });
});

/**
 * Phase 5a Task 3. The one route pair that decides whether money can reach a
 * user at all — Task 4 cannot publish a tier without it and Task 6 has nowhere
 * to settle an invoice.
 *
 * `/users/me/payout` is TWO literal segments deep, and the first of them is
 * `me`, which `HANDLE_PATTERN` (`^[a-z0-9_]{3,30}$`) already makes impossible to
 * register at 2 characters. So `payout` is deliberately NOT added to
 * `RESERVED_HANDLES`: the route-derived guard above reads only the FIRST segment
 * after `/users/`, nothing here can shadow a profile, and reserving an ordinary
 * Indonesian-usable word to prevent a collision that cannot occur would take it
 * from users for nothing. `handle.ts` says the same about `me`/`by-handle`/
 * `password-reset` already.
 */
describe("GET /users/me/payout and POST /users/me/payout", () => {
  /** Signs up, logs in, and returns both the bearer token and the user's id. */
  async function payoutUser(a: ReturnType<typeof app>, overrides: Partial<typeof VALID> = {}) {
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
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, userId: body.user.id };
  }

  function connect(a: ReturnType<typeof app>, token: string) {
    return a.request("/users/me/payout", { method: "POST", headers: authed(token) });
  }

  it("rejects an unauthenticated read with 401", async () => {
    expect((await app().request("/users/me/payout")).status).toBe(401);
  });

  it("rejects an unauthenticated connect with 401", async () => {
    const res = await app().request("/users/me/payout", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("reports neither connected nor provisioning for a user who has never connected", async () => {
    const a = app();
    const { token } = await payoutUser(a);

    const res = await a.request("/users/me/payout", { headers: authed(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, provisioning: false, available: true });
  });

  it("connects on POST, and the GET agrees afterwards", async () => {
    const a = app();
    const { token } = await payoutUser(a);

    const post = await connect(a, token);

    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ connected: true, provisioning: false, available: true });

    const get = await a.request("/users/me/payout", { headers: authed(token) });
    expect(await get.json()).toEqual({ connected: true, provisioning: false, available: true });
  });

  it("never puts the provider account id in the response body", async () => {
    // The id belongs on the server side of `for_account_id` and nowhere else.
    // The two booleans are everything a screen needs.
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, userId } = await payoutUser(a);

    const post = await connect(a, token);

    const accountId = (await deps.userPayoutRepository.findPayoutAccount(userId))
      ?.xenditAccountId;
    expect(accountId).toBeTruthy();
    expect(await post.text()).not.toContain(accountId!);
  });

  it("is idempotent across a second POST — one provider account, not two", async () => {
    // A user WILL press this twice on a slow connection. A Xendit MANAGED
    // sub-account is a KYC entity with no delete endpoint, so a second one is
    // permanent.
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, userId } = await payoutUser(a);

    const first = await connect(a, token);
    const second = await connect(a, token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      connected: true,
      provisioning: false,
      available: true,
    });
    const payments = deps.payments as unknown as { accounts: { accountId: string }[] };
    expect(payments.accounts).toHaveLength(1);
    expect((await deps.userPayoutRepository.findPayoutAccount(userId))?.xenditAccountId).toBe(
      payments.accounts[0].accountId
    );
  });

  it("reports provisioning while a claim is held, without calling the provider", async () => {
    // Seeded through the repository, exactly as `payment-account.test.ts` does
    // for creators: POSTing to reach this state would provision a real KYC
    // entity in the real adapter, and there is no way to delete one.
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, userId } = await payoutUser(a);
    expect(await deps.userPayoutRepository.beginXenditAccountProvisioning(userId)).toBe(true);

    const res = await a.request("/users/me/payout", { headers: authed(token) });

    expect(res.status).toBe(200);
    // The column is NOT empty here — a truthiness check would call this
    // connected and hand `for_account_id: "provisioning:in-progress"` to Xendit.
    expect(await res.json()).toEqual({ connected: false, provisioning: true, available: true });
  });

  it("keeps one user's payout status independent of another's", async () => {
    const a = app();
    const mine = await payoutUser(a);
    const stranger = await payoutUser(a, { handle: "rina", email: "rina@example.com" });

    await connect(a, mine.token);

    expect(await (await a.request("/users/me/payout", { headers: authed(mine.token) })).json())
      .toEqual({ connected: true, provisioning: false, available: true });
    expect(
      await (await a.request("/users/me/payout", { headers: authed(stranger.token) })).json()
    ).toEqual({ connected: false, provisioning: false, available: true });
  });

  it("says available: false and 503s the POST on a box with no payment provider", async () => {
    // `connected: false, provisioning: false` otherwise means two different
    // things — "you have not connected yet" and "this server cannot take
    // payments at all" — and Task 4's publish screen has to tell them apart: the
    // first is fixable by pressing a button, the second is not. Same gap the
    // creator dashboard's `available` closed (payment-account.test.ts).
    const deps = bootstrap();
    const a = createApp({ ...deps, connectUserPayout: undefined });
    const { token } = await payoutUser(a);

    const get = await a.request("/users/me/payout", { headers: authed(token) });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ connected: false, provisioning: false, available: false });

    const post = await connect(a, token);
    expect(post.status).toBe(503);
  });
});
