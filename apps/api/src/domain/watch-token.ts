/**
 * Signed, time-limited tokens that gate access to a live stream's watch URL.
 *
 * A token proves WHO a request is for (which subscription, which event). It
 * does NOT prove they are STILL ENTITLED — the caller must re-check the
 * subscription on every read this token authorizes. Phase 5 shipped exactly
 * this defect once already: the one consumer that skipped an entitlement
 * re-check was the one that broke. Do not let this module's signature make
 * that check look unnecessary.
 *
 * Signed with `STREAM_TOKEN_SECRET`, never `JWT_SECRET` — different
 * audience, different lifetime (six hours vs. the session token's), and a
 * compromise of one secret must not compromise the other. This module never
 * reads either from the environment; the secret is always a parameter.
 *
 * Pure module: no imports from `application/` or `infrastructure/`, no
 * database, no clock — `now` is a parameter, never `Date.now()`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Six hours: longer than any realistic session plus overrun, short enough
 * that a leaked watch URL is not a permanent key into the stream.
 */
export const WATCH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

interface WatchTokenPayload {
  subscriptionId: string;
  eventId: string;
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mints a token binding `subscriptionId` to `eventId`, expiring at
 * `now + ttlMs`. Two calls for two different subscriptions (or two different
 * `now`s) never produce the same token, because `exp` and the id are both
 * part of the signed payload.
 */
export function mintWatchToken(input: {
  subscriptionId: string;
  eventId: string;
  now: number;
  ttlMs: number;
  secret: string;
}): string {
  const payload: WatchTokenPayload = {
    subscriptionId: input.subscriptionId,
    eventId: input.eventId,
    exp: input.now + input.ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, input.secret)}`;
}

/**
 * Returns the ids the token was minted with, or `null`. NEVER throws, and
 * never distinguishes between a bad signature, an expired token, and a
 * malformed one — the caller answers all of these with one 403, so telling
 * them apart here would only create a chance to leak the difference later
 * (e.g. "expired" vs "forged" timing or response shape).
 *
 * This token proves WHO the request is for. It does NOT prove they are
 * still entitled: the caller must re-check the subscription before serving
 * any stream data. See this file's header for why that check cannot be
 * skipped.
 */
export function verifyWatchToken(input: {
  token: string;
  now: number;
  secret: string;
}): { subscriptionId: string; eventId: string } | null {
  const parts = input.token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = sign(encoded, input.secret);
  // Both are base64url of a 32-byte HMAC digest, so lengths match unless the
  // input is junk — in which case this guard rejects it before
  // timingSafeEqual, which throws on mismatched-length buffers.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: WatchTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof payload?.subscriptionId !== "string") return null;
  if (typeof payload?.eventId !== "string") return null;
  if (typeof payload?.exp !== "number") return null;
  if (input.now >= payload.exp) return null;

  return { subscriptionId: payload.subscriptionId, eventId: payload.eventId };
}
