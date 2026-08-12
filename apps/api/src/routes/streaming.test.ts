import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import type { TokenIssuerPort } from "../application/ports/token-issuer.port";
import type { AuthVariables } from "../http/auth.middleware";
import { errorHandler } from "../http/error-handler";
import { streamingRoutes } from "./streaming";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

describe("GET /streaming/status", () => {
  it("reports enabled: true when a provider is wired (FakeStreamingAdapter under NODE_ENV=test)", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/streaming/status", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/streaming/status");
    expect(res.status).toBe(401);
  });
});

describe("GET /streaming/status when the feature is disabled", () => {
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
    honoApp.route(
      "/streaming",
      streamingRoutes({ tokenIssuer: fakeTokenIssuer, scheduleLiveSession: undefined })
    );
    return honoApp;
  }

  it("reports enabled: false, the ONE signal a disabled feature is surfaced through", async () => {
    const res = await disabledApp().request("/streaming/status", {
      headers: { Authorization: "Bearer valid" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
