import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiFetch,
  apiRequest,
  completePasswordReset,
  connectPayout,
  createOwnTier,
  createPost,
  deactivateOwnTier,
  deletePost,
  editPost,
  exploreUsers,
  followUser,
  getMaxPostImages,
  getOwnProfile,
  getPayoutStatus,
  getProfileByHandle,
  getSessionUser,
  getUserToken,
  isOwnHandle,
  isUserSignedIn,
  listFeed,
  listFollowers,
  listFollowing,
  listOwnTiers,
  listUserPosts,
  loadPostImageLimit,
  login,
  mediaThumbUrl,
  repairSplitSession,
  requestPasswordReset,
  resetPostImageLimitForTesting,
  subscribeToPostImageLimit,
  uploadMedia,
  SESSION_EXPIRED_MESSAGE,
  SessionStorageError,
  setUserSession,
  subscribeToUserAuth,
  signup,
  startSubscription,
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

/**
 * `SessionUser` no longer declares `id` (Task 7, step 1) — `GET /users/me`
 * has never returned one, so `repairSplitSession` could not rebuild the
 * cached blob if `id` stayed required. `USER` above keeps its `id` because
 * dropping it would be unrelated fixture churn (passing `USER` where
 * `SessionUser` is expected still typechecks — it's a variable, not a fresh
 * object literal, so TypeScript's excess-property check does not apply).
 * This is the shape `getSessionUser()` actually returns now: `id`, if it
 * made it into storage at all, is read back and ignored.
 */
const SESSION_USER = { handle: USER.handle, displayName: USER.displayName, email: USER.email };

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

/**
 * Re-review N6: `getProfileByHandle` was a hand-rolled COPY of `publicGet` —
 * its own `fetch`, its own `authorizedHeaders`, its own `readError` — so there
 * were two places to forget the viewer's Authorization header. It was then
 * forgotten in each, separately: in `getProfileByHandle` until `11b8848` (the
 * gate's Critical) and in `publicGet` until `926bb10` (the same Critical, one
 * function over). Two places, two incidents.
 *
 * These two tests hold the collapse from both ends: the SHAPE (only the three
 * sanctioned helpers may touch `fetch` at all) and the BEHAVIOUR (every public
 * GET sends the token, and none invents one when signed out), driven through
 * the real exported functions rather than through `publicGet` directly.
 */
describe("apiClient — one place to reach the network (N6)", () => {
  it("only apiRequest, publicPost and publicGet call fetch at all", () => {
    const source = readFileSync(join(import.meta.dir, "apiClient.ts"), "utf8");
    // Every `fetch(` in the file, attributed to the nearest function
    // declaration above it. A hand-rolled request inside any OTHER function is
    // exactly the duplication this test exists to prevent coming back.
    const owners = new Set<string>();
    for (const match of source.matchAll(/\bfetch\s*\(/g)) {
      const before = source.slice(0, match.index);
      const declarations = [...before.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*[<(]/g)];
      owners.add(declarations[declarations.length - 1]?.[1] ?? "<top level>");
    }

    expect([...owners].sort()).toEqual(["apiRequest", "publicGet", "publicPost"]);
  });

  it("every public GET sends the token when signed in, and none when signed out", async () => {
    // Table-driven over the REAL exported functions, so this covers
    // `getProfileByHandle` — the one that used to be its own copy — on exactly
    // the same footing as the three that always went through `publicGet`.
    const publicGets: Array<[string, () => Promise<unknown>]> = [
      ["getProfileByHandle", () => getProfileByHandle("wildan")],
      ["listFollowers", () => listFollowers("wildan")],
      ["listFollowing", () => listFollowing("wildan")],
      ["exploreUsers", () => exploreUsers({ q: "budi" })],
    ];

    // Collected into an array rather than a reassigned `let`: TypeScript
    // narrows a `let` the mock writes to behind its back down to `never`.
    const seen: Array<RequestInit | undefined> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    for (const [name, call] of publicGets) {
      localStorage.clear();
      setUserSession("jwt-abc", USER);
      await call();
      expect(`${name} signed in: ${new Headers(seen.at(-1)?.headers).get("Authorization")}`).toBe(
        `${name} signed in: Bearer jwt-abc`
      );

      localStorage.clear();
      await call();
      expect(`${name} signed out: ${new Headers(seen.at(-1)?.headers).get("Authorization")}`).toBe(
        `${name} signed out: null`
      );
    }
  });
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
    // Not `toEqual(USER)`: `getSessionUser()` only ever reads back the three
    // fields `SessionUser` declares. `USER`'s `id` is stored (see the next
    // test) but never returned.
    expect(getSessionUser()).toEqual(SESSION_USER);
    expect(getUserToken()).toBe("jwt-abc");
  });

  /**
   * Task 7, step 1. `GET /users/me` has never returned an `id`, so
   * `SessionUser` dropped the field — but a blob written by a build that
   * still had it (or hand-edited in devtools) must not suddenly stop
   * parsing. Extra keys are ignored, not rejected.
   */
  it("still parses a stored blob that contains an id key from an older build", () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    localStorage.setItem(
      "diudara.user.account",
      JSON.stringify({ id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" })
    );

    expect(getSessionUser()).toEqual(SESSION_USER);
  });

  /**
   * Fix round 1, item 3. The test above pins that an id-CARRYING blob still
   * parses; every other test in this file that stores a session goes through
   * `setUserSession(token, USER)`, and `USER` always carries an `id` (it has
   * to, so it also exercises the test above) — so nothing directly pinned
   * that `SessionUser`/`getSessionUser` accept a blob with NO `id` key at
   * all, which is `repairSplitSession`'s own rebuilt shape
   * (`{ handle, displayName, email }`, no `id`). This writes exactly that
   * shape by hand, without going through `repairSplitSession` or
   * `setUserSession`, so Step 1 is pinned directly rather than only via the
   * repair path.
   */
  it("also accepts a stored blob with no id key at all", () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    localStorage.setItem(
      "diudara.user.account",
      JSON.stringify({ handle: "wildan", displayName: "Wildan", email: "wildan@example.com" })
    );

    expect(getSessionUser()).toEqual(SESSION_USER);
  });
});

/**
 * Final-review I2, both halves.
 *
 * ATOMICITY: `setUserSession` wrote the token then the account inside ONE
 * `try`. A failure on the SECOND `setItem` — quota, or Safari's storage
 * behaviour, the same class of failure `getUserToken`'s own try/catch already
 * anticipates — left the token persisted, un-rolled-back, with `notify()`
 * skipped. The review measured what that state does: a live "Ikuti" button on
 * your own profile, collecting the 409 three docstrings exist to prevent.
 *
 * SINGLE KEY: "is there a session?" was answered from `diudara.user.token` in
 * one place and `diudara.user.account` in another. `isUserSignedIn` is now the
 * one answer, and it reads the token.
 */
describe("session storage — atomicity and one source of truth (item 4)", () => {
  /**
   * Swaps `globalThis.localStorage` for a working in-memory stub that refuses
   * writes to keys containing `refuseKeyFragment` — the quota shape the review
   * described, where the short token fits and the longer account JSON does not.
   *
   * The whole object is replaced rather than `setItem` patched: happy-dom's
   * `localStorage` routes method calls through an internal handler, so neither
   * an own-property assignment nor a `Storage.prototype` patch intercepts
   * anything (measured — both were silently ignored, with the real value still
   * written). Restored by the returned function, which every test below calls
   * in a `finally`: a leaked override would break every later test in this file.
   */
  function refuseWritesTo(refuseKeyFragment: string): () => void {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          if (key.includes(refuseKeyFragment)) throw new Error("QuotaExceededError");
          store.set(key, value);
        },
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
    return () => {
      Object.defineProperty(globalThis, "localStorage", real);
    };
  }

  it("guards the guard: a refused write really does reach setUserSession", () => {
    // Without this, a `refuseWritesTo` that silently stopped intercepting would
    // make every assertion below pass vacuously — which is exactly what the
    // first two attempts at this helper did.
    const restore = refuseWritesTo("diudara.user.token");
    let stored: string | null = "not read";
    try {
      setUserSession("jwt-abc", USER);
      stored = getUserToken();
    } finally {
      restore();
    }
    // The FIRST write failing writes nothing at all, so there is no half state
    // to clean up. Documented behaviour, not a bug: a browser with storage
    // disabled entirely should still complete a login for the life of the page,
    // which is why this case returns rather than throwing.
    expect(stored).toBeNull();
  });

  it("rolls the token back and THROWS when the account write fails", () => {
    const restore = refuseWritesTo("diudara.user.account");
    let thrown: unknown = null;
    let tokenAfter: string | null = "not read";
    let accountAfter: unknown = "not read";
    let signedInAfter: boolean | string = "not read";
    try {
      try {
        setUserSession("jwt-abc", USER);
      } catch (err) {
        thrown = err;
      }
      tokenAfter = getUserToken();
      accountAfter = getSessionUser();
      signedInAfter = isUserSignedIn();
    } finally {
      restore();
    }

    expect(thrown).toBeInstanceOf(SessionStorageError);
    // THE POINT: no half session survives. Before this fix the token was
    // already persisted here and never rolled back.
    expect(tokenAfter).toBeNull();
    expect(accountAfter).toBeNull();
    expect(signedInAfter).toBe(false);
  });

  it("the thrown message is Bahasa Indonesia, since LoginPage renders it", () => {
    const restore = refuseWritesTo("diudara.user.account");
    try {
      expect(() => setUserSession("jwt-abc", USER)).toThrow(
        "Sesi tidak dapat disimpan di peramban ini. Coba lagi atau aktifkan penyimpanan situs."
      );
    } finally {
      restore();
    }
  });

  it("does not announce a session it failed to store", () => {
    let notifications = 0;
    const unsubscribe = subscribeToUserAuth(() => {
      notifications += 1;
    });
    const restore = refuseWritesTo("diudara.user.account");
    try {
      expect(() => setUserSession("jwt-abc", USER)).toThrow();
    } finally {
      restore();
      unsubscribe();
    }

    expect(notifications).toBe(0);
  });

  it("isUserSignedIn reads the TOKEN key — true with a token and no cached account", () => {
    setUserSession("jwt-abc", USER);
    localStorage.removeItem("diudara.user.account");

    expect(isUserSignedIn()).toBe(true);
    // The two questions are different, and this is what makes them different:
    // the session exists, the identity behind it is unknown.
    expect(getSessionUser()).toBeNull();
  });

  it("isUserSignedIn reads the TOKEN key — false with a cached account and no token", () => {
    setUserSession("jwt-abc", USER);
    localStorage.removeItem(USER_TOKEN_STORAGE_KEY);

    expect(isUserSignedIn()).toBe(false);
    // Deliberately asserted the other way round from the test above: a reader
    // that had been switched to the account key would pass one of these two
    // and fail the other, never both.
    expect(getSessionUser()).toEqual(SESSION_USER);
  });
});

/**
 * Task 7. The token key and the account key can disagree — a corrupt or
 * hand-edited account blob leaves `isUserSignedIn()` true while
 * `getSessionUser()` is null, and in that state a live "Ikuti" renders on
 * your own profile (Phase 2's final review, repaired at the cause here
 * rather than at each screen that renders wrongly because of it).
 */
describe("repairSplitSession", () => {
  it("rebuilds the account blob when a token is present and the account is missing", async () => {
    // arrange: write ONLY the token key, no account key
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    expect(getSessionUser()).toBeNull();

    // arrange: fetch returns the /users/me shape
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
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

    // act
    await repairSplitSession();

    // assert: fetch was called with /users/me — the positive control for the
    // two "does nothing" tests below, which assert the opposite.
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/users/me");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");

    // assert: getSessionUser() is non-null, handle matches
    const session = getSessionUser();
    expect(session !== null).toBe(true);
    expect(session!.handle).toBe("wildan");
    // Fix round 1, item 2: the reviewer measured that sourcing all three
    // fields off `me.handle` (`{ handle: me.handle, displayName: me.handle,
    // email: me.handle }`) survived every test that existed before this one
    // was added — `displayName` ("Wildan") and `email`
    // ("wildan@example.com") both differ from `handle` ("wildan") in the
    // mocked response above specifically so a same-value mutation cannot
    // hide behind them matching by coincidence.
    expect(session!.displayName).toBe("Wildan");
    expect(session!.email).toBe("wildan@example.com");
    expect(getUserToken()).toBe("jwt-abc");
  });

  it("does nothing when both keys are present", async () => {
    setUserSession("jwt-abc", USER);
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;

    await repairSplitSession();

    expect(calls.length).toBe(0);
  });

  it("does nothing when there is no token at all", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;

    // A signed-out visitor must not hit /users/me.
    expect(isUserSignedIn()).toBe(false);

    await repairSplitSession();

    expect(calls.length).toBe(0);
  });

  it("leaves the user signed out when /users/me 401s", async () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-dead");
    global.fetch = mock(async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch;

    let thrown: unknown = null;
    try {
      // apiFetch clears the token on a 401.
      await repairSplitSession();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    expect(isUserSignedIn()).toBe(false);
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
    // The server's `/users/login` response still carries `id` (confirmed
    // against the running server) — it lands in storage as an extra key and
    // is simply ignored on read-back, same as `SESSION_USER` above.
    expect(getSessionUser()).toEqual(SESSION_USER);
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
  /**
   * REWRITTEN BY THE FINAL REVIEW'S ITEM 1, and the old version is worth
   * recording: it asserted `Authorization` was ABSENT here even while signed in,
   * which was correct when nothing on these routes read a viewer, and became the
   * thing standing in front of the fix the moment they did. The review predicted
   * exactly this — "it becomes the gate's Critical again the moment item 1 is
   * done" — so the assertion is inverted rather than deleted, and the signed-OUT
   * direction gets its own test below so the token cannot start being invented.
   */
  it("SENDS the stored bearer token on a followers fetch — per-row viewerFollows depends on it", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: true }]);
    }) as unknown as typeof fetch;

    const rows = await listFollowers("wildan");

    expect(calls[0]!.url).toBe("/users/wildan/followers");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(rows).toEqual([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: true }]);
  });

  it("sends NO Authorization header on a followers fetch when signed out", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await listFollowers("wildan");

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
  });

  it("sends the token on a following fetch too — same publicGet, same seam", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await listFollowing("wildan");

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("sends the token on the Jelajah explore fetch too", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    await exploreUsers({ q: "budi" });

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("sends NO Authorization header on the explore fetch when signed out", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    await exploreUsers({});

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
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
      return jsonResponse([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: false }]);
    }) as unknown as typeof fetch;

    const rows = await listFollowing("wildan");

    expect(calls[0]).toBe("/users/wildan/following");
    expect(rows).toEqual([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: false }]);
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

const POST_VIEW = {
  id: "post-1",
  body: "Halo",
  createdAt: "2026-08-18T00:00:00.000Z",
  editedAt: null,
  media: [],
  author: { handle: "wildan", displayName: "Wildan" },
};

/**
 * `untuk-anda` is PUBLIC, `mengikuti` is not — Task 4's own docstring on
 * `listFeed` names the exact regression this pins: the header whose absence
 * made the follow button unreachable for every signed-in user in Phase 2,
 * one function over. All three directions matter: no session must still
 * resolve on `untuk-anda`, a session must still be SENT on `untuk-anda`
 * (never omitted just because the endpoint is public), and `mengikuti`
 * requires the Bearer token since that route needs a live session.
 */
describe("apiClient — posts and the feed (Task 4)", () => {
  it("listFeed('untuk-anda') sends no Authorization when there is no session, and still resolves", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ posts: [], nextCursor: null });
    }) as unknown as typeof fetch;

    const page = await listFeed("untuk-anda");

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBeNull();
    expect(page).toEqual({ posts: [], nextCursor: null });
  });

  it("listFeed('untuk-anda') sends the token when there IS a session", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ posts: [], nextCursor: null });
    }) as unknown as typeof fetch;

    await listFeed("untuk-anda");

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("listFeed('mengikuti') sends the viewer's Bearer token", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ posts: [], nextCursor: null });
    }) as unknown as typeof fetch;

    await listFeed("mengikuti");

    expect(calls[0]!.url).toBe("/users/feed?tab=mengikuti");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  /**
   * Fix round 1, I2. `publicGet` and `apiFetch` both call `authorizedHeaders(_,
   * getUserToken())`, so the header tests above pass identically whichever one
   * `listFeed`'s `untuk-anda` branch is wired to — they pin a real regression
   * (Phase 2's unreachable follow button) but do not distinguish the two
   * helpers from each other. The one behavioural difference between them is
   * 401 handling: `apiRequest` (which backs `apiFetch`) clears the session on
   * ANY 401; `publicGet` never does, because `untuk-anda` must degrade to the
   * anonymous view rather than sign a visitor out mid-browse. Proved by
   * mutation below (reviewer's own repro): swapping `untuk-anda` from
   * `publicGet` to `apiFetch` left the whole web suite green until these two
   * tests existed.
   */
  it("listFeed('untuk-anda') leaves the session intact on a 401 — publicGet never clears it", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid or expired token" }, 401)
    ) as unknown as typeof fetch;

    await listFeed("untuk-anda").catch(() => {});

    expect(isUserSignedIn()).toBe(true);
  });

  it("listFeed('mengikuti') clears the session on a 401 — apiFetch always does", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid or expired token" }, 401)
    ) as unknown as typeof fetch;

    await listFeed("mengikuti").catch(() => {});

    expect(isUserSignedIn()).toBe(false);
  });

  it("listFeed appends before= only when given a cursor", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ posts: [], nextCursor: null });
    }) as unknown as typeof fetch;

    await listFeed("untuk-anda");
    await listFeed("untuk-anda", "cursor-1");

    expect(calls[0]).toBe("/users/feed?tab=untuk-anda");
    expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-1");
  });

  it("listUserPosts is public, sends the token when signed in, and omits before when not given", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ posts: [POST_VIEW], nextCursor: "cursor-2" });
    }) as unknown as typeof fetch;

    const page = await listUserPosts("wildan");

    expect(calls[0]!.url).toBe("/users/wildan/posts");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(page).toEqual({ posts: [POST_VIEW], nextCursor: "cursor-2" });
  });

  it("listUserPosts appends ?before= when given a cursor", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ posts: [], nextCursor: null });
    }) as unknown as typeof fetch;

    await listUserPosts("wildan", "cursor-1");

    expect(calls[0]).toBe("/users/wildan/posts?before=cursor-1");
  });

  it("createPost POSTs to /users/posts with the body as JSON", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(POST_VIEW, 201);
    }) as unknown as typeof fetch;

    const result = await createPost("Halo");

    expect(calls[0]!.url).toBe("/users/posts");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ body: "Halo" }));
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(result).toEqual(POST_VIEW);
  });

  it("editPost PATCHes /users/posts/:id with the body as JSON", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ...POST_VIEW, body: "Diedit" });
    }) as unknown as typeof fetch;

    await editPost("post-1", "Diedit");

    expect(calls[0]!.url).toBe("/users/posts/post-1");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ body: "Diedit" }));
  });

  it("deletePost DELETEs /users/posts/:id", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ deleted: true });
    }) as unknown as typeof fetch;

    await deletePost("post-1");

    expect(calls[0]!.url).toBe("/users/posts/post-1");
    expect(calls[0]!.init.method).toBe("DELETE");
  });
});

/**
 * Task 8 — the web learns about media. Three separate things live here:
 * the upload itself (`POST /users/media`, multipart), the advisory limit
 * (`GET /users/limits` plus the store the composer reads it from), and
 * `mediaIds` on create/edit.
 *
 * Every number below is a LITERAL. `FALLBACK_MAX_POST_IMAGES` is never read
 * into an assertion: a test that asserts against the same constant the
 * production code reads moves in lockstep with a regression to it.
 */
describe("apiClient — uploading one photo (Task 8)", () => {
  it("POSTs the file to /users/media as multipart, under the field name the route reads", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ id: "media-1", width: 800, height: 600 }, 201);
    }) as unknown as typeof fetch;

    const result = await uploadMedia(new File(["bytes"], "foto.jpg", { type: "image/jpeg" }));

    expect(calls[0]!.url).toBe("/users/media");
    expect(calls[0]!.init.method).toBe("POST");
    const sent = calls[0]!.init.body as FormData;
    expect(sent instanceof FormData).toBe(true);
    // `routes/media.ts` reads `form.get("file")` and 400s anything else.
    expect((sent.get("file") as File).name).toBe("foto.jpg");
    expect(result).toEqual({ id: "media-1", width: 800, height: 600 });
  });

  it("sends the Bearer token but NO Content-Type — the multipart boundary is the browser's to set", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit }> = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ id: "media-1", width: 1, height: 1 }, 201);
    }) as unknown as typeof fetch;

    await uploadMedia(new File(["bytes"], "foto.jpg", { type: "image/jpeg" }));

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-abc");
    // `authorizedHeaders` sets `application/json` for any body that is not a
    // FormData. Setting it here would strip the boundary `fetch` generates and
    // `c.req.formData()` would parse nothing at all.
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("surfaces the API's refusal as a UserApiError, so errorCopy can shape it", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "Ukuran foto maksimal 8 MB." }, 400)
    ) as unknown as typeof fetch;

    const failure = await uploadMedia(new File(["bytes"], "besar.jpg")).catch((err: unknown) => err);

    expect(failure instanceof UserApiError).toBe(true);
    expect((failure as UserApiError).status).toBe(400);
  });

  it("derives the thumbnail path from the id alone — there is no URL on the wire", () => {
    expect(mediaThumbUrl("media-1")).toBe("/users/media/media-1/thumb");
    expect(mediaThumbUrl("a/b")).toBe("/users/media/a%2Fb/thumb");
  });
});

describe("apiClient — the advisory image limit (Task 8, spec §6)", () => {
  afterEach(() => {
    resetPostImageLimitForTesting();
  });

  it("starts at the built-in default of 5 before anything is fetched", () => {
    expect(getMaxPostImages()).toBe(5);
  });

  it("GETs /users/limits and adopts the server's number", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ maxPostImages: 3 });
    }) as unknown as typeof fetch;

    await loadPostImageLimit();

    expect(calls[0]).toBe("/users/limits");
    expect(getMaxPostImages()).toBe(3);
  });

  it("notifies subscribers when the number changes, so a mounted composer sees it", async () => {
    let notified = 0;
    const unsubscribe = subscribeToPostImageLimit(() => {
      notified += 1;
    });
    global.fetch = mock(async () => jsonResponse({ maxPostImages: 2 })) as unknown as typeof fetch;

    await loadPostImageLimit();
    unsubscribe();

    expect(notified).toBe(1);
    expect(getMaxPostImages()).toBe(2);
  });

  /**
   * Spec §6, the whole point of this endpoint being advisory: "a composer that
   * refuses to open because a config endpoint is down would be a worse product
   * than one that occasionally offers a sixth photo and is told no."
   */
  it("keeps the built-in 5 and never rejects when the endpoint is down", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;

    await loadPostImageLimit();

    expect(getMaxPostImages()).toBe(5);
  });

  it("keeps the built-in 5 when the network is gone entirely", async () => {
    global.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await loadPostImageLimit();

    expect(getMaxPostImages()).toBe(5);
  });

  /**
   * A proxy error page, an older server, a `{ maxPostImages: "5" }` — anything
   * that is not a whole number of at least 1 leaves the fallback alone. Without
   * this the composer would end up with `NaN` or `0` as its cap and disable
   * "Tambah foto" for ever, which is the exact failure mode §6 forbids.
   */
  it("keeps the built-in 5 when the answer is not a whole number of at least 1", async () => {
    for (const nonsense of [{ maxPostImages: "3" }, { maxPostImages: 0 }, { maxPostImages: 2.5 }, {}]) {
      global.fetch = mock(async () => jsonResponse(nonsense)) as unknown as typeof fetch;
      await loadPostImageLimit();
      expect(getMaxPostImages()).toBe(5);
    }
  });
});

describe("apiClient — mediaIds on create and edit (Task 8)", () => {
  it("createPost sends mediaIds in the given order when there are images", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit }> = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(POST_VIEW, 201);
    }) as unknown as typeof fetch;

    await createPost("Halo", ["media-2", "media-1"]);

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      body: "Halo",
      mediaIds: ["media-2", "media-1"],
    });
  });

  it("createPost omits the key entirely when no list is given", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit }> = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(POST_VIEW, 201);
    }) as unknown as typeof fetch;

    await createPost("Halo");

    expect("mediaIds" in JSON.parse(String(calls[0]!.init.body))).toBe(false);
  });

  /**
   * Spec §5.2: `mediaIds` is the COMPLETE desired list, not a delta, and on
   * PATCH an explicit `[]` removes every image while an OMITTED key leaves them
   * alone. The two must stay distinguishable on the wire, so an empty array has
   * to be sent rather than treated as "nothing to say".
   */
  it("editPost sends an explicit empty list — removing every image is not the same as omitting the key", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit }> = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(POST_VIEW);
    }) as unknown as typeof fetch;

    await editPost("post-1", "Diedit", []);

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ body: "Diedit", mediaIds: [] });
  });

  it("editPost omits the key when the caller has nothing to say about images", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit }> = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(POST_VIEW);
    }) as unknown as typeof fetch;

    await editPost("post-1", "Diedit");

    expect("mediaIds" in JSON.parse(String(calls[0]!.init.body))).toBe(false);
  });
});

describe("apiClient — payout and tiers (Task 9)", () => {
  const PAYOUT = { connected: false, provisioning: true, available: true };
  const TIER = {
    id: "tier-1",
    ownerId: "user-1",
    name: "Anggota",
    priceAmount: 50000,
    billingCycle: "monthly",
    isActive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  it("getPayoutStatus GETs /users/me/payout with the bearer header and resolves all three flags", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(PAYOUT);
    }) as unknown as typeof fetch;

    const status = await getPayoutStatus();

    expect(calls[0]!.url).toBe("/users/me/payout");
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
    // All three, not just `connected` — the sentinel state is only visible in
    // `provisioning`, and `available` is the only thing separating "you have
    // not connected" from "this box has no payment provider at all".
    expect(status).toEqual({ connected: false, provisioning: true, available: true });
  });

  it("connectPayout POSTs to /users/me/payout and resolves the RESULTING state", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ connected: true, provisioning: false, available: true });
    }) as unknown as typeof fetch;

    const status = await connectPayout();

    expect(calls[0]!.url).toBe("/users/me/payout");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(status).toEqual({ connected: true, provisioning: false, available: true });
  });

  it("listOwnTiers GETs /users/me/tiers — the owner's management view, active and withdrawn alike", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse([TIER, { ...TIER, id: "tier-2", isActive: false }]);
    }) as unknown as typeof fetch;

    const tiers = await listOwnTiers();

    expect(calls[0]!.url).toBe("/users/me/tiers");
    expect(tiers.map((tier) => tier.isActive)).toEqual([true, false]);
  });

  it("createOwnTier POSTs the name and the integer price", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(TIER, 201);
    }) as unknown as typeof fetch;

    const created = await createOwnTier({ name: "Anggota", priceAmount: 50000 });

    expect(calls[0]!.url).toBe("/users/me/tiers");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      name: "Anggota",
      priceAmount: 50000,
    });
    expect(created.id).toBe("tier-1");
  });

  it("createOwnTier sends billingCycle only when the caller named one", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ init: RequestInit | undefined }> = [];
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse(TIER, 201);
    }) as unknown as typeof fetch;

    await createOwnTier({ name: "Anggota", priceAmount: 50000, billingCycle: "monthly" });

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      name: "Anggota",
      priceAmount: 50000,
      billingCycle: "monthly",
    });
  });

  it("deactivateOwnTier PATCHes the tier with isActive:false — the only edit the server accepts", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ...TIER, isActive: false });
    }) as unknown as typeof fetch;

    const updated = await deactivateOwnTier("tier-1");

    expect(calls[0]!.url).toBe("/users/me/tiers/tier-1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ isActive: false });
    expect(updated.isActive).toBe(false);
  });

  it("deactivateOwnTier encodes the id into the path", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string }> = [];
    global.fetch = mock(async (url: string) => {
      calls.push({ url });
      return jsonResponse({ ...TIER, isActive: false });
    }) as unknown as typeof fetch;

    await deactivateOwnTier("a/b c");

    expect(calls[0]!.url).toBe("/users/me/tiers/a%2Fb%20c");
  });
});

/**
 * Task 10 of Phase 5a — the buyer's half of the money path (spec §6).
 */
describe("apiClient — buying a membership (Task 10)", () => {
  const INVOICE = {
    invoiceUrl: "https://checkout.xendit.co/web/inv_1",
    subscriptionId: "sub-1",
    transactionId: "txn-1",
    externalId: "usub_txn-1",
  };

  it("startSubscription POSTs the tier id to /users/:handle/subscribe with the bearer token", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(INVOICE, 201);
    }) as unknown as typeof fetch;

    const started = await startSubscription("budi", "tier-1");

    expect(calls[0]!.url).toBe("/users/budi/subscribe");
    expect(calls[0]!.init?.method).toBe("POST");
    // The BUYER is the session, never anything in the body — the route reads
    // `c.get("userId")` and the body carries exactly one field.
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ tierId: "tier-1" });
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(started.invoiceUrl).toBe("https://checkout.xendit.co/web/inv_1");
  });

  it("startSubscription encodes the handle into the path", async () => {
    setUserSession("jwt-abc", USER);
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse(INVOICE, 201);
    }) as unknown as typeof fetch;

    await startSubscription("a/b c", "tier-1");

    expect(calls[0]).toBe("/users/a%2Fb%20c/subscribe");
  });

  /**
   * The STATUS has to survive, because it is the only thing `errorCopy.ts` can
   * branch on: a 409 from this route is a refusal a retry cannot fix, and the
   * sentence for it differs from every other failure's.
   */
  it("startSubscription rejects with the API's status intact", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "Anda sudah menjadi anggota aktif kreator ini." }, 409)
    ) as unknown as typeof fetch;

    const failure = await startSubscription("budi", "tier-1").catch((err: unknown) => err);

    expect(failure instanceof UserApiError).toBe(true);
    expect((failure as UserApiError).status).toBe(409);
  });

  it("getProfileByHandle carries the creator's offer through", async () => {
    global.fetch = mock(async () =>
      jsonResponse({
        handle: "budi",
        displayName: "Budi",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        followerCount: 0,
        followingCount: 0,
        viewerFollows: null,
        membership: {
          tiers: [{ id: "tier-1", name: "Anggota", priceAmount: 50000, billingCycle: "monthly" }],
          viewerIsMember: true,
          viewerMembershipEnded: false,
        },
      })
    ) as unknown as typeof fetch;

    const profile = await getProfileByHandle("budi");

    expect(profile.membership.tiers).toEqual([
      { id: "tier-1", name: "Anggota", priceAmount: 50000, billingCycle: "monthly" },
    ]);
    // Task 10 fix round 1: the viewer's own half of the same field, and the
    // final review's second half of it — a live member has had nothing end.
    expect(profile.membership.viewerIsMember).toBe(true);
    expect(profile.membership.viewerMembershipEnded).toBe(false);
  });
});

/**
 * ONE answer to "is this profile mine?", shared by `FollowButton` and
 * `MembershipOffer` — both of which must render NOTHING on your own profile,
 * and each of which used to be one asymmetric `.toLowerCase()` away from
 * offering an action the server answers 409 to.
 */
describe("isOwnHandle", () => {
  it("is false with no session at all", () => {
    expect(isOwnHandle("wildan")).toBe(false);
  });

  it("is true for the signed-in user's own handle", () => {
    setUserSession("jwt-abc", USER);
    expect(isOwnHandle("wildan")).toBe(true);
  });

  it("is false for anybody else's handle", () => {
    setUserSession("jwt-abc", USER);
    expect(isOwnHandle("budi")).toBe(false);
  });

  it("normalises BOTH sides — case on either one, and a leading @ on the argument", () => {
    setUserSession("jwt-abc", USER);
    expect(isOwnHandle("WILDAN")).toBe(true);
    expect(isOwnHandle("@wildan")).toBe(true);

    // The SESSION side varied instead: a comparison that lowercased only the
    // argument would still pass the two above (review round 2's Minor on
    // `FollowButton`, kept here now that the comparison lives in one place).
    setUserSession("jwt-abc", { ...USER, handle: "WILDAN" });
    expect(isOwnHandle("wildan")).toBe(true);
  });
});
