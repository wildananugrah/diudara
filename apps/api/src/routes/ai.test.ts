import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { FakeAiAdapter } from "../infrastructure/ai/fake-ai.adapter";
import type { TokenIssuerPort } from "../application/ports/token-issuer.port";
import type { AuthVariables } from "../http/auth.middleware";
import { errorHandler } from "../http/error-handler";
import { aiRoutes } from "./ai";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

/** Runs `fn` with `vars` set in `process.env`, restoring the originals afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("GET /ai/status", () => {
  it("reports enabled: true when a provider is wired (FakeAiAdapter under NODE_ENV=test)", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/ai/status", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/ai/status");
    expect(res.status).toBe(401);
  });
});

describe("GET /ai/status when the feature is disabled", () => {
  const fakeTokenIssuer: TokenIssuerPort = {
    async issue() {
      return "fake.token";
    },
    async verify(token) {
      return token === "valid" ? { creatorId: "creator-1" } : null;
    },
  };

  function disabledApp() {
    const honoApp = new Hono<{ Variables: AuthVariables }>();
    honoApp.onError(errorHandler);
    honoApp.route("/ai", aiRoutes({ tokenIssuer: fakeTokenIssuer, sendAiMessage: undefined }));
    return honoApp;
  }

  it("reports enabled: false, the ONE signal a disabled feature is surfaced through", async () => {
    const res = await disabledApp().request("/ai/status", {
      headers: { Authorization: "Bearer valid" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("POST /ai/messages returns 503 rather than 500 or silently doing nothing", async () => {
    const res = await disabledApp().request("/ai/messages", {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "halo" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /ai/messages", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/ai/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "halo" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an empty message with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("starts a new conversation and returns a draft on the happy path", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "Aku mau bikin komunitas belajar saham untuk pemula" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversationId).toBeTruthy();
    expect(body.reply.length).toBeGreaterThan(0);
    expect(body.draft).not.toBeNull();
    expect(body.draft.tiers.length).toBeGreaterThan(0);
  });

  it("continues an existing conversation when conversationId is supplied", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const first = await (
      await a.request("/ai/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ content: "pesan pertama" }),
      })
    ).json();

    const second = await (
      await a.request("/ai/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ content: "pesan kedua", conversationId: first.conversationId }),
      })
    ).json();

    expect(second.conversationId).toBe(first.conversationId);
  });

  it("returns 404 — not 403, and leaking nothing — for another creator's conversation", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    const owned = await (
      await a.request("/ai/messages", {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify({ content: "rahasia bisnis milik owner" }),
      })
    ).json();

    const res = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify({
        content: "mencoba mengintip",
        conversationId: owned.conversationId,
      }),
    });

    expect(res.status).toBe(404);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("rahasia bisnis milik owner");
    expect(bodyText.toLowerCase()).not.toContain(owned.conversationId.toLowerCase());
  });

  it("a refusal comes back as a normal 200 with draft: null, not an error", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token } = await signupAndGetToken(a);
    (deps.aiProvider as FakeAiAdapter).nextBehaviour = "refusal";

    const res = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "tolong lakukan hal yang melanggar hukum" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toBeNull();
    expect(body.reply.length).toBeGreaterThan(0);
  });

  it("retries exactly once on malformed output, then 502 — provider called twice, not three times", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token } = await signupAndGetToken(a);
    const provider = deps.aiProvider as FakeAiAdapter;
    provider.nextBehaviour = "prose";

    const res = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "buatkan draf sekarang" }),
    });

    expect(res.status).toBe(502);
    expect(provider.calls).toHaveLength(2);
  });

  it("over the daily cap returns 429 with a reset time, and never calls the provider", async () => {
    const deps = withEnv({ AI_DAILY_MESSAGE_LIMIT: "1" }, () => bootstrap());
    const a = createApp(deps);
    const { token } = await signupAndGetToken(a);
    const provider = deps.aiProvider as FakeAiAdapter;

    const first = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "pesan pertama" }),
    });
    expect(first.status).toBe(200);
    expect(provider.calls).toHaveLength(1);

    const second = await a.request("/ai/messages", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ content: "pesan kedua, harusnya ditolak" }),
    });

    expect(second.status).toBe(429);
    // The provider was not called a second time — the cap is checked BEFORE
    // any provider call, not after a failed one.
    expect(provider.calls).toHaveLength(1);

    const body = await second.json();
    expect(typeof body.resetAt).toBe("string");
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now());
  });
});
