import { describe, expect, it } from "bun:test";
import { verifyCallbackToken } from "./webhook-token";

const TOKEN = "xnd_webhook_token_abc123";

describe("verifyCallbackToken", () => {
  it("accepts the exact token", () => {
    expect(verifyCallbackToken(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(verifyCallbackToken("xnd_webhook_token_xyz999", TOKEN)).toBe(false);
  });

  // timingSafeEqual throws on length mismatch. Hashing both sides first means
  // these return false instead of 500-ing, and no length is leaked.
  it("rejects a much shorter token without throwing", () => {
    expect(verifyCallbackToken("x", TOKEN)).toBe(false);
  });

  it("rejects a much longer token without throwing", () => {
    expect(verifyCallbackToken(TOKEN + "padding".repeat(50), TOKEN)).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(verifyCallbackToken("", TOKEN)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyCallbackToken(undefined, TOKEN)).toBe(false);
  });
});
