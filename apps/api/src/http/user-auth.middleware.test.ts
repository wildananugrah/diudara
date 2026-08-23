import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { errorHandler } from "./error-handler";
import { requireUserAuth, type UserAuthVariables } from "./user-auth.middleware";
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
    async searchPublic() {
      throw new Error("not used in these tests");
    },
    async newestPublic() {
      throw new Error("not used in these tests");
    },
    async mostFollowedPublic() {
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
 * FOREIGN-TOKEN REJECTION, using the REAL user issuer — not the string-format
 * fake above, which would pass trivially without proving anything about `typ`.
 *
 * THIS FILE USED TO TEST BOTH DIRECTIONS. Two token audiences shared one
 * `JWT_SECRET`: creator sessions (`HonoJwtTokenIssuer`, `typ: "creator"`,
 * behind `requireAuth`) and user sessions. Retire-telegram Task 7's fix round
 * deleted the creator audience outright — its issuer, its port, its
 * middleware, and the `/auth` and `/payment-account` routes that were the only
 * things behind it. The two tests whose SUBJECT was `requireAuth` went with
 * it: there is no `requireAuth` to reject anything any more.
 *
 * THE SURVIVING PROPERTY IS THE ONE THAT MATTERS, and it is unchanged: a token
 * signed with this process's `JWT_SECRET` that is NOT a genuine user token is
 * refused. Nothing mints a `typ: "creator"` token now, so both tests below
 * FORGE their input with `sign()` rather than asking an issuer for one —
 * which is exactly how the `typ`-isolating case already worked, and it loses
 * no coverage: what is being verified is the VERIFIER, never the minter.
 *
 * TWO CASES, BECAUSE ONE IS NOT ENOUGH, and a review caught that the first
 * time. `HonoJwtUserTokenIssuer.verify` requires `userId`/`sessionEpoch` to be
 * present AND `typ` to be `"user"`. A creator-shaped token fails on the FIELD
 * guards alone (its payload has no `userId`), so deleting the `typ` check
 * would still pass the first test — confirmed by doing exactly that. The
 * second case forges a token carrying BOTH audiences' claims, so every field
 * guard is satisfied and only `typ` can reject it. That is what proves `typ`
 * is a real boundary rather than decoration, and it is why the claim survives
 * the other audience's deletion: `typ` now says "this secret signs more than
 * sessions; only a session is accepted here".
 */
describe("foreign-token rejection (real user issuer, shared JWT_SECRET)", () => {
  const SHARED_SECRET = "shared-jwt-secret-for-cross-audience-test";
  const realUserIssuer = new HonoJwtUserTokenIssuer(SHARED_SECRET);
  const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

  it("requireUserAuth rejects a creator-shaped token (payload lacks userId/sessionEpoch)", async () => {
    const app = new Hono<{ Variables: UserAuthVariables }>();
    app.onError(errorHandler);
    app.use("/me", requireUserAuth(realUserIssuer, fakeUserRepository([record()])));
    app.get("/me", (c) => c.json({ userId: c.get("userId") }));

    // The exact payload the deleted `HonoJwtTokenIssuer.issue` stamped:
    // `creatorId` and `typ: "creator"`, nothing else.
    const creatorToken = await sign(
      { creatorId: "creator-1", typ: "creator", exp: FAR_FUTURE },
      SHARED_SECRET,
      "HS256"
    );
    const res = await app.request("/me", {
      headers: { Authorization: `Bearer ${creatorToken}` },
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
});
