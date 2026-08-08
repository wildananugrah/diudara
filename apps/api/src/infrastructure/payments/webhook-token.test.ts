import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  // An empty `expected` used to MATCH an empty `received` and return true.
  // Task 7 wires this to `process.env.XENDIT_CALLBACK_TOKEN ?? ""`, so on a box
  // where that variable is unset, a request carrying a bare `X-CALLBACK-TOKEN:`
  // header would have been accepted as a genuine Xendit payment event.
  it("refuses to vouch for an empty configured token", () => {
    expect(verifyCallbackToken("", "")).toBe(false);
  });

  it("refuses to vouch for an empty configured token against any header", () => {
    expect(verifyCallbackToken(TOKEN, "")).toBe(false);
    expect(verifyCallbackToken("anything", "")).toBe(false);
  });

  // Previously a TypeError out of createHash, which would 500 the webhook route
  // instead of rejecting it. An unset configured token is a rejection, not a
  // crash — same reasoning as the empty case above.
  it("returns false rather than throwing when no token is configured", () => {
    expect(verifyCallbackToken(TOKEN, undefined)).toBe(false);
    expect(verifyCallbackToken(undefined, undefined)).toBe(false);
  });
});

/**
 * Pins the MECHANISM, not just the behaviour.
 *
 * Two mutations of this module survived the whole suite, because a correct
 * result and a timing-leaking result are behaviourally identical:
 *
 *   M4  `return received === expected;`                       — no constant-time
 *       comparison at all.
 *   M5  a `received.length !== expected.length` pre-check plus timingSafeEqual
 *       over the RAW bytes — looks like a performance improvement, leaks the
 *       token's length and then compares unequal-length secrets.
 *
 * Timing is not reliably measurable in CI, so this reads the source instead and
 * asserts the three properties that make the comparison constant-time: both
 * sides are hashed to a fixed width, the digests (not the raw strings) are what
 * reach timingSafeEqual, and the two inputs are never compared with === / !==.
 */
describe("verifyCallbackToken constant-time mechanism", () => {
  const source = readFileSync(join(import.meta.dir, "webhook-token.ts"), "utf8");

  it("imports timingSafeEqual from node:crypto", () => {
    expect(source).toMatch(/import\s*\{[^}]*timingSafeEqual[^}]*\}\s*from\s*"node:crypto"/);
  });

  it("passes SHA-256 digests, not raw strings, to timingSafeEqual", () => {
    const call = source.match(/timingSafeEqual\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
    expect(call).not.toBeNull();

    for (const name of [call![1], call![2]]) {
      const digest = new RegExp(
        `(?:const|let)\\s+${name}\\s*=\\s*createHash\\("sha256"\\)[\\s\\S]{0,200}?\\.digest\\(\\)`
      );
      expect(source).toMatch(digest);
    }
    // Two distinct digests, i.e. both sides were hashed.
    expect(call![1]).not.toBe(call![2]);
  });

  it("never compares the two inputs with === or !==", () => {
    // Catches both `received === expected` and `received.length !== expected.length`,
    // in either argument order.
    expect(source).not.toMatch(/\breceived\b[\w.$]*\s*[=!]==\s*expected\b/);
    expect(source).not.toMatch(/\bexpected\b[\w.$]*\s*[=!]==\s*received\b/);
  });
});
