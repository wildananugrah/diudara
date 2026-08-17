import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { errorHandler } from "./error-handler";
import { requireUserAuth, type UserAuthVariables } from "./user-auth.middleware";
import { requireAuth, type AuthVariables } from "./auth.middleware";
import { HonoJwtTokenIssuer } from "../infrastructure/auth/hono-jwt.token-issuer";
import { HonoJwtUserTokenIssuer } from "../infrastructure/auth/hono-jwt.user-token-issuer";
import type { UserRecord, UserRepositoryPort } from "../application/ports/user-repository.port";
import type { UserTokenIssuerPort, UserTokenPayload } from "../application/ports/user-token-issuer.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-9",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeUserRepository(rows: UserRecord[]): UserRepositoryPort {
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
  };
}

// Token format: token-for-<userId>-epoch-<sessionEpoch>. Verification does
// not consult the repository at all — that is exactly what distinguishes a
// raw token-issuer check from `requireUserAuth`'s own re-read.
const fakeUserIssuer: UserTokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.userId}-epoch-${payload.sessionEpoch}`;
  },
  async verify(token): Promise<UserTokenPayload | null> {
    const match = token.match(/^token-for-(.+)-epoch-(\d+)$/);
    return match ? { userId: match[1], sessionEpoch: Number(match[2]) } : null;
  },
};

function protectedUserApp(users: UserRepositoryPort) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  app.onError(errorHandler);
  app.use("/me", requireUserAuth(fakeUserIssuer, users));
  app.get("/me", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("requireUserAuth", () => {
  it("allows a request with a valid Bearer token and exposes the user id", async () => {
    const app = protectedUserApp(fakeUserRepository([record()]));
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer token-for-user-9-epoch-0" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-9" });
  });

  it("rejects a request with no Authorization header", async () => {
    const app = protectedUserApp(fakeUserRepository([record()]));
    const res = await app.request("/me");
    expect(res.status).toBe(401);
    // Task 2's refactor collapsed the "no header at all" and "token present
    // but invalid" cases onto ONE message via the shared `verifyBearerToken`
    // helper — this used to say "missing bearer token" specifically. Nothing
    // asserted the exact string before, so the refactor could not have been
    // caught by the suite; pinning it now so a future change to either value
    // is a deliberate edit, not an unnoticed side effect.
    expect(await res.json()).toEqual({ error: "invalid or expired token" });
  });

  it("rejects a malformed Authorization header", async () => {
    const app = protectedUserApp(fakeUserRepository([record()]));
    const res = await app.request("/me", {
      headers: { Authorization: "Basic token-for-user-9-epoch-0" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid or expired token" });
  });

  it("rejects a token that does not verify", async () => {
    const app = protectedUserApp(fakeUserRepository([record()]));
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token whose user no longer exists", async () => {
    const app = protectedUserApp(fakeUserRepository([]));
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer token-for-user-9-epoch-0" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token whose sessionEpoch is BEHIND the user's current epoch", async () => {
    // Simulates a token issued before a password reset: the row's epoch has
    // since been bumped to 1, but this token still carries 0.
    const app = protectedUserApp(fakeUserRepository([record({ sessionEpoch: 1 })]));
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer token-for-user-9-epoch-0" },
    });
    expect(res.status).toBe(401);
  });

  it("allows a token whose sessionEpoch matches the user's current epoch", async () => {
    const app = protectedUserApp(fakeUserRepository([record({ sessionEpoch: 2 })]));
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer token-for-user-9-epoch-2" },
    });
    expect(res.status).toBe(200);
  });
});

/**
 * Both directions, in one file, using the REAL issuers sharing the SAME
 * secret — not the string-format fakes above, which would pass trivially
 * without proving anything about `typ`.
 *
 * The first two tests below are NOT sufficient on their own, and a review
 * caught it: `HonoJwtTokenIssuer.issue` stamps only `creatorId`, and
 * `HonoJwtUserTokenIssuer.issue` stamps only `userId`/`sessionEpoch` — the
 * two payload shapes are DISJOINT. A genuine creator token handed to
 * `requireUserAuth` fails there because `userId`/`sessionEpoch` are simply
 * absent (the `typeof userId !== "string"` guard rejects it), and the
 * mirror image is true for a user token handed to `requireAuth`. Deleting
 * the `typ` check from BOTH issuers at once still passes those two tests —
 * confirmed by doing exactly that. So the first two tests below exercise
 * the field guards, not `typ`.
 *
 * The third and fourth tests isolate `typ` on its own: a token forged with
 * BOTH audiences' claims present (`creatorId` AND `userId`/`sessionEpoch`),
 * differing only in which `typ` it carries. With both payload shapes
 * satisfied, only the `typ` check can reject it — which is what actually
 * proves `typ` is the boundary the brief describes, once both token kinds
 * share one `JWT_SECRET`.
 */
describe("cross-audience token rejection (real issuers, shared JWT_SECRET)", () => {
  const SHARED_SECRET = "shared-jwt-secret-for-cross-audience-test";
  const realCreatorIssuer = new HonoJwtTokenIssuer(SHARED_SECRET);
  const realUserIssuer = new HonoJwtUserTokenIssuer(SHARED_SECRET);
  const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

  it("requireUserAuth rejects a creator token (payload also lacks userId/sessionEpoch)", async () => {
    const app = new Hono<{ Variables: UserAuthVariables }>();
    app.onError(errorHandler);
    app.use("/me", requireUserAuth(realUserIssuer, fakeUserRepository([record()])));
    app.get("/me", (c) => c.json({ userId: c.get("userId") }));

    const creatorToken = await realCreatorIssuer.issue({ creatorId: "creator-1" });
    const res = await app.request("/me", {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });

    expect(res.status).toBe(401);
  });

  it("requireAuth rejects a user token (payload also lacks creatorId)", async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError(errorHandler);
    app.use("/me", requireAuth(realCreatorIssuer));
    app.get("/me", (c) => c.json({ creatorId: c.get("creatorId") }));

    const userToken = await realUserIssuer.issue({ userId: "user-9", sessionEpoch: 0 });
    const res = await app.request("/me", {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.status).toBe(401);
  });

  it("requireUserAuth rejects a token carrying BOTH audiences' claims but typ: \"creator\" — isolates typ", async () => {
    const both = await sign(
      { creatorId: "creator-1", userId: "user-9", sessionEpoch: 0, typ: "creator", exp: FAR_FUTURE },
      SHARED_SECRET,
      "HS256"
    );

    expect(await realUserIssuer.verify(both)).toBeNull();
  });

  it("requireAuth rejects a token carrying BOTH audiences' claims but typ: \"user\" — isolates typ", async () => {
    const both = await sign(
      { creatorId: "creator-1", userId: "user-9", sessionEpoch: 0, typ: "user", exp: FAR_FUTURE },
      SHARED_SECRET,
      "HS256"
    );

    expect(await realCreatorIssuer.verify(both)).toBeNull();
  });
});
