import { describe, expect, it } from "bun:test";
import { HonoJwtTokenIssuer } from "./hono-jwt.token-issuer";

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
});
