import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a webhook callback token in constant time.
 *
 * Xendit authenticates webhooks with a STATIC token header rather than an HMAC
 * of the payload, so this comparison is the only thing standing between an
 * attacker and a forged payment event. A plain `===` leaks the token
 * byte-by-byte under timing analysis.
 *
 * Both sides are SHA-256'd to a fixed 32 bytes first. timingSafeEqual throws
 * on a length mismatch, which would both 500 the request and leak the token's
 * length; hashing removes that failure mode entirely. Do NOT "optimise" this
 * into a length pre-check plus a comparison of the raw bytes — that
 * reintroduces exactly the leak this module exists to prevent, and
 * webhook-token.test.ts pins the mechanism so it fails if you do.
 *
 * `expected` is `string | undefined` on purpose: it comes from configuration
 * (`process.env.XENDIT_CALLBACK_TOKEN`), and an unset or empty configured
 * token must never vouch for anything. An empty `expected` used to match an
 * empty `received`, so a request carrying `X-CALLBACK-TOKEN:` with no value
 * would have been accepted as genuine on a box that had not been configured —
 * full webhook forgery. Both the missing case and the empty case now return
 * false before any comparison happens.
 */
export function verifyCallbackToken(
  received: string | undefined,
  expected: string | undefined
): boolean {
  if (typeof received !== "string") {
    return false;
  }
  if (typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
