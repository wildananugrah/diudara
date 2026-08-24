import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a webhook callback token in constant time.
 *
 * PROVIDER-NEUTRAL, and it lives here rather than under `payments/` for that
 * reason: FOUR inbound entry points depend on it, across two providers, and all
 * of them authenticate the same way — with a STATIC secret the caller presents,
 * rather than an HMAC over the payload.
 *
 *   `X-CALLBACK-TOKEN` header    — Xendit          POST /webhooks/xendit
 *   `secret` query parameter,    — MediaMTX        POST /webhooks/mediamtx/auth
 *   or `X-Mediamtx-Secret`                         GET  /webhooks/mediamtx/auth-request
 *   header (either is accepted)                    POST /webhooks/mediamtx/lifecycle
 *
 * Retire-telegram Task 2 deleted the third provider this list used to name,
 * `X-Telegram-Bot-Api-Secret-Token` (Telegram's `setWebhook` secret_token), with
 * the bot adapter and the route that read it. Task 7 corrected the sentence
 * below and left the table above it saying "two"; the whole-branch review
 * (MIN-3) caught that, and the count is now derived from the four
 * `verifyCallbackToken(` call sites in `routes/`.
 *
 * A static secret authenticates the SENDER, not the message, so this comparison
 * is the only thing standing between an attacker and a forged event — a forged
 * payment for Xendit, and for MediaMTX a forged authorisation that would let a
 * stranger publish to or read from a paid stream. A plain `===` leaks the token
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
 * (`process.env.XENDIT_CALLBACK_TOKEN`, `process.env.MEDIAMTX_WEBHOOK_SECRET`),
 * and an unset or empty configured token must never vouch for anything. An empty `expected` used to match an
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
