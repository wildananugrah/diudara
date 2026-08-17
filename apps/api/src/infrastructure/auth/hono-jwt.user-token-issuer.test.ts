import { describe, expect, it } from "bun:test";
import { decode, sign } from "hono/jwt";
import { HonoJwtUserTokenIssuer } from "./hono-jwt.user-token-issuer";

const SECRET = "test-secret";
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe("HonoJwtUserTokenIssuer", () => {
  it("round-trips a payload", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const token = await issuer.issue({ userId: "user-1", sessionEpoch: 0 });
    const payload = await issuer.verify(token);
    expect(payload?.userId).toBe("user-1");
    expect(payload?.sessionEpoch).toBe(0);
  });

  it("round-trips a nonzero sessionEpoch", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const token = await issuer.issue({ userId: "user-1", sessionEpoch: 3 });
    const payload = await issuer.verify(token);
    expect(payload?.sessionEpoch).toBe(3);
  });

  it("returns null for a token signed with a different secret", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const other = new HonoJwtUserTokenIssuer("different-secret");
    const token = await other.issue({ userId: "user-1", sessionEpoch: 0 });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET, -10);
    const token = await issuer.issue({ userId: "user-1", sessionEpoch: 0 });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for a malformed token", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    expect(await issuer.verify("not.a.jwt")).toBeNull();
  });

  it("stamps a user type discriminator on issued tokens", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const { payload } = decode(await issuer.issue({ userId: "user-1", sessionEpoch: 0 }));
    expect((payload as { typ?: unknown }).typ).toBe("user");
  });

  it("returns null for a correctly-signed token with no exp claim", async () => {
    // hono/jwt only enforces `exp` when the claim is PRESENT. Without this
    // check a signed token that simply omits it verifies forever, and the only
    // way to revoke it is rotating JWT_SECRET — i.e. logging everyone out.
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const noExpiry = await sign(
      { userId: "user-1", sessionEpoch: 0, typ: "user" },
      SECRET,
      "HS256"
    );

    expect(await issuer.verify(noExpiry)).toBeNull();
  });

  it("rejects a token whose typ is \"creator\"", async () => {
    // Both token kinds are signed with the SAME JWT_SECRET; `typ` is the
    // entire boundary between them.
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const creatorToken = await sign(
      { creatorId: "creator-1", typ: "creator", exp: FAR_FUTURE },
      SECRET,
      "HS256"
    );

    expect(await issuer.verify(creatorToken)).toBeNull();
  });

  it("returns null for a correctly-signed token with no typ claim", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const untyped = await sign(
      { userId: "user-1", sessionEpoch: 0, exp: FAR_FUTURE },
      SECRET,
      "HS256"
    );

    expect(await issuer.verify(untyped)).toBeNull();
  });

  it("returns null when userId is missing but the token is otherwise valid", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const noSubject = await sign(
      { sessionEpoch: 0, typ: "user", exp: FAR_FUTURE },
      SECRET,
      "HS256"
    );

    expect(await issuer.verify(noSubject)).toBeNull();
  });

  it("returns null when sessionEpoch is missing but the token is otherwise valid", async () => {
    const issuer = new HonoJwtUserTokenIssuer(SECRET);
    const noEpoch = await sign({ userId: "user-1", typ: "user", exp: FAR_FUTURE }, SECRET, "HS256");

    expect(await issuer.verify(noEpoch)).toBeNull();
  });
});
