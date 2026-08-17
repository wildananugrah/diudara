import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  apiFetch,
  apiRequest,
  completePasswordReset,
  getOwnProfile,
  getProfileByHandle,
  getSessionUser,
  getUserToken,
  login,
  requestPasswordReset,
  setUserSession,
  signup,
  updateOwnProfile,
  UserApiError,
  USER_TOKEN_STORAGE_KEY,
} from "./apiClient";

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

  it("clears the token on a 401 from any endpoint", async () => {
    setUserSession("jwt-stale", USER);
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired token" }, 401)) as unknown as typeof fetch;

    await expect(apiFetch("/users/me")).rejects.toThrow();
    expect(getUserToken()).toBeNull();
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
  it("fetches a public profile by bare handle", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null, createdAt: "2026-01-01T00:00:00.000Z" });
    }) as unknown as typeof fetch;

    const profile = await getProfileByHandle("wildan");

    expect(calls[0]).toBe("/users/by-handle/wildan");
    expect(profile.handle).toBe("wildan");
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
