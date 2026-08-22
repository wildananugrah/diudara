/**
 * Signed, time-limited tokens that gate a read of ONE PERSON'S live stream —
 * Phase 7's `user_stream`, design spec §5.
 *
 * A SEPARATE MODULE FROM `watch-token.ts`, DELIBERATELY, and this is the one
 * decision here worth defending. `watch-token.ts` serves the community
 * `event` world, which Phase 8 deletes; widening it to also carry a
 * `viewerId`/`streamId` pair would couple a thing being removed to a thing
 * being built, and the removal would then have to disentangle them under time
 * pressure. So the two live side by side until the old one goes, and the
 * short duplication below (an HMAC, a base64url payload, a constant-time
 * compare) is the price of that separation — the same trade `ResolveWatchToken`
 * already documents for `ENTITLED_STATUS`.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. It names WHO the request is for
 * (`viewerId`) and WHICH stream it opens (`streamId`), at MINT time.
 *
 * THOSE TWO FIELDS ARE NOT THE SAME KIND OF THING, and the difference is
 * worth stating because the symmetry of the payload hides it. `streamId` is
 * ACCESS CONTROL: `AuthoriseStream.authoriseUserStreamRead` compares it
 * against the row being requested, and a mismatch refuses. `viewerId` is
 * AUDIT ONLY — nothing anywhere reads it back, and by design cannot: a
 * forwarded token works for whoever holds it (design spec §5's stated
 * bargain, chosen deliberately), so a runtime check against the requester
 * would be a promise this feature does not make. What it buys is that a token
 * can be reasoned about AFTER the fact, which is precisely what the six-hour
 * token it replaces could not do — that one named a subscription and no
 * person. `verifyUserWatchToken` still refuses a token missing the field, and
 * `user-watch-token.test.ts > refuses a correctly-signed token that names no
 * viewer` is what keeps that check from rotting into decoration.
 *
 * It does NOT prove the viewer is still a paying member: the entitlement check lives
 * at the MINT endpoint (`POST /streams/:id/watch-token` → `MintUserWatchToken`
 * → `IsMemberOf`), and the ten-minute lifetime below is what bounds how long
 * a membership that lapsed mid-broadcast keeps working. Spec §5 states that
 * bargain explicitly and chooses it: a forwarded token works until it
 * expires, but it can never be RENEWED, because re-minting needs the member's
 * own session. Do not add a live entitlement re-check here — this module is
 * pure, and the check belongs where the viewer's session is.
 *
 * TEN MINUTES, NOT SIX HOURS. `WATCH_TOKEN_TTL_MS` is six hours, which is
 * long enough for a forwarded link to serve a group chat for an evening; and
 * that token names a subscription rather than a person, so it cannot be
 * reasoned about after the fact. Both are fixed here.
 *
 * Signed with `STREAM_TOKEN_SECRET`, never `JWT_SECRET` — different audience,
 * different lifetime, and a compromise of one must not compromise the other.
 * This module never reads either from the environment; the secret is always a
 * parameter.
 *
 * Pure module: no imports from `application/` or `infrastructure/`, no
 * database, no clock — `now` is a parameter, never `Date.now()`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Ten minutes. Short enough that a forwarded token is a nuisance rather than
 * a season pass, long enough that the player's silent re-mint is not a
 * per-segment round trip. Spec §5.
 */
export const USER_WATCH_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Mixed into every signature, so a token of one KIND can never verify as the
 * other even though both worlds sign with the same `STREAM_TOKEN_SECRET` and
 * use the same encoding.
 *
 * Without it the separation would rest on nothing but the two payloads
 * happening to use different field names — a community token would carry a
 * genuinely valid signature into `verifyUserWatchToken` and be turned away
 * only by the `typeof` checks at the very bottom of this file. That is one
 * careless `?? ""` away from a paywall bypass available to anybody holding a
 * subscription to any community at all, so the refusal is made structural
 * instead. `user-watch-token.test.ts` pins it in that direction.
 */
const DOMAIN = "diudara.user-watch.v1";

interface UserWatchTokenPayload {
  viewerId: string;
  streamId: string;
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${DOMAIN}.${payload}`).digest("base64url");
}

/**
 * Mints a token binding `viewerId` to `streamId`, expiring at `now + ttlMs`.
 * `ttlMs` is a parameter rather than `USER_WATCH_TOKEN_TTL_MS` read inline,
 * for the reason every time-sensitive thing in this codebase follows: the
 * boundary is what the tests need to drive.
 */
export function mintUserWatchToken(input: {
  viewerId: string;
  streamId: string;
  now: number;
  ttlMs: number;
  secret: string;
}): string {
  const payload: UserWatchTokenPayload = {
    viewerId: input.viewerId,
    streamId: input.streamId,
    exp: input.now + input.ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, input.secret)}`;
}

/**
 * Returns the ids the token was minted with, or `null`. NEVER throws, and
 * never distinguishes a bad signature from an expired token from a malformed
 * one — every caller answers all of these with the same refusal, so telling
 * them apart here would only create a chance to leak the difference later.
 *
 * The caller MUST still compare the returned `streamId` against the stream it
 * is about to serve. A signature says which stream a token NAMES; it cannot
 * say which stream is being REQUESTED. `AuthoriseStream` does that comparison
 * in exactly one place — see `authoriseUserStreamRead`.
 */
export function verifyUserWatchToken(input: {
  token: string;
  now: number;
  secret: string;
}): { viewerId: string; streamId: string } | null {
  const parts = input.token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = sign(encoded, input.secret);
  // Compare BYTE length, not JS string length — inherited verbatim from
  // `watch-token.ts`, which shipped the fix after a crafted signature with one
  // multi-byte character (43 JS characters, 44 bytes) reached `timingSafeEqual`
  // with mismatched buffer sizes and threw `RangeError` straight out of a
  // function contracted never to throw. Same primitive, same hazard, same
  // guard; `user-watch-token.test.ts` carries the same case.
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (signatureBytes.length !== expectedBytes.length) return null;
  // Backstop, not the primary defence — see `watch-token.ts` for why a
  // "never throws" contract does not get to depend on this file having
  // enumerated every way `timingSafeEqual` can reject its inputs.
  let signaturesMatch: boolean;
  try {
    signaturesMatch = timingSafeEqual(signatureBytes, expectedBytes);
  } catch {
    return null;
  }
  if (!signaturesMatch) return null;

  let payload: UserWatchTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
  // AUDIT, not access control — nothing downstream reads `viewerId` back (see
  // this file's header). The check earns its place anyway: a token that names
  // nobody is not a token this module ever minted, and accepting one would
  // silently retire the only property that makes a leak investigable. Pinned
  // by "refuses a correctly-signed token that names no viewer".
  if (typeof payload?.viewerId !== "string") return null;
  if (typeof payload?.streamId !== "string") return null;
  if (typeof payload?.exp !== "number") return null;
  if (input.now >= payload.exp) return null;

  return { viewerId: payload.viewerId, streamId: payload.streamId };
}
