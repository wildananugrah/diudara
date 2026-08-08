import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "./error-handler";
import { requireAuth, type AuthVariables } from "./auth.middleware";
import type { TokenIssuerPort, TokenPayload } from "../application/ports/token-issuer.port";

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    if (!token.startsWith("token-for-")) return null;
    return { creatorId: token.replace("token-for-", "") };
  },
};

function protectedApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.use("/me", requireAuth(fakeIssuer));
  app.get("/me", (c) => c.json({ creatorId: c.get("creatorId") }));
  return app;
}

describe("requireAuth", () => {
  it("allows a request with a valid Bearer token and exposes the creator id", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Bearer token-for-creator-9" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creatorId: "creator-9" });
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await protectedApp().request("/me");
    expect(res.status).toBe(401);
  });

  it("rejects a token that does not verify", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an Authorization header that is not a Bearer scheme", async () => {
    const res = await protectedApp().request("/me", {
      headers: { Authorization: "Basic token-for-creator-9" },
    });
    expect(res.status).toBe(401);
  });
});
