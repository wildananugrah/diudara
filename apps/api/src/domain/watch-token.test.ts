import { describe, expect, it } from "bun:test";
import { mintWatchToken, verifyWatchToken, WATCH_TOKEN_TTL_MS } from "./watch-token";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = 1_760_000_000_000;
const SUB = "11111111-1111-4111-8111-111111111111";
const EVT = "22222222-2222-4222-8222-222222222222";

function mint(overrides: Partial<Parameters<typeof mintWatchToken>[0]> = {}) {
  return mintWatchToken({
    subscriptionId: SUB,
    eventId: EVT,
    now: NOW,
    ttlMs: WATCH_TOKEN_TTL_MS,
    secret: SECRET,
    ...overrides,
  });
}

describe("watch tokens", () => {
  it("round-trips the ids it was minted with", () => {
    expect(verifyWatchToken({ token: mint(), now: NOW, secret: SECRET })).toEqual({
      subscriptionId: SUB,
      eventId: EVT,
    });
  });

  it("is still valid one millisecond before expiry and invalid at expiry", () => {
    const token = mint();
    expect(verifyWatchToken({ token, now: NOW + WATCH_TOKEN_TTL_MS - 1, secret: SECRET })).not.toBeNull();
    expect(verifyWatchToken({ token, now: NOW + WATCH_TOKEN_TTL_MS, secret: SECRET })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyWatchToken({ token: mint(), now: NOW, secret: OTHER_SECRET })).toBeNull();
  });

  // The attack this exists to stop: swap in someone else's subscription id and
  // keep the signature. Editing the payload must invalidate it.
  it("rejects a token whose payload was edited", () => {
    const token = mint();
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    decoded.subscriptionId = "33333333-3333-4333-8333-333333333333";
    const forged =
      Buffer.from(JSON.stringify(decoded)).toString("base64url") + "." + signature;
    expect(verifyWatchToken({ token: forged, now: NOW, secret: SECRET })).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    // "€.€" has a signature half that is 1 JS character long, rejected by a
    // naive length guard for an unrelated reason — it says nothing about
    // whether that guard compares BYTE length or JS STRING length. The last
    // case below does: a signature exactly 43 JS characters long (matching
    // the real signature's JS length) but containing a multi-byte character,
    // so its UTF-8 byte length (44) differs from its JS string length (43).
    // `Buffer.from` on a string this shape used to reach `timingSafeEqual`
    // with mismatched buffer byte-lengths, which throws `RangeError` straight
    // out of a function whose entire contract is that it never throws.
    const [encoded] = mint().split(".");
    const multiByteSameJsLength = `${encoded}.é${"a".repeat(42)}`;
    for (const token of ["", ".", "not-a-token", "a.b.c", "€.€", multiByteSameJsLength]) {
      expect(verifyWatchToken({ token, now: NOW, secret: SECRET })).toBeNull();
    }
  });

  it("gives two subscriptions different tokens for the same event", () => {
    const other = mint({ subscriptionId: "44444444-4444-4444-8444-444444444444" });
    expect(other).not.toBe(mint());
  });

  it("expires in six hours", () => {
    expect(WATCH_TOKEN_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
