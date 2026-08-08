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
 * length; hashing removes that failure mode entirely.
 */
export function verifyCallbackToken(
  received: string | undefined,
  expected: string
): boolean {
  if (typeof received !== "string") {
    return false;
  }
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
