import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "./watch-token";
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
   * THE TWO WORLDS SHARE ONE SECRET (`STREAM_TOKEN_SECRET`) and one encoding,
   * so nothing about the wire format keeps a community `watch-token.ts` token
   * out of this verifier — only what the two modules sign does. A community
   * token opening a user stream would be a paywall bypass for anybody holding
   * ANY subscription anywhere, so it is pinned in both directions rather than
   * left to the accident that the payload field names differ.
   */
  it("refuses a COMMUNITY watch token minted with the very same secret", () => {
    const communityToken = mintWatchToken({
      subscriptionId: VIEWER,
      eventId: STREAM,
      now: NOW,
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });

    expect(verifyUserWatchToken({ token: communityToken, now: NOW, secret: SECRET })).toBeNull();
  });

  /**
   * ...AND THE SEPARATOR ITSELF, which the test above does NOT reach. Measured,
   * not assumed: deleting the domain separator from `sign` leaves that test
   * green, because a community token's payload carries no `viewerId` and the
   * `typeof` checks turn it away regardless. The separator's whole job is to
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
