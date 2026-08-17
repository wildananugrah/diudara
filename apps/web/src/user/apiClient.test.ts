import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  apiFetch,
  apiRequest,
  completePasswordReset,
  exploreUsers,
  followUser,
  getOwnProfile,
  getProfileByHandle,
  getSessionUser,
  getUserToken,
  listFollowers,
  listFollowing,
  login,
  requestPasswordReset,
  SESSION_EXPIRED_MESSAGE,
  setUserSession,
  signup,
  unfollowUser,
  updateOwnProfile,
  UserApiError,
  USER_TOKEN_STORAGE_KEY,
  type OwnUserProfile,
} from "./apiClient";
import { SESSION_EXPIRED_MESSAGE as DASHBOARD_SESSION_EXPIRED_MESSAGE } from "../dashboard/apiClient";

/**
 * Type-level pin (review round 2, Important 2). `OwnUserProfile`'s own
 * docstring in `apiClient.ts` explains why it extends `UserProfileCore`
 * rather than `PublicUserProfile` — but `getOwnProfile()` returns its result
 * via `(await res.json()) as T`, an assertion that compiles for ANY object
 * shape, so nothing about that function itself would ever fail to compile
 * if the `extends` clause regressed back to `PublicUserProfile`. This
 * literal is the actual backstop: it is typed as `OwnUserProfile` WITHOUT
 * `followerCount`/`followingCount`/`viewerFollows`, which only typechecks
 * because those three are not part of `OwnUserProfile` today. If
 * `OwnUserProfile` ever re-extends `PublicUserProfile`, those three become
 * required properties of `OwnUserProfile` too, this literal starts missing
 * required properties, and `bun run typecheck` fails right here — the same
 * kind of two-sided proof `get-user-profile.ts`'s own `toOwnProfile` gets
 * for free server-side (a spread that would fail to compile), reproduced
 * here since a type-only `as` cast has no such guarantee.
 */
const OWN_PROFILE_SHAPE_PIN: OwnUserProfile = {
  handle: "pin",
  displayName: "Pin",
  bio: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  email: "pin@example.com",
  whatsappNumber: null,
};
void OWN_PROFILE_SHAPE_PIN;

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("session storage", () => {
  it("stores the token under its own key, distinct from the dashboard's", () => {
    expect(USER_TOKEN_STORAGE_KEY).toBe("diudara.user.token");
    setUserSession("jwt-abc", USER);
    expect(localStorage.getItem(USER_TOKEN_STORAGE_KEY)).toBe("jwt-abc");
    expect(localStorage.getItem("diudara.dashboard.token")).toBeNull();
  });

  it("round-trips the cached account", () => {
    setUserSession("jwt-abc", USER);
    expect(getSessionUser()).toEqual(USER);
    expect(getUserToken()).toBe("jwt-abc");
  });
});

describe("apiFetch (authenticated)", () => {
  it("attaches the stored token as a bearer header", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ handle: "wildan" });
    }) as unknown as typeof fetch;

    await apiFetch("/users/me");

    expect(calls[0]!.url).toBe("/users/me");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("clears the token on a 401 from any endpoint, with the session-expired message", async () => {
    setUserSession("jwt-stale", USER);
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired token" }, 401)) as unknown as typeof fetch;

    const err = (await apiFetch("/users/me").catch((e: unknown) => e)) as UserApiError;

    expect(err.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(getUserToken()).toBeNull();
  });

  /**
   * F5 (review): `SESSION_EXPIRED_MESSAGE` was never asserted at all, let
   * alone pinned against the dashboard's own copy of it — so the two could
   * drift apart silently (a creator's session expiring would say one thing,
   * a member's another, with nothing here to notice). Both are hardcoded
   * independently in their own module rather than shared (see this file's
   * copy of `parseFieldErrors` for the same "stay independent" reasoning),
   * so equality between them is a fact worth pinning, not a given.
   */
  it("uses the exact same session-expired copy as the creator dashboard's own apiClient", () => {
    expect(SESSION_EXPIRED_MESSAGE).toBe("Sesi Anda sudah berakhir. Silakan masuk kembali.");
    expect(SESSION_EXPIRED_MESSAGE).toBe(DASHBOARD_SESSION_EXPIRED_MESSAGE);
  });

  it("throws a 404 without clearing the token", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ error: "user not found" }, 404)) as unknown as typeof fetch;

    const err = await apiFetch("/users/me").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UserApiError);
    expect((err as UserApiError).status).toBe(404);
    expect(getUserToken()).toBe("jwt-abc");
  });

  it("splits a 400's validation message into per-field messages", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "displayName: String must contain at least 1 character(s)" }, 400)
    ) as unknown as typeof fetch;

    const err = (await apiFetch("/users/me", { method: "PATCH", body: "{}" }).catch(
      (e: unknown) => e
    )) as UserApiError;

    expect(err.fieldErrors.displayName).toContain("at least 1 character");
  });

  it("returns the raw response from apiRequest", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ handle: "wildan" })) as unknown as typeof fetch;

    const res = await apiRequest("/users/me");

    expect(res.ok).toBe(true);
  });
});

describe("login", () => {
  it("stores the session on a successful login", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;

    await login({ email: "wildan@example.com", password: "supersecret123" });

    expect(getUserToken()).toBe("jwt-fresh");
    expect(getSessionUser()).toEqual(USER);
  });

  it("posts to /users/login with the credentials, no Authorization header even with a stale token", async () => {
    setUserSession("jwt-stale", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ user: USER, token: "jwt-fresh" });
    }) as unknown as typeof fetch;

    await login({ email: "wildan@example.com", password: "supersecret123" });

    expect(calls[0]!.url).toBe("/users/login");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "wildan@example.com",
      password: "supersecret123",
    });
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBeNull();
  });

  it("leaves a stale token alone when the credentials are refused", async () => {
    setUserSession("jwt-stale", USER);
    global.fetch = mock(async () => jsonResponse({ error: "invalid email or password" }, 401)) as unknown as typeof fetch;

    const err = (await login({ email: "wildan@example.com", password: "wrong" }).catch(
      (e: unknown) => e
    )) as UserApiError;

    expect(err.status).toBe(401);
    expect(getUserToken()).toBe("jwt-stale");
  });
});

describe("signup", () => {
  it("posts to /users/signup and resolves { ok: true } without storing any session", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true }, 201)) as unknown as typeof fetch;

    const result = await signup({
      handle: "wildan",
      email: "wildan@example.com",
      password: "supersecret123",
      displayName: "Wildan",
    });

    expect(result).toEqual({ ok: true });
    expect(getUserToken()).toBeNull();
    expect(getSessionUser()).toBeNull();
  });

  it("resolves the identical { ok: true } shape for a duplicate email — the API cannot be told apart from a fresh signup", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true }, 201)) as unknown as typeof fetch;

    const result = await signup({
      handle: "someoneelse",
      email: "taken@example.com",
      password: "supersecret123",
      displayName: "Someone Else",
    });

    expect(result).toEqual({ ok: true });
  });

  it("throws a 409 for a duplicate handle", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "handle is already taken" }, 409)) as unknown as typeof fetch;

    const err = (await signup({
      handle: "wildan",
      email: "new@example.com",
      password: "supersecret123",
      displayName: "Baru",
    }).catch((e: unknown) => e)) as UserApiError;

    expect(err.status).toBe(409);
    expect(err.message).toBe("handle is already taken");
  });
});

describe("profile", () => {
  it("fetches a public profile by bare handle, including the follow fields", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        handle: "wildan",
        displayName: "Wildan",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        followerCount: 3,
        followingCount: 1,
        viewerFollows: null,
      });
    }) as unknown as typeof fetch;

    const profile = await getProfileByHandle("wildan");

    expect(calls[0]).toBe("/users/by-handle/wildan");
    expect(profile.handle).toBe("wildan");
    expect(profile.followerCount).toBe(3);
    expect(profile.followingCount).toBe(1);
    expect(profile.viewerFollows).toBeNull();
  });

  /**
   * TASK 6, THE PHASE GATE, FOUND IN A REAL BROWSER: signed in and looking at
   * somebody else's profile, the follow button read "Masuk untuk mengikuti"
   * — the signed-OUT label — because this request carried no Authorization
   * header, so `GET /users/by-handle/:handle` answered `viewerFollows: null`
   * for a caller who very much had a session.
   *
   * `/by-handle/:handle` is PUBLIC but NOT anonymous. `routes/users.ts` runs
   * `resolveViewerId` on it (never `requireAuth`, so a missing or expired
   * token is `null`/anonymous rather than a 401), and that viewer id is the
   * ONLY input to `viewerFollows`. Measured against the running API:
   *
   *   $ curl -s localhost:3000/users/by-handle/gate6_bagas
   *   {... "viewerFollows":null}
   *   $ curl -s localhost:3000/users/by-handle/gate6_bagas -H "Authorization: Bearer $TOKEN"
   *   {... "viewerFollows":false}
   *
   * So the header is what decides whether the follow toggle exists at all:
   * `FollowButton` renders a `<Link to="/masuk">` for `null` and the real
   * button only for `true`/`false`. Without it the entire follow/unfollow
   * feature was unreachable from `/@handle` in the running app for every
   * signed-in user — the profile page being the primary place this phase
   * exists to put it.
   *
   * The old code path was a bare `fetch()` whose own docstring asserted
   * "attaching a stale Authorization header to a request nothing checks
   * would be pointless". That was true when it was written (Task 6 of the
   * accounts phase) and became false the moment Task 2 of THIS phase added
   * `resolveViewerId` to the route — a written assumption that outlived the
   * code it described, which is exactly what the ledger's standing lesson
   * warns about.
   *
   * BOTH DIRECTIONS ARE PINNED, deliberately: sending the header always
   * would break a signed-out visitor's "Masuk untuk mengikuti" if a stale
   * token were ever present, and sending it never is the bug above.
   */
  it("sends the stored bearer token on a public profile fetch — viewerFollows depends on it", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init: RequestInit | undefined) => {
      calls.push({ url, init });
      return jsonResponse({
        handle: "budi",
        displayName: "Budi",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        followerCount: 1,
        followingCount: 0,
        viewerFollows: false,
      });
    }) as unknown as typeof fetch;

    const profile = await getProfileByHandle("budi");

    expect(calls[0]!.url).toBe("/users/by-handle/budi");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(profile.viewerFollows).toBe(false);
  });

  it("sends NO Authorization header on a public profile fetch when signed out", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init: RequestInit | undefined) => {
      calls.push({ url, init });
      return jsonResponse({
        handle: "budi",
        displayName: "Budi",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        followerCount: 1,
        followingCount: 0,
        viewerFollows: null,
      });
    }) as unknown as typeof fetch;

    const profile = await getProfileByHandle("budi");

    expect(getUserToken()).toBeNull();
    expect(new Headers(calls[0]!.init?.headers).has("Authorization")).toBe(false);
    expect(profile.viewerFollows).toBeNull();
  });

  it("throws a 404 for an unknown handle", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "user not found" }, 404)) as unknown as typeof fetch;

    const err = await getProfileByHandle("nosuchuser").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UserApiError);
    expect((err as UserApiError).status).toBe(404);
  });

  it("gets the caller's own profile with the bearer header", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        handle: "wildan",
        displayName: "Wildan",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "wildan@example.com",
        whatsappNumber: null,
      });
    }) as unknown as typeof fetch;

    const profile = await getOwnProfile();

    expect(calls[0]!.url).toBe("/users/me");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(profile.email).toBe("wildan@example.com");
    // Runtime half of the I2 pin above: the ACTUAL parsed response carries
    // exactly the six own-profile fields — never the three follow fields a
    // `PublicUserProfile`-based `OwnUserProfile` would (wrongly) claim.
    expect(Object.keys(profile).sort()).toEqual(
      ["bio", "createdAt", "displayName", "email", "handle", "whatsappNumber"].sort()
    );
  });

  it("patches the display name via PATCH /users/me", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        handle: "wildan",
        displayName: "Wildan Baru",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "wildan@example.com",
        whatsappNumber: null,
      });
    }) as unknown as typeof fetch;

    const updated = await updateOwnProfile({ displayName: "Wildan Baru" });

    expect(calls[0]!.url).toBe("/users/me");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ displayName: "Wildan Baru" });
    expect(updated.displayName).toBe("Wildan Baru");
  });
});

describe("password reset", () => {
  it("posts the email to /users/password-reset/request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const result = await requestPasswordReset("wildan@example.com");

    expect(calls[0]!.url).toBe("/users/password-reset/request");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "wildan@example.com" });
    expect(result).toEqual({ ok: true });
  });

  it("resolves the identical { ok: true } shape whether or not the account exists", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    const knownResult = await requestPasswordReset("wildan@example.com");
    const unknownResult = await requestPasswordReset("nobody@example.com");

    expect(knownResult).toEqual(unknownResult);
  });

  it("posts the token and new password to /users/password-reset/complete", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await completePasswordReset("abc123", "newpassword1");

    expect(calls[0]!.url).toBe("/users/password-reset/complete");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ token: "abc123", newPassword: "newpassword1" });
  });

  it("throws a 401 for an invalid, expired or used token", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired reset link" }, 401)) as unknown as typeof fetch;

    const err = (await completePasswordReset("bad-token", "newpassword1").catch((e: unknown) => e)) as UserApiError;

    expect(err.status).toBe(401);
  });
});

describe("follow", () => {
  it("POSTs to /users/:handle/follow with the bearer header and resolves the resulting state", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: true });
    }) as unknown as typeof fetch;

    const result = await followUser("budi");

    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(result).toEqual({ following: true });
  });

  it("DELETEs to /users/:handle/follow and resolves the resulting state", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: false });
    }) as unknown as typeof fetch;

    const result = await unfollowUser("budi");

    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(result).toEqual({ following: false });
  });

  it("throws a 409 for a self-follow", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "tidak bisa mengikuti akun sendiri" }, 409)
    ) as unknown as typeof fetch;

    const err = (await followUser("wildan").catch((e: unknown) => e)) as UserApiError;

    expect(err.status).toBe(409);
  });
});

describe("follow lists and Jelajah", () => {
  it("fetches followers without an Authorization header, unauthenticated", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse([{ handle: "budi", displayName: "Budi", bio: null }]);
    }) as unknown as typeof fetch;

    const rows = await listFollowers("wildan");

    expect(calls[0]!.url).toBe("/users/wildan/followers");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
    expect(rows).toEqual([{ handle: "budi", displayName: "Budi", bio: null }]);
  });

  it("appends ?limit= for followers when given a limit", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await listFollowers("wildan", 10);

    expect(calls[0]).toBe("/users/wildan/followers?limit=10");
  });

  it("fetches following the same way", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse([{ handle: "budi", displayName: "Budi", bio: null }]);
    }) as unknown as typeof fetch;

    const rows = await listFollowing("wildan");

    expect(calls[0]).toBe("/users/wildan/following");
    expect(rows).toEqual([{ handle: "budi", displayName: "Budi", bio: null }]);
  });

  it("throws a 404 for an unknown handle's followers", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "user not found" }, 404)) as unknown as typeof fetch;

    const err = (await listFollowers("nosuchuser").catch((e: unknown) => e)) as UserApiError;

    expect(err.status).toBe(404);
  });

  it("calls /users/explore with no query string when q is omitted", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    const result = await exploreUsers();

    expect(calls[0]).toBe("/users/explore");
    expect(result).toEqual({ results: [], newest: [], mostFollowed: [] });
  });

  it("calls /users/explore?q=... when a query is given, and never on an empty one", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    await exploreUsers({ q: "budi" });
    await exploreUsers({ q: "" });

    expect(calls[0]).toBe("/users/explore?q=budi");
    expect(calls[1]).toBe("/users/explore");
  });
});
