import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { apiFetch, apiRequest, DashboardApiError, login, signup } from "./apiClient";
import { getToken, setSession } from "./auth";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

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

describe("apiFetch", () => {
  it("attaches the stored token as a bearer header", async () => {
    setSession("jwt-abc", CREATOR);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse([{ id: "community-1" }]);
    }) as unknown as typeof fetch;

    await apiFetch("/communities");

    expect(calls[0]!.url).toBe("/communities");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("never puts the token in the URL", async () => {
    setSession("jwt-abc", CREATOR);
    const urls: string[] = [];
    global.fetch = mock(async (url: string) => {
      urls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;

    await apiFetch("/communities/community-1/metrics");

    expect(urls.every((u) => !u.includes("jwt-abc"))).toBe(true);
  });

  it("clears the token on a 401 from any endpoint", async () => {
    setSession("jwt-stale", CREATOR);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid or expired token" }, 401)
    ) as unknown as typeof fetch;

    await expect(apiFetch("/communities")).rejects.toThrow();
    // A stale 7-day token otherwise leaves every panel erroring with no way out.
    expect(getToken()).toBeNull();
  });

  it("throws a 404 without clearing the token", async () => {
    setSession("jwt-abc", CREATOR);
    global.fetch = mock(async () =>
      jsonResponse({ error: "community not found" }, 404)
    ) as unknown as typeof fetch;

    const err = await apiFetch("/communities/nope/metrics").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DashboardApiError);
    expect((err as DashboardApiError).status).toBe(404);
    expect(getToken()).toBe("jwt-abc");
  });

  it("splits a 400's validation message into per-field messages", async () => {
    setSession("jwt-abc", CREATOR);
    global.fetch = mock(async () =>
      jsonResponse(
        { error: "name: String must contain at least 1 character(s); priceAmount: Expected integer" },
        400
      )
    ) as unknown as typeof fetch;

    const err = (await apiFetch("/communities/community-1/tiers", {
      method: "POST",
      body: "{}",
    }).catch((e: unknown) => e)) as DashboardApiError;

    expect(err.fieldErrors.name).toContain("at least 1 character");
    expect(err.fieldErrors.priceAmount).toBe("Expected integer");
  });

  it("keeps an unfielded 400 message as the general message", async () => {
    setSession("jwt-abc", CREATOR);
    global.fetch = mock(async () =>
      jsonResponse({ error: "request body must be valid JSON" }, 400)
    ) as unknown as typeof fetch;

    const err = (await apiFetch("/communities", { method: "POST", body: "oops" }).catch(
      (e: unknown) => e
    )) as DashboardApiError;

    expect(err.fieldErrors).toEqual({});
    expect(err.message).toBe("request body must be valid JSON");
  });

  it("sends JSON content-type for a body without the caller repeating it", async () => {
    setSession("jwt-abc", CREATOR);
    const calls: RequestInit[] = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse({ id: "community-1" }, 201);
    }) as unknown as typeof fetch;

    await apiFetch("/communities", { method: "POST", body: JSON.stringify({ name: "Kelas Budi" }) });

    expect(new Headers(calls[0]!.headers).get("Content-Type")).toBe("application/json");
  });

  it("returns the raw response from apiRequest so a CSV download can read the body", async () => {
    setSession("jwt-abc", CREATOR);
    const calls: RequestInit[] = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("memberId,name\n", {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const res = await apiRequest("/communities/community-1/members.csv");

    expect(new Headers(calls[0]!.headers).get("Authorization")).toBe("Bearer jwt-abc");
    expect(await res.text()).toContain("memberId");
  });
});

describe("login and signup", () => {
  it("stores the session on a successful login", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ creator: CREATOR, token: "jwt-fresh" })
    ) as unknown as typeof fetch;

    await login({ email: "budi@example.com", password: "supersecret123" });

    expect(getToken()).toBe("jwt-fresh");
  });

  it("does not send an Authorization header when logging in", async () => {
    // A stale token must not travel with the credentials that are meant to
    // replace it — and login's own 401 must not be read as "session expired".
    setSession("jwt-stale", CREATOR);
    const calls: RequestInit[] = [];
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse({ creator: CREATOR, token: "jwt-fresh" });
    }) as unknown as typeof fetch;

    await login({ email: "budi@example.com", password: "supersecret123" });

    expect(new Headers(calls[0]!.headers).get("Authorization")).toBeNull();
  });

  it("leaves a stale token alone when the credentials are refused", async () => {
    setSession("jwt-stale", CREATOR);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid email or password" }, 401)
    ) as unknown as typeof fetch;

    const err = (await login({ email: "budi@example.com", password: "wrong" }).catch(
      (e: unknown) => e
    )) as DashboardApiError;

    expect(err.status).toBe(401);
    // login() is deliberately outside the session interceptor: it has no session
    // to invalidate, and a refused password is not an expired session.
    expect(getToken()).toBe("jwt-stale");
  });

  it("stores the session on a successful signup", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ creator: CREATOR, token: "jwt-new" }, 201)
    ) as unknown as typeof fetch;

    await signup({ name: "Budi", email: "budi@example.com", password: "supersecret123" });

    expect(getToken()).toBe("jwt-new");
  });
});
