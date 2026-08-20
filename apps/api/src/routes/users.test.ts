import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { appUsers, userSubscriptions, userTransactions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { FakeEmailAdapter } from "../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../infrastructure/messaging/fake-messaging.adapter";
import { BunPasswordHasher } from "../infrastructure/auth/bun-password.hasher";
import { RegisterUser } from "../application/use-cases/register-user";
import { DEFAULT_EXPLORE_LIMIT } from "../application/use-cases/explore-users";
import { clientIp } from "./users";
import { isReservedHandle, isValidHandle } from "../domain/handle";
import { DrizzleUserSubscriptionRepository } from "../infrastructure/repositories/drizzle-user-subscription.repository";
import { DrizzleUserPurchaseUnitOfWork } from "../infrastructure/repositories/drizzle-user-purchase.unit-of-work";
import type { UserPurchaseUnitOfWorkPort } from "../application/ports/user-purchase-unit-of-work.port";
import { ArrivalLatch } from "../test-support/arrival-latch";
import { StartUserSubscription } from "../application/use-cases/start-user-subscription";
import { SystemClock } from "../infrastructure/clock/system.clock";
import type { FakePaymentAdapter } from "../infrastructure/payments/fake-payment.adapter";

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
  it("returns EXACTLY handle/displayName/bio/createdAt/followerCount/followingCount/viewerFollows/membership — no email, no anything else", async () => {
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
    // here. This is the form that catches that. `membership` was added by
    // Task 5 (memberships-5a) — see the dedicated describe block below for
    // its own closed-projection assertion.
    expect(Object.keys(body).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "followerCount",
      "followingCount",
      "handle",
      "membership",
      "viewerFollows",
    ]);
    expect(body.handle).toBe("wildan");
    expect(body.displayName).toBe(VALID.displayName);
    expect(body.followerCount).toBe(0);
    expect(body.followingCount).toBe(0);
    // No session sent — anonymous viewer. Must be `null`, not `false`.
    expect(body.viewerFollows).toBeNull();
    // Task 10 widened `membership` by one field and the final review by a
    // second, and this assertion is updated deliberately rather than loosened:
    // BOTH viewer booleans are `false` for a visitor with no session — NOT
    // null, unlike `viewerFollows` right above them. See `MembershipView`'s
    // own docstring for why the neighbours disagree on purpose.
    expect(body.membership).toEqual({
      tiers: [],
      viewerIsMember: false,
      viewerMembershipEnded: false,
    });
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

/**
 * Task 5 of memberships-5a (spec §6): the offer on a public profile.
 * `GET /users/by-handle/:handle` gains `membership: { tiers: [...] }`
 * alongside the fields Task 2 already pinned above.
 */
describe("GET /users/by-handle/:handle — membership (Task 5)", () => {
  /** Signs up, logs in, and returns both the bearer token and the user's id — mirrors `payoutUser`/`tierUser` in the payout/tier suites below. */
  async function membershipUser(a: ReturnType<typeof app>, overrides: Partial<typeof VALID> = {}) {
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

  function connectPayout(a: ReturnType<typeof app>, token: string) {
    return a.request("/users/me/payout", { method: "POST", headers: authed(token) });
  }

  function postTier(a: ReturnType<typeof app>, token: string, body: unknown) {
    return a.request("/users/me/tiers", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function patchTier(a: ReturnType<typeof app>, token: string, tierId: string, body: unknown) {
    return a.request(`/users/me/tiers/${tierId}`, {
      method: "PATCH",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("a profile with no payout account and no tiers reports membership: { tiers: [] } — not an omitted field", async () => {
    const a = app();
    await membershipUser(a);

    const res = await a.request("/users/by-handle/wildan");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect("membership" in body).toBe(true);
    expect(body.membership).toEqual({
      tiers: [],
      viewerIsMember: false,
      viewerMembershipEnded: false,
    });
  });

  it("lists a published tier with EXACTLY id/name/priceAmount/billingCycle — never ownerId, isActive or createdAt", async () => {
    const a = app();
    const { token } = await membershipUser(a);
    await connectPayout(a, token);
    const created = await (
      await postTier(a, token, { name: "Anggota", priceAmount: 50_000 })
    ).json();

    const res = await a.request("/users/by-handle/wildan");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.membership.tiers).toHaveLength(1);
    const tier = body.membership.tiers[0];
    expect(Object.keys(tier).sort()).toEqual(["billingCycle", "id", "name", "priceAmount"]);
    expect(tier).toEqual({
      id: created.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
  });

  it("a DEACTIVATED tier is never offered to a visitor", async () => {
    const a = app();
    const { token } = await membershipUser(a);
    await connectPayout(a, token);
    const active = await (
      await postTier(a, token, { name: "Tetap Aktif", priceAmount: 20_000 })
    ).json();
    const toDeactivate = await (
      await postTier(a, token, { name: "Akan Dinonaktifkan", priceAmount: 30_000 })
    ).json();
    await patchTier(a, token, toDeactivate.id, { isActive: false });

    const res = await a.request("/users/by-handle/wildan");
    const body = await res.json();

    expect(body.membership.tiers.map((t: { id: string }) => t.id)).toEqual([active.id]);
  });

  it("membership itself is CLOSED — exactly tiers and the two viewer booleans, nothing else", async () => {
    const a = app();
    const { token } = await membershipUser(a);
    await connectPayout(a, token);
    await postTier(a, token, { name: "Anggota", priceAmount: 50_000 });

    const res = await a.request("/users/by-handle/wildan");

    expect(Object.keys((await res.json()).membership).sort()).toEqual([
      "tiers",
      "viewerIsMember",
      "viewerMembershipEnded",
    ]);
  });

  it("keeps one owner's tiers off another owner's profile", async () => {
    const a = app();
    const owner = await membershipUser(a);
    const stranger = await membershipUser(a, { handle: "rina", email: "rina@example.com" });
    await connectPayout(a, owner.token);
    await postTier(a, owner.token, { name: "Punya Wildan", priceAmount: 50_000 });

    const res = await a.request("/users/by-handle/rina");
    expect(res.status).toBe(200);
    expect((await res.json()).membership).toEqual({
      tiers: [],
      viewerIsMember: false,
      viewerMembershipEnded: false,
    });
  });
});

/**
 * Task 10 of Phase 5a (spec §6): "an already-active member sees that they are
 * a member rather than a buy button" — which the web can only do if the
 * profile tells it. `GET /users/by-handle/:handle` gains
 * `membership.viewerIsMember`, answered by `IsMemberOf` (Task 8).
 *
 * **This is the only thing in 5a that puts `IsMemberOf` on a real request
 * path.** Task 8 built the question Phase 6's whole paywall is founded on and
 * nothing called it; these tests are the first that exercise it through
 * HTTP, against a real database, rather than in isolation.
 *
 * Seeded with the repository directly rather than by paying an invoice: what
 * activates a subscription in production is Task 7's webhook, and a test that
 * had to fake a payment gateway to assert a projection would be testing the
 * wrong thing.
 */
describe("GET /users/by-handle/:handle — viewerIsMember (Task 10)", () => {
  const FUTURE = new Date("2099-01-01T00:00:00.000Z");
  const PAST = new Date("2020-01-01T00:00:00.000Z");

  async function account(a: ReturnType<typeof app>, overrides: Partial<typeof VALID> = {}) {
    const acc = { ...VALID, ...overrides };
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acc),
    });
    const res = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: acc.email, password: acc.password }),
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, userId: body.user.id };
  }

  /** An owner with a connected payout account and one published tier. */
  async function sellingOwner(a: ReturnType<typeof app>) {
    const owner = await account(a);
    await a.request("/users/me/payout", { method: "POST", headers: authed(owner.token) });
    const tier = await (
      await a.request("/users/me/tiers", {
        method: "POST",
        headers: { ...authed(owner.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Anggota", priceAmount: 50_000 }),
      })
    ).json();
    return { ...owner, tierId: tier.id as string };
  }

  /** An ACTIVE subscription from `subscriberId` to `owner`, its period ending at `periodEnd`. */
  async function seedMembership(
    owner: { userId: string; tierId: string },
    subscriberId: string,
    periodEnd: Date
  ) {
    const subscriptions = new DrizzleUserSubscriptionRepository(db);
    const created = await subscriptions.create({
      subscriberId,
      tierId: owner.tierId,
      ownerId: owner.userId,
    });
    await subscriptions.activate(created.id, periodEnd);
    return created;
  }

  it("is false, never null, for a visitor with no session at all", async () => {
    const a = app();
    const owner = await sellingOwner(a);
    const member = await account(a, { handle: "rina", email: "rina@example.com" });
    // A LIVE membership exists — it just does not belong to whoever is asking.
    await seedMembership(owner, member.userId, FUTURE);

    const body = await (await a.request("/users/by-handle/wildan")).json();

    expect(body.membership.viewerIsMember).toBe(false);
    expect(body.membership.viewerIsMember).not.toBeNull();
    // Its neighbour on the same payload IS null for the same request, on
    // purpose — the two answer different questions.
    expect(body.viewerFollows).toBeNull();
  });

  it("is true for the signed-in member of this creator", async () => {
    const a = app();
    const owner = await sellingOwner(a);
    const member = await account(a, { handle: "rina", email: "rina@example.com" });
    await seedMembership(owner, member.userId, FUTURE);

    const body = await (
      await a.request("/users/by-handle/wildan", { headers: authed(member.token) })
    ).json();

    expect(body.membership.viewerIsMember).toBe(true);
    // A live member has NOT had a membership end. The pair is never both.
    expect(body.membership.viewerMembershipEnded).toBe(false);
    // The offer is unchanged by who is asking — what a creator sells is not
    // viewer-specific. Only the web's rendering of it is.
    expect(body.membership.tiers).toHaveLength(1);
  });

  it("is false for a signed-in visitor who never subscribed", async () => {
    const a = app();
    const owner = await sellingOwner(a);
    const member = await account(a, { handle: "rina", email: "rina@example.com" });
    const stranger = await account(a, { handle: "budi", email: "budi@example.com" });
    await seedMembership(owner, member.userId, FUTURE);

    const body = await (
      await a.request("/users/by-handle/wildan", { headers: authed(stranger.token) })
    ).json();

    expect(body.membership.viewerIsMember).toBe(false);
    // ...and NOT the lapsed answer: this person may buy, which is the whole
    // distinction the second boolean carries.
    expect(body.membership.viewerMembershipEnded).toBe(false);
  });

  /**
   * **THE CASE THAT WOULD SILENTLY REGRESS.** §9: 5a has no renewal pass, so
   * nothing ever moves a subscription out of `active` when its period ends —
   * this row is `status = 'active'` with `current_period_end` in 2020. A
   * check that read the status alone would call this person a member forever
   * and never offer them the membership again; the period comparison in
   * `IsMemberOf` is the whole point of that class, and this is the only place
   * it is proved through HTTP.
   */
  it("is FALSE for a LAPSED membership — the row is still 'active', its period is not", async () => {
    const a = app();
    const owner = await sellingOwner(a);
    const lapsed = await account(a, { handle: "rina", email: "rina@example.com" });
    const subscription = await seedMembership(owner, lapsed.userId, PAST);

    const body = await (
      await a.request("/users/by-handle/wildan", { headers: authed(lapsed.token) })
    ).json();

    expect(body.membership.viewerIsMember).toBe(false);
    // AND the second boolean, which is what keeps that honest. 5a has no
    // renewal path, and `POST /users/:handle/subscribe` refuses this person's
    // purchase — its guard reads the status alone and must. A profile that
    // reported only `viewerIsMember: false` would have the web render a "Jadi
    // anggota" button whose only possible answer is a 409, forever. Final
    // review, I1.
    expect(body.membership.viewerMembershipEnded).toBe(true);
    // The tiers are still listed: what the creator sells does not depend on
    // who is looking. The WEB is what stops offering them.
    expect(body.membership.tiers).toHaveLength(1);

    // GUARD: the row really is in the state this test claims — still `active`,
    // period in the past — so a repository that had quietly expired it would
    // not let this pass for the wrong reason.
    const stored = await new DrizzleUserSubscriptionRepository(db).findById(subscription.id);
    expect(stored?.status).toBe("active");
    expect(stored?.currentPeriodEnd?.toISOString()).toBe(PAST.toISOString());
  });

  it("is false on your OWN profile, even with a row that names you both ways", async () => {
    const a = app();
    const owner = await sellingOwner(a);

    const body = await (
      await a.request("/users/by-handle/wildan", { headers: authed(owner.token) })
    ).json();

    // `user_subscription_no_self` makes such a row impossible to insert, and
    // `IsMemberOf` refuses the pair before it even queries — belt and braces.
    expect(body.membership.viewerIsMember).toBe(false);
  });

  it("an expired or garbage token degrades to the anonymous answer, never a 401", async () => {
    const a = app();
    await sellingOwner(a);

    const res = await a.request("/users/by-handle/wildan", { headers: authed("garbage") });

    expect(res.status).toBe(200);
    expect((await res.json()).membership.viewerIsMember).toBe(false);
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

describe("GET/POST /users/me/tiers and PATCH /users/me/tiers/:tierId", () => {
  /** Signs up, logs in, and returns both the bearer token and the user's id — mirrors `payoutUser` above. */
  async function tierUser(a: ReturnType<typeof app>, overrides: Partial<typeof VALID> = {}) {
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

  function connectPayout(a: ReturnType<typeof app>, token: string) {
    return a.request("/users/me/payout", { method: "POST", headers: authed(token) });
  }

  function postTier(a: ReturnType<typeof app>, token: string, body: unknown) {
    return a.request("/users/me/tiers", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function getTiers(a: ReturnType<typeof app>, token: string) {
    return a.request("/users/me/tiers", { headers: authed(token) });
  }

  function patchTier(a: ReturnType<typeof app>, token: string, tierId: string, body: unknown) {
    return a.request(`/users/me/tiers/${tierId}`, {
      method: "PATCH",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects an unauthenticated GET, POST and PATCH with 401", async () => {
    const a = app();
    expect((await a.request("/users/me/tiers")).status).toBe(401);
    expect((await a.request("/users/me/tiers", { method: "POST" })).status).toBe(401);
    expect(
      (
        await a.request("/users/me/tiers/00000000-0000-0000-0000-000000000000", {
          method: "PATCH",
        })
      ).status
    ).toBe(401);
  });

  it("REFUSES to create a tier before a payout account is connected, in Bahasa naming the remedy", async () => {
    const a = app();
    const { token } = await tierUser(a);

    const res = await postTier(a, token, { name: "Anggota", priceAmount: 50_000 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan " +
        "keanggotaan — uang dari tingkatan ini belum punya tempat tujuan."
    );
  });

  it("THE SENTINEL DOES NOT COUNT AS CONNECTED — a mid-provisioning payout also refuses tier creation", async () => {
    // Seeded through the repository, exactly as the payout suite does for
    // this exact state: POSTing to `/me/payout` twice would just finish the
    // connection, never leave it mid-flight.
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, userId } = await tierUser(a);
    expect(await deps.userPayoutRepository.beginXenditAccountProvisioning(userId)).toBe(true);

    const res = await postTier(a, token, { name: "Anggota", priceAmount: 50_000 });

    // The column is NOT empty here — a truthiness check would call this
    // connected and let the tier publish against an account Xendit does not
    // recognise.
    expect(res.status).toBe(409);
  });

  it("creates a tier once the owner's payout account is connected", async () => {
    const a = app();
    const { token } = await tierUser(a);
    await connectPayout(a, token);

    const res = await postTier(a, token, { name: "Anggota", priceAmount: 50_000 });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
      isActive: true,
    });
  });

  it("rejects a non-positive price with 400, and creates nothing", async () => {
    const a = app();
    const { token } = await tierUser(a);
    await connectPayout(a, token);

    for (const priceAmount of [0, -10_000]) {
      const res = await postTier(a, token, { name: "Anggota", priceAmount });
      expect(res.status).toBe(400);
    }

    expect(await (await getTiers(a, token)).json()).toEqual([]);
  });

  it("400s a malformed JSON body", async () => {
    const a = app();
    const { token } = await tierUser(a);
    await connectPayout(a, token);

    const res = await a.request("/users/me/tiers", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("GET lists only the caller's own tiers", async () => {
    const a = app();
    const mine = await tierUser(a);
    const stranger = await tierUser(a, { handle: "rina", email: "rina@example.com" });
    await connectPayout(a, mine.token);
    await connectPayout(a, stranger.token);
    await postTier(a, mine.token, { name: "Punyaku", priceAmount: 20_000 });
    await postTier(a, stranger.token, { name: "Punya Rina", priceAmount: 30_000 });

    const res = await getTiers(a, mine.token);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Punyaku");
  });

  it("PATCH deactivates a tier without touching an existing subscription to it", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token: ownerToken, userId: ownerId } = await tierUser(a);
    await connectPayout(a, ownerToken);
    const created = await (
      await postTier(a, ownerToken, { name: "Anggota", priceAmount: 50_000 })
    ).json();

    // A real member, seeded directly (there is no subscribe route yet — that
    // is Task 6) so this test can prove a claim about `user_subscription`
    // rather than about HTTP.
    const [subscriberRow] = await db
      .insert(appUsers)
      .values({
        handle: "subscriber1",
        email: "subscriber1@example.com",
        whatsappNumber: null,
        passwordHash: "irrelevant-hash",
        displayName: "Subscriber",
        bio: null,
      })
      .returning();
    const subscriptions = new DrizzleUserSubscriptionRepository(db);
    const subscription = await subscriptions.create({
      subscriberId: subscriberRow!.id,
      tierId: created.id,
      ownerId,
    });
    const periodEnd = new Date("2099-01-01T00:00:00Z");
    await subscriptions.activate(subscription.id, periodEnd);

    const patchRes = await patchTier(a, ownerToken, created.id, { isActive: false });

    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).isActive).toBe(false);

    // The tier stopped being offered...
    const listed = await (await getTiers(a, ownerToken)).json();
    expect(listed.find((t: { id: string }) => t.id === created.id)?.isActive).toBe(false);

    // ...but the existing member's subscription is UNTOUCHED — same status,
    // same period end, still resolvable by id.
    const stillThere = await subscriptions.findById(subscription.id);
    expect(stillThere?.status).toBe("active");
    expect(stillThere?.currentPeriodEnd?.toISOString()).toBe(periodEnd.toISOString());
  });

  it("one owner cannot edit another's tier — 404s, and the tier is left untouched", async () => {
    const a = app();
    const owner = await tierUser(a);
    const stranger = await tierUser(a, { handle: "rina", email: "rina@example.com" });
    await connectPayout(a, owner.token);
    const created = await (
      await postTier(a, owner.token, { name: "Anggota", priceAmount: 50_000 })
    ).json();

    const res = await patchTier(a, stranger.token, created.id, { isActive: false });

    expect(res.status).toBe(404);

    const mine = await (await getTiers(a, owner.token)).json();
    expect(mine[0].isActive).toBe(true);
  });

  it("404s a PATCH for a tier id that does not exist at all", async () => {
    const a = app();
    const { token } = await tierUser(a);

    const res = await patchTier(a, token, "00000000-0000-0000-0000-000000000000", {
      isActive: false,
    });

    expect(res.status).toBe(404);
  });

  it("400s a PATCH that tries to reactivate — isActive: true is refused, not silently ignored", async () => {
    const a = app();
    const { token } = await tierUser(a);
    await connectPayout(a, token);
    const created = await (await postTier(a, token, { name: "Anggota", priceAmount: 50_000 })).json();

    const res = await patchTier(a, token, created.id, { isActive: true });

    expect(res.status).toBe(400);
  });
});

/**
 * Task 6 of Phase 5a — `POST /users/:handle/subscribe`, the moment money
 * actually moves. Nothing here contacts Xendit: `bootstrap()` wires
 * `FakePaymentAdapter` under NODE_ENV=test, and these tests read the calls it
 * recorded.
 */
describe("POST /users/:handle/subscribe (Task 6)", () => {
  /**
   * The provisioning sentinel as a LITERAL, never the imported constant —
   * same rule the payout and tier suites above follow.
   */
  const SENTINEL = "provisioning:in-progress";
  /** The `external_id` prefix as a LITERAL. Task 7's webhook routes on it. */
  const PREFIX = "usub_";

  /** Signs up, logs in, and returns both the bearer token and the user's id. */
  async function account(a: ReturnType<typeof app>, overrides: Partial<typeof VALID> = {}) {
    const acc = { ...VALID, ...overrides };
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acc),
    });
    const res = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: acc.email, password: acc.password }),
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, userId: body.user.id };
  }

  const RINA = { handle: "rina", email: "rina@example.com" };

  function connectPayout(a: ReturnType<typeof app>, token: string) {
    return a.request("/users/me/payout", { method: "POST", headers: authed(token) });
  }

  function postTier(a: ReturnType<typeof app>, token: string, body: unknown) {
    return a.request("/users/me/tiers", {
      method: "POST",
      headers: { ...authed(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function subscribe(
    a: ReturnType<typeof app>,
    token: string | null,
    handle: string,
    body: unknown
  ) {
    return a.request(`/users/${handle}/subscribe`, {
      method: "POST",
      headers: {
        ...(token === null ? {} : authed(token)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  /** An owner with a connected payout account and one published tier, plus a buyer. */
  async function seedOffer(a: ReturnType<typeof app>) {
    const owner = await account(a);
    await connectPayout(a, owner.token);
    const tier = await (
      await postTier(a, owner.token, { name: "Anggota", priceAmount: 50_000 })
    ).json();
    const buyer = await account(a, RINA);
    return { owner, buyer, tier };
  }

  it("requires a session: a signed-out visitor is a 401, and no invoice is opened", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { tier } = await seedOffer(a);

    const res = await subscribe(a, null, "wildan", { tierId: tier.id });

    expect(res.status).toBe(401);
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
  });

  it("opens the invoice against THE OWNER's sub-account and creates a pending subscription and transaction", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { owner, buyer, tier } = await seedOffer(a);

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "externalId",
      "invoiceUrl",
      "subscriptionId",
      "transactionId",
    ]);

    const subscriptions = new DrizzleUserSubscriptionRepository(db);
    const subscription = await subscriptions.findById(body.subscriptionId);
    expect(subscription).toMatchObject({
      subscriberId: buyer.userId,
      ownerId: owner.userId,
      tierId: tier.id,
      status: "pending",
      currentPeriodEnd: null,
    });
    const transaction = await subscriptions.findTransactionById(body.transactionId);
    expect(transaction).toMatchObject({
      userSubscriptionId: body.subscriptionId,
      amount: 50_000,
      status: "pending",
      paidAt: null,
    });

    const payments = deps.payments as FakePaymentAdapter;
    expect(payments.invoices).toHaveLength(1);
    const ownerAccountId = (await deps.userPayoutRepository.findPayoutAccount(owner.userId))
      ?.xenditAccountId;
    expect(ownerAccountId).not.toBe(SENTINEL);
    expect(payments.invoices[0].forAccountId).toBe(ownerAccountId!);
    expect(payments.invoices[0].amount).toBe(50_000);
    // The namespaced external id, and the provider's invoice id recorded back
    // against our transaction — the anchor Task 7's webhook verifies `body.id`
    // against.
    expect(payments.invoices[0].externalId).toBe(`${PREFIX}${body.transactionId}`);
    expect(body.externalId).toBe(`${PREFIX}${body.transactionId}`);
    expect(transaction?.gatewayReferenceId).toBe("fake-inv-1");
    // Back to the seller's profile after paying, never stranded on Xendit's receipt.
    expect(payments.invoices[0].successRedirectUrl).toBe(`${deps.appBaseUrl}/@wildan`);
  });

  it("REFUSES subscribing to yourself, in Bahasa, without touching the provider", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { owner, tier } = await seedOffer(a);

    const res = await subscribe(a, owner.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Anda tidak dapat berlangganan ke diri sendiri. Bagikan tautan profil Anda " +
        "agar orang lain dapat menjadi anggota."
    );
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
  });

  it("REFUSES a tier the owner has withdrawn from sale, in Bahasa naming the remedy", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { owner, buyer, tier } = await seedOffer(a);
    await a.request(`/users/me/tiers/${tier.id}`, {
      method: "PATCH",
      headers: { ...authed(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Tingkatan keanggotaan ini sudah tidak ditawarkan lagi. Pilih tingkatan lain " +
        "yang masih tersedia di profil kreator ini."
    );
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
  });

  it("REFUSES an owner with NO payout account, in Bahasa naming the remedy", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const owner = await account(a);
    // Seeded through the repository, which has no payout gate: `POST
    // /users/me/tiers` refuses to publish a tier without a connected account
    // (Task 4), so this state cannot be reached over HTTP — and it is exactly
    // the state a buyer must not be charged in.
    const tier = await deps.userTierRepository.create({
      ownerId: owner.userId,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const buyer = await account(a, RINA);

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Kreator ini belum siap menerima pembayaran. Minta mereka menghubungkan akun " +
        "pembayaran di Pengaturan terlebih dahulu."
    );
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
  });

  it("THE SENTINEL IS NOT AN ACCOUNT: a MID-PROVISIONING owner's tier cannot be bought", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const owner = await account(a);
    // The column now holds `provisioning:in-progress` — TRUTHY, but not an
    // account id. `if (owner.xenditAccountId)` would pass here and send that
    // literal string to the provider as `for_account_id`.
    expect(await deps.userPayoutRepository.beginXenditAccountProvisioning(owner.userId)).toBe(true);
    expect(
      (await deps.userPayoutRepository.findPayoutAccount(owner.userId))?.xenditAccountId
    ).toBe(SENTINEL);
    const tier = await deps.userTierRepository.create({
      ownerId: owner.userId,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const buyer = await account(a, RINA);

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(409);
    // Nothing reached the provider AT ALL — not an invoice with the sentinel in
    // it, not an invoice at all.
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
    expect(await db.select().from(userSubscriptions)).toEqual([]);
  });

  it("REFUSES a second membership to the same owner CLEANLY — a 409, not the unique index's 500", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { buyer, tier } = await seedOffer(a);
    const first = await (await subscribe(a, buyer.token, "wildan", { tierId: tier.id })).json();
    // Task 7's webhook is what activates this in production; here it is the
    // precondition, so it is set directly.
    const subscriptions = new DrizzleUserSubscriptionRepository(db);
    await subscriptions.activate(first.subscriptionId, new Date("2099-01-01T00:00:00Z"));

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
        "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
    );
    // One subscription, and ONE invoice — the refusal created no second pending
    // row for a payment nobody should be making.
    expect(await db.select().from(userSubscriptions)).toHaveLength(1);
    expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(1);
  });

  it("404s an unknown handle, and 404s a tier belonging to someone else", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { buyer, tier } = await seedOffer(a);
    const other = await account(a, { handle: "budi", email: "budi@example.com" });
    await connectPayout(a, other.token);

    expect((await subscribe(a, buyer.token, "tidakada", { tierId: tier.id })).status).toBe(404);
    // `wildan`'s handle with `budi`'s... in fact with a tier that is wildan's,
    // asked of budi's profile: the tier is real, the owner is not its owner.
    expect((await subscribe(a, buyer.token, "budi", { tierId: tier.id })).status).toBe(404);
    expect((deps.payments as FakePaymentAdapter).invoices).toEqual([]);
  });

  it("400s a body with no tier id at all", async () => {
    const a = app();
    const { buyer } = await seedOffer(a);

    expect((await subscribe(a, buyer.token, "wildan", {})).status).toBe(400);
    expect(
      (
        await a.request("/users/wildan/subscribe", {
          method: "POST",
          headers: { ...authed(buyer.token), "Content-Type": "application/json" },
          body: "not json",
        })
      ).status
    ).toBe(400);
  });

  it("A SECOND TAP hands back the SAME invoice — one transaction row, one invoice at the provider", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { buyer, tier } = await seedOffer(a);

    const first = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });
    const second = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    // Two live invoices for one membership are two chargeable invoices, and
    // there is no refund path anywhere in 5a.
    expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(1);
    expect(await db.select().from(userSubscriptions)).toHaveLength(1);
    expect(await db.select().from(userTransactions)).toHaveLength(1);
  });

  it("REFUSES a different tier while an invoice is pending, in Bahasa", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { owner, buyer, tier } = await seedOffer(a);
    const other = await (
      await postTier(a, owner.token, { name: "Anggota Plus", priceAmount: 100_000 })
    ).json();
    await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    const res = await subscribe(a, buyer.token, "wildan", { tierId: other.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Pembayaran keanggotaan untuk kreator ini sedang diproses. Selesaikan dulu " +
        "pembayaran yang sudah dibuka, atau tunggu tagihannya kedaluwarsa sebelum " +
        "memilih tingkatan lain."
    );
    expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(1);
    expect(await db.select().from(userTransactions)).toHaveLength(1);
  });

  /**
   * THE CONCURRENT DOUBLE TAP — fix round 2, and the reason the sequential
   * reuse test above was not enough. A re-review fired two simultaneous
   * requests at this endpoint on stock `e71c156` and got two live invoices,
   * two subscriptions and two transactions for one pair in one run out of five:
   * the dedupe was a read followed by a write with nothing arbitrating it, and
   * a double tap on a phone is concurrent, not sequential.
   *
   * TWENTY CONTENDERS. The number is part of the assertion, the lesson Task 3's
   * payout race records: at TWO contenders the defect only showed in 1 run out
   * of 5, so a broken implementation passes 80% of the time — measured here at
   * twenty, the pre-fix code produced a second invoice in every single run (see
   * the report). Real HTTP requests through the real router and the real
   * database, so the interleaving is the product's, not a fake's.
   */
  it("TWENTY CONCURRENT TAPS open exactly ONE invoice, and nobody sees a 500", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { buyer, tier } = await seedOffer(a);
    const contenders = 20;

    const responses = await Promise.all(
      Array.from({ length: contenders }, () =>
        subscribe(a, buyer.token, "wildan", { tierId: tier.id })
      )
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    // Two live invoices for one membership are two chargeable invoices, and 5a
    // has no refund path anywhere in it.
    expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(1);
    expect(await db.select().from(userSubscriptions)).toHaveLength(1);
    expect(await db.select().from(userTransactions)).toHaveLength(1);

    // Every caller got either THE invoice or a clean Bahasa refusal — never a
    // 500, and never a second invoice url.
    const invoiceUrls = new Set<string>();
    for (const [i, res] of responses.entries()) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 201) {
        invoiceUrls.add(bodies[i].invoiceUrl);
      } else {
        expect(bodies[i].error).toMatch(/^Pembayaran /);
      }
    }
    expect(invoiceUrls.size).toBe(1);
    expect([...invoiceUrls][0]).toBe("https://fake-checkout.local/fake-inv-1");
  });

  it("503s in Bahasa on a box with no payment provider at all", async () => {
    // The route stays REGISTERED on such a box — unlike `/c/:slug/checkout`,
    // which is simply not mounted — so a buyer is told why instead of getting
    // the 404 of a path that does not exist. Same choice, and the same wording,
    // as `POST /users/me/payout` above.
    const deps = bootstrap();
    const a = createApp({ ...deps, startUserSubscription: undefined });
    const { buyer, tier } = await seedOffer(a);

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("pembayaran belum dikonfigurasi di server ini.");
  });

  it("THE ROW EXISTS BEFORE THE PROVIDER IS CALLED: a failed invoice leaves a pending subscription behind", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { owner, buyer, tier } = await seedOffer(a);
    (deps.payments as FakePaymentAdapter).failNextInvoice = true;

    const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

    expect(res.status).toBe(500);
    // The reverse ordering would leave a live invoice at Xendit whose
    // external_id resolves to nothing. This way the attempt is inspectable and
    // nothing was charged.
    const rows = await db.select().from(userSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subscriberId: buyer.userId,
      ownerId: owner.userId,
      // The row survives — that is what writing it first buys — but its CLAIM on
      // this pair's pending slot is given back, because nothing in 5a clears a
      // pending row and holding one would wedge this buyer out for good.
      status: "cancelled",
    });
    const txns = await db.select().from(userTransactions);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      userSubscriptionId: rows[0]!.id,
      amount: 50_000,
      status: "pending",
      // No invoice was opened, so there is nothing to anchor on — exactly the
      // state Task 7 must treat as unverifiable rather than as paid.
      gatewayReferenceId: null,
    });
  });

  /**
   * Wraps the REAL unit of work so every contender rendezvouses immediately
   * BEFORE the transaction opens — never inside it. See the thirty-way race
   * below for why that placement is load-bearing: a contender parked at the
   * latch inside a transaction is a contender holding one of the pool's ten
   * connections, and thirty of those deadlock.
   */
  function latchedUnitOfWork(
    inner: UserPurchaseUnitOfWorkPort,
    latch: ArrivalLatch
  ): UserPurchaseUnitOfWorkPort {
    return {
      async run(work) {
        await latch.arriveAndWait();
        return inner.run(work);
      },
    };
  }

  /**
   * Wraps the REAL unit of work so the CLAIM inside it rejects once, the way a
   * dropped connection does — on the repository the transaction is bound to, so
   * the rollback is Postgres's. The second attempt runs the real claim, which is
   * what lets a test assert the retry SUCCEEDS from the untouched row.
   */
  function failingClaimUnitOfWork(inner: UserPurchaseUnitOfWorkPort): UserPurchaseUnitOfWorkPort {
    let fired = false;
    return {
      async run(work) {
        return inner.run((repositories) =>
          work({
            ...repositories,
            subscriptions: Object.assign(Object.create(repositories.subscriptions), {
              claimPending: async (...args: Parameters<typeof repositories.subscriptions.claimPending>) => {
                if (!fired) {
                  fired = true;
                  throw new Error("simulated connection reset during claimPending");
                }
                return repositories.subscriptions.claimPending(...args);
              },
            }),
          })
        );
      },
    };
  }

  /**
   * **PHASE 5b, TASK 2 — THROUGH HTTP, AGAINST THE REAL DATABASE.**
   *
   * 5a's §9 guaranteed every paying member lapsed one billing cycle after their
   * purchase and that nothing renewed them. The row stayed `status = 'active'`
   * with a past `current_period_end`, so it kept holding
   * `user_subscription_one_active`'s slot and this route refused the repeat
   * purchase — truthfully, and permanently: the button was dead.
   *
   * 5b's renewal mechanism is *buy again*. `retireExpired` moves that row to
   * `expired` inside the purchase itself, in the same transaction as the
   * pending claim, so the member presses "Jadi anggota" once and gets a fresh
   * checkout. This is that request, end to end.
   */
  describe("a lapsed member buys again (Phase 5b, Task 2)", () => {
    /** A member of `wildan` whose paid period ended in 2020 — 5a's own end state. */
    async function lapsedMember(a: ReturnType<typeof app>) {
      const seeded = await seedOffer(a);
      const first = await (
        await subscribe(a, seeded.buyer.token, "wildan", { tierId: seeded.tier.id })
      ).json();
      const subscriptions = new DrizzleUserSubscriptionRepository(db);
      // Task 7's webhook is what activates this in production; here it is the
      // precondition. The period ends in 2020 — over.
      await subscriptions.activate(first.subscriptionId, new Date("2020-01-01T00:00:00Z"));
      return { ...seeded, first, subscriptions };
    }

    it("a member whose period has ENDED can buy again, in ONE request", async () => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { owner, buyer, tier, first, subscriptions } = await lapsedMember(a);

      const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-2");
      expect(body.subscriptionId).not.toBe(first.subscriptionId);

      // The old row RETIRED, the new one PENDING — never two rows both claiming
      // to be active, which `user_subscription_one_active` would refuse when
      // Task 7's webhook came to activate this purchase.
      const stored = await subscriptions.findById(first.subscriptionId);
      expect(stored?.status).toBe("expired");
      expect(stored?.currentPeriodEnd?.getUTCFullYear()).toBe(2020);
      expect((await subscriptions.findById(body.subscriptionId))?.status).toBe("pending");
      // The slot is genuinely free: this is the read the guard makes and the
      // predicate the partial unique index arbitrates on.
      expect(await subscriptions.findActiveFor(buyer.userId, owner.userId)).toBeNull();
      expect(await db.select().from(userSubscriptions)).toHaveLength(2);
      expect(await db.select().from(userTransactions)).toHaveLength(2);
      expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(2);
    });

    it("and the profile agrees, on the same database, in the same run", async () => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { buyer, tier } = await lapsedMember(a);

      await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

      // Nothing has been PAID yet — the invoice is open, not settled — so the
      // profile must still say "not a member". What changed is that the offer is
      // buyable again rather than permanently refused.
      const profile = await (
        await a.request("/users/by-handle/wildan", { headers: authed(buyer.token) })
      ).json();
      expect(profile.membership.viewerIsMember).toBe(false);
    });

    it("a member whose period is STILL RUNNING is refused, in Bahasa, and their row is untouched", async () => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { buyer, tier } = await seedOffer(a);
      const first = await (
        await subscribe(a, buyer.token, "wildan", { tierId: tier.id })
      ).json();
      const subscriptions = new DrizzleUserSubscriptionRepository(db);
      await subscriptions.activate(first.subscriptionId, new Date("2099-01-01T00:00:00Z"));

      const res = await subscribe(a, buyer.token, "wildan", { tierId: tier.id });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(
        "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
          "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
      );
      // Retiring a LIVE membership would take away access somebody paid for.
      const stored = await subscriptions.findById(first.subscriptionId);
      expect(stored?.status).toBe("active");
      expect(await db.select().from(userSubscriptions)).toHaveLength(1);
      expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(1);
    });

    /**
     * **THE RETIREMENT AND THE CLAIM COMMIT TOGETHER, OR NEITHER DOES.**
     *
     * A retirement that committed on its own and a claim that then failed would
     * leave this person holding neither an active membership nor a pending
     * checkout: their row says `expired` and nothing was opened in its place.
     * The failure is injected on the repository the unit of work hands to the
     * use case — the one bound to the open transaction — so the rollback under
     * test is a real Postgres rollback and not a fake's bookkeeping.
     *
     * THIS is the test that reddens if the retirement is moved out of the
     * claim's transaction. The concurrency test below cannot see that move:
     * `retireExpired` is a conditional UPDATE and arbitrates correctly on its
     * own connection too, so concurrency alone never exposes the split. Only a
     * failure between the two writes does.
     */
    it("a dropped claim ROLLS THE RETIREMENT BACK — never neither", async () => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { buyer, tier, first, subscriptions } = await lapsedMember(a);
      const wired = createApp({
        ...deps,
        startUserSubscription: new StartUserSubscription(
          deps.userRepository,
          deps.userTierRepository,
          deps.userPayoutRepository,
          new DrizzleUserSubscriptionRepository(db),
          // The REAL unit of work — a real transaction — with the claim inside
          // it made to reject once.
          failingClaimUnitOfWork(new DrizzleUserPurchaseUnitOfWork(db)),
          deps.payments!,
          new SystemClock(),
          { appBaseUrl: "https://diudara.test" }
        ),
      });

      const res = await subscribe(wired, buyer.token, "wildan", { tierId: tier.id });
      expect(res.status).toBe(500);

      // Exactly as the buyer left it: still active, still carrying the period
      // that ran out. Nothing was retired into nothing.
      const stored = await subscriptions.findById(first.subscriptionId);
      expect(stored?.status).toBe("active");
      expect(stored?.currentPeriodEnd?.getUTCFullYear()).toBe(2020);
      expect(await db.select().from(userSubscriptions)).toHaveLength(1);

      // And the very next attempt works, from that same unchanged row.
      const second = await subscribe(wired, buyer.token, "wildan", { tierId: tier.id });
      expect(second.status).toBe(201);
      expect((await subscriptions.findById(first.subscriptionId))?.status).toBe("expired");
    });

    /**
     * **THE CONCURRENT TAP BY A LAPSED MEMBER** — the interleaving this task
     * actually introduces, since retiring and claiming now happen inside one
     * transaction on a row every contender wants to move.
     *
     * THIRTY CONTENDERS, and the number is part of the assertion. Measured
     * against this database on the implementation's own mutants:
     *
     *  - Claim by `try/catch (23505)` instead of `ON CONFLICT DO NOTHING` —
     *    what `claimPending` did before this task, and poison inside a
     *    transaction because Postgres aborts it before the catch runs. Every
     *    loser 500s on `25P02`. Measured, two runs each: at 4 contenders,
     *    `{201: 1, 500: 3}` both times; at 30, `{201: 1, 500: 29}` both times.
     *    Deterministic at both counts — but three failures is a number a person
     *    can read as flake, and twenty-nine is not. That is what thirty buys
     *    here: not detection, legibility of the failure.
     *  - Retirement moved OUT of the claim's transaction: GREEN at 4, 10 and
     *    30, three runs each. That defect is invisible to concurrency by
     *    construction — `retireExpired` is a conditional UPDATE and arbitrates
     *    correctly on its own connection too — and no contender count fixes
     *    that. The rollback test above is what catches it (measured red:
     *    expected "active", received "expired"). Recorded here so the next
     *    person does not go looking for it in this test.
     *
     * Thirty is also what the payout race and the repository's own claim race
     * settled on against this same database, so the phase carries one number
     * rather than three. Do not lower this number.
     *
     * The latch fires BEFORE the unit of work opens its transaction, never
     * inside it. A contender parked at the latch while holding a transaction
     * holds a pooled connection too, and the pool is ten wide — thirty
     * contenders would then deadlock waiting for arrivals that cannot happen,
     * and `ArrivalLatch` would report a timeout rather than the defect.
     */
    it("THIRTY CONCURRENT TAPS by a lapsed member retire the row ONCE and open ONE new invoice", async () => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { owner, buyer, tier, first, subscriptions } = await lapsedMember(a);
      const contenders = 30;
      const latch = new ArrivalLatch(contenders);
      const wired = createApp({
        ...deps,
        startUserSubscription: new StartUserSubscription(
          deps.userRepository,
          deps.userTierRepository,
          deps.userPayoutRepository,
          new DrizzleUserSubscriptionRepository(db),
          latchedUnitOfWork(new DrizzleUserPurchaseUnitOfWork(db), latch),
          deps.payments!,
          new SystemClock(),
          { appBaseUrl: "https://diudara.test" }
        ),
      });

      const responses = await Promise.all(
        Array.from({ length: contenders }, () =>
          subscribe(wired, buyer.token, "wildan", { tierId: tier.id })
        )
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));

      expect(latch.arrived).toBe(contenders);
      // ONE retirement, ONE new claim, ONE new invoice. Two chargeable invoices
      // for one membership is the defect this whole mechanism exists to prevent,
      // and 5a left no refund path anywhere.
      const rows = await db.select().from(userSubscriptions);
      expect(rows.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
      expect(rows.find((r) => r.id === first.subscriptionId)?.status).toBe("expired");
      expect((deps.payments as FakePaymentAdapter).invoices).toHaveLength(2);
      expect(await db.select().from(userTransactions)).toHaveLength(2);

      // Every caller got either THE new invoice or a clean Bahasa refusal —
      // never a 500. A 500 here is the tell that a loser's unique violation
      // poisoned the transaction it was raised in.
      const invoiceUrls = new Set<string>();
      for (const [i, res] of responses.entries()) {
        expect([201, 409]).toContain(res.status);
        if (res.status === 201) {
          invoiceUrls.add(bodies[i].invoiceUrl);
        } else {
          expect(bodies[i].error).toMatch(/^Pembayaran /);
        }
      }
      expect(invoiceUrls.size).toBe(1);
      expect([...invoiceUrls][0]).toBe("https://fake-checkout.local/fake-inv-2");
      expect(await subscriptions.findActiveFor(buyer.userId, owner.userId)).toBeNull();
    });
  });

  /**
   * **I2, THROUGH HTTP AND AGAINST THE REAL DATABASE** — the reproduction the
   * final whole-branch review ran, turned into a test.
   *
   * One simulated connection reset on a statement between the pending claim and
   * the gateway reference used to give: attempt 1 a 500 with an invoice already
   * open at the provider, attempts 2 and 3 a 409 saying "Tunggu sebentar, lalu
   * coba lagi", and `findPendingCheckout → null` forever. The message said
   * temporary; the state was permanent, because nothing in 5a clears a pending
   * row and that row is this pair's only pending slot.
   *
   * The failure is injected on the repository INSTANCE the use case already
   * holds, so no production logic is touched and the route is the real one.
   */
  it.each(["createTransaction", "attachGatewayReference"] as const)(
    "a dropped %s releases the claim, and the very next attempt succeeds",
    async (method) => {
      const deps = bootstrap();
      const a = createApp(deps);
      const { buyer, tier } = await seedOffer(a);
      // The REAL repository against the REAL database, with one statement made
      // to reject once. Nothing in `src` is modified: the wrapper is here, and
      // the use case behind the route is the production class wired to it.
      const repository = new DrizzleUserSubscriptionRepository(db);
      const original = repository[method].bind(repository) as (...args: never[]) => unknown;
      let fired = false;
      (repository as unknown as Record<string, unknown>)[method] = async (...args: never[]) => {
        if (!fired) {
          fired = true;
          throw new Error("simulated connection reset");
        }
        return original(...args);
      };
      const wired = createApp({
        ...deps,
        startUserSubscription: new StartUserSubscription(
          deps.userRepository,
          deps.userTierRepository,
          deps.userPayoutRepository,
          repository,
          // The real transaction. The failure under test is injected on
          // `repository`, whose `createTransaction`/`attachGatewayReference`
          // run OUTSIDE this unit of work — deliberately, since neither may
          // share a transaction with an outbound provider call.
          new DrizzleUserPurchaseUnitOfWork(db),
          deps.payments!,
          new SystemClock(),
          { appBaseUrl: "https://diudara.test" }
        ),
      });

      const first = await subscribe(wired, buyer.token, "wildan", { tierId: tier.id });
      expect(first.status).toBe(500);

      const second = await subscribe(wired, buyer.token, "wildan", { tierId: tier.id });

      // NOT a 409, and specifically not the transient one that used to be
      // returned forever.
      expect(second.status).toBe(201);
      const body = await second.json();
      expect(typeof body.invoiceUrl).toBe("string");
      // The wedged row is `cancelled` rather than `pending`, so it holds
      // nothing; the fresh claim is the one that owns the slot.
      const rows = await db.select().from(userSubscriptions);
      expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "pending"]);
      // And the reuse path can SEE the new checkout, which is what
      // `findPendingCheckout → null forever` meant it could not.
      const third = await subscribe(wired, buyer.token, "wildan", { tierId: tier.id });
      expect(third.status).toBe(201);
      expect((await third.json()).invoiceUrl).toBe(body.invoiceUrl);
    }
  );
});
