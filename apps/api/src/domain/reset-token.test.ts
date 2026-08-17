import { describe, expect, it } from "bun:test";
import { hashResetToken, mintResetToken, RESET_TOKEN_TTL_MS } from "./reset-token";

const HEX_64 = /^[0-9a-f]{64}$/;

describe("mintResetToken", () => {
  it("returns a 64-character hex token", () => {
    const { token } = mintResetToken();
    expect(token).toMatch(HEX_64);
  });

  it("returns a hash matching hashResetToken(token)", () => {
    const { token, tokenHash } = mintResetToken();
    expect(tokenHash).toBe(hashResetToken(token));
  });

  it("returns a 64-character hex hash", () => {
    const { tokenHash } = mintResetToken();
    expect(tokenHash).toMatch(HEX_64);
  });

  it("never mints the same token twice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(mintResetToken().token);
    }
    expect(seen.size).toBe(1000);
  });

  it("two mints never collide on token OR hash", () => {
    const a = mintResetToken();
    const b = mintResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("hashResetToken", () => {
  it("is stable: the same token always hashes to the same value", () => {
    const { token } = mintResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashResetToken("a".repeat(64))).not.toBe(hashResetToken("b".repeat(64)));
  });

  it("never reproduces the plaintext token in the hash", () => {
    const { token, tokenHash } = mintResetToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });
});

describe("RESET_TOKEN_TTL_MS", () => {
  it("is 30 minutes", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });
});
