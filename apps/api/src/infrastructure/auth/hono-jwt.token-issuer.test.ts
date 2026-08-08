import { describe, expect, it } from "bun:test";
import { decode, sign } from "hono/jwt";
import { HonoJwtTokenIssuer } from "./hono-jwt.token-issuer";

const SECRET = "test-secret";
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe("HonoJwtTokenIssuer", () => {
  it("round-trips a payload", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    const token = await issuer.issue({ creatorId: "creator-1" });
    const payload = await issuer.verify(token);
    expect(payload?.creatorId).toBe("creator-1");
  });

  it("returns null for a token signed with a different secret", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    const other = new HonoJwtTokenIssuer("different-secret");
    const token = await other.issue({ creatorId: "creator-1" });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret", -10);
    const token = await issuer.issue({ creatorId: "creator-1" });
    expect(await issuer.verify(token)).toBeNull();
  });

  it("returns null for a malformed token", async () => {
    const issuer = new HonoJwtTokenIssuer("test-secret");
    expect(await issuer.verify("not.a.jwt")).toBeNull();
  });

  it("stamps a creator type discriminator on issued tokens", async () => {
    const issuer = new HonoJwtTokenIssuer(SECRET);
    const { payload } = decode(await issuer.issue({ creatorId: "creator-1" }));
    expect((payload as { typ?: unknown }).typ).toBe("creator");
  });

  it("returns null for a correctly-signed token with no exp claim", async () => {
    // hono/jwt only enforces `exp` when the claim is PRESENT. Without this
    // check a signed token that simply omits it verifies forever, and the only
    // way to revoke it is rotating JWT_SECRET — i.e. logging everyone out.
    const issuer = new HonoJwtTokenIssuer(SECRET);
    const noExpiry = await sign({ creatorId: "creator-1", typ: "creator" }, SECRET, "HS256");

    expect(await issuer.verify(noExpiry)).toBeNull();
  });

  it("returns null for a correctly-signed token that is not a creator session", async () => {
    // Phase 3 signs member checkout links and payment-webhook tokens with the
    // SAME JWT_SECRET. Without a type discriminator, any of those carrying a
    // creatorId-shaped claim would be accepted here as a creator session.
    const issuer = new HonoJwtTokenIssuer(SECRET);
    const webhookToken = await sign(
      { creatorId: "creator-1", typ: "payment-webhook", exp: FAR_FUTURE },
      SECRET,
      "HS256"
    );

    expect(await issuer.verify(webhookToken)).toBeNull();
  });

  it("returns null for a correctly-signed token with no typ claim", async () => {
    const issuer = new HonoJwtTokenIssuer(SECRET);
    const untyped = await sign({ creatorId: "creator-1", exp: FAR_FUTURE }, SECRET, "HS256");

    expect(await issuer.verify(untyped)).toBeNull();
  });

  it("returns null when creatorId is missing but the token is otherwise valid", async () => {
    const issuer = new HonoJwtTokenIssuer(SECRET);
    const noSubject = await sign({ typ: "creator", exp: FAR_FUTURE }, SECRET, "HS256");

    expect(await issuer.verify(noSubject)).toBeNull();
  });
});
