import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  mintUserWatchToken,
  USER_WATCH_TOKEN_TTL_MS,
  verifyUserWatchToken,
} from "./user-watch-token";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = 1_760_000_000_000;
const VIEWER = "11111111-1111-4111-8111-111111111111";
const STREAM = "22222222-2222-4222-8222-222222222222";

function mint(overrides: Partial<Parameters<typeof mintUserWatchToken>[0]> = {}) {
  return mintUserWatchToken({
    viewerId: VIEWER,
    streamId: STREAM,
    now: NOW,
    ttlMs: USER_WATCH_TOKEN_TTL_MS,
    secret: SECRET,
    ...overrides,
  });
}

describe("user watch tokens", () => {
  it("round-trips the ids it was minted with", () => {
    expect(verifyUserWatchToken({ token: mint(), now: NOW, secret: SECRET })).toEqual({
      viewerId: VIEWER,
      streamId: STREAM,
    });
  });

  it("is still valid one millisecond before expiry and invalid at expiry", () => {
    const token = mint();
    expect(
      verifyUserWatchToken({ token, now: NOW + USER_WATCH_TOKEN_TTL_MS - 1, secret: SECRET })
    ).not.toBeNull();
    expect(
      verifyUserWatchToken({ token, now: NOW + USER_WATCH_TOKEN_TTL_MS, secret: SECRET })
    ).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyUserWatchToken({ token: mint(), now: NOW, secret: OTHER_SECRET })).toBeNull();
  });

  // The attack this exists to stop: swap in somebody else's stream id (or
  // viewer id) and keep the signature. Editing the payload must invalidate it.
  it("rejects a token whose payload was edited", () => {
    const token = mint();
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    decoded.streamId = "33333333-3333-4333-8333-333333333333";
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url") + "." + signature;

    expect(verifyUserWatchToken({ token: forged, now: NOW, secret: SECRET })).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    // The multi-byte case is inherited verbatim from `watch-token.test.ts`: a
    // signature exactly 43 JS characters long (the real signature's length)
    // but 44 UTF-8 BYTES, which used to reach `timingSafeEqual` with
    // differently-sized buffers and throw `RangeError` out of a function whose
    // whole contract is that it never throws. This module signs with the same
    // primitive, so it inherits the same hazard and the same guard.
    const [encoded] = mint().split(".");
    const multiByteSameJsLength = `${encoded}.é${"a".repeat(42)}`;
    for (const token of ["", ".", "not-a-token", "a.b.c", "€.€", multiByteSameJsLength]) {
      expect(verifyUserWatchToken({ token, now: NOW, secret: SECRET })).toBeNull();
    }
  });

  it("gives two viewers different tokens for the same stream", () => {
    const other = mint({ viewerId: "44444444-4444-4444-8444-444444444444" });
    expect(other).not.toBe(mint());
  });

  it("expires in ten minutes", () => {
    expect(USER_WATCH_TOKEN_TTL_MS).toBe(600_000);
  });

  /**
   * A COMMUNITY watch token, minted with the very same `STREAM_TOKEN_SECRET`
   * and the very same encoding, must not open a user stream. That would be a
   * paywall bypass available to anybody holding ANY subscription anywhere, so
   * the refusal is pinned outright.
   *
   * PHASE 8, TASK 6 — REPAIRED, NOT DELETED. This case used to call
   * `mintWatchToken` from `./watch-token`, and retiring Telegram deleted that
   * module. The property did not die with it: `STREAM_TOKEN_SECRET` is still
   * the one secret, the wire format is still `<base64url payload>.<HMAC>`, and
   * a token of the retired shape is still something a leaked secret or an old
   * deploy can produce. So the community token is BUILT HERE instead, by
   * writing out the deleted module's formula — a bare-payload HMAC over a
   * `{ subscriptionId, eventId, exp }` payload, no domain separator, six-hour
   * expiry. That duplication IS the assertion, exactly as it is in the
   * separator case at the bottom of this file: if this verifier ever accepts
   * what the formula produces, the two worlds' tokens are interchangeable
   * again.
   *
   * WHAT ACTUALLY REFUSES IT, measured rather than assumed (fix round 1,
   * MIN-2 of the Phase 7 branch): the `typeof payload?.viewerId !== "string"`
   * shape check, NOT the domain separator. A community payload carries
   * `subscriptionId`/`eventId` and no `viewerId`, so this test stays green
   * with the separator deleted. That is worth knowing and the property is
   * worth pinning — it is the outcome a member cares about — but the separator
   * has its own test at the bottom of this file, and it is the only one that
   * reaches it.
   */
  it("refuses a COMMUNITY watch token minted with the very same secret", () => {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const encoded = Buffer.from(
      JSON.stringify({ subscriptionId: VIEWER, eventId: STREAM, exp: NOW + SIX_HOURS_MS })
    ).toString("base64url");
    const communityToken = `${encoded}.${createHmac("sha256", SECRET).update(encoded).digest("base64url")}`;

    expect(verifyUserWatchToken({ token: communityToken, now: NOW, secret: SECRET })).toBeNull();
  });

  /**
   * FIX ROUND 1, MIN-3 — the `viewerId` shape check, pinned at last.
   *
   * Deleting `if (typeof payload?.viewerId !== "string") return null` used to
   * kill NOTHING: no consumer ever reads `viewerId` back
   * (`authoriseUserStreamRead` uses only `streamId`), so nothing downstream
   * could notice a token that names nobody. An unused validation that LOOKS
   * load-bearing is worse than either keeping or dropping it honestly, so it
   * gets a test that fails when it goes.
   *
   * The payload here is signed CORRECTLY — the domain separator written out
   * as a literal, the way the bare-HMAC case below writes out the other
   * module's formula — so the signature, the expiry and `streamId` all pass.
   * The only thing left to refuse it is the field this test is named for.
   *
   * What it buys: `viewerId` is an AUDIT property, not an access-control one.
   * It cannot decide who gets bytes (a forwarded token works for whoever
   * holds it — design spec §5's stated bargain), but a token that names
   * nobody at all cannot be reasoned about after the fact, which is the exact
   * failing this module exists to fix in the six-hour token it replaces.
   */
  it("refuses a correctly-signed token that names no viewer", () => {
    const encoded = Buffer.from(
      JSON.stringify({ streamId: STREAM, exp: NOW + 600_000 })
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET)
      .update(`diudara.user-watch.v1.${encoded}`)
      .digest("base64url");

    expect(
      verifyUserWatchToken({ token: `${encoded}.${signature}`, now: NOW, secret: SECRET })
    ).toBeNull();
  });

  /**
   * ...AND THE SEPARATOR ITSELF, which the COMMUNITY-token case above does
   * NOT reach. Measured, not assumed: deleting the domain separator from
   * `sign` leaves that test green, because a community token's payload carries
   * no `viewerId` and the `typeof` checks turn it away regardless. The separator's whole job is to
   * make the refusal structural rather than incidental — one careless edit to
   * those shape checks away — so it needs a case that fails on the SIGNATURE.
   *
   * This builds one: a payload of exactly the shape this module accepts,
   * signed with the bare-payload HMAC `watch-token.ts` uses (its `sign` is not
   * exported, so the formula is written out here — that duplication IS the
   * assertion). If this verifier ever accepts it, the two worlds share a
   * signing domain again and a forger who can get one kind of token minted can
   * present it as the other.
   */
  it("refuses a well-shaped payload signed WITHOUT the domain separator", () => {
    const encoded = Buffer.from(
      JSON.stringify({ viewerId: VIEWER, streamId: STREAM, exp: NOW + 600_000 })
    ).toString("base64url");
    const bareSignature = createHmac("sha256", SECRET).update(encoded).digest("base64url");

    expect(
      verifyUserWatchToken({ token: `${encoded}.${bareSignature}`, now: NOW, secret: SECRET })
    ).toBeNull();
  });
});
