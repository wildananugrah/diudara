import { describe, expect, it } from "bun:test";
import { isReservedHandle, isValidHandle, normalizeHandle } from "./handle";

describe("normalizeHandle", () => {
  it("trims, strips one leading @, and lowercases", () => {
    expect(normalizeHandle("  @Wildan_99  ")).toBe("wildan_99");
  });

  it("lowercases a handle with no leading @", () => {
    expect(normalizeHandle("Wildan")).toBe("wildan");
  });

  it("only strips a single leading @, not one buried in the handle", () => {
    expect(normalizeHandle("@wil@dan")).toBe("wil@dan");
  });

  it("strips only ONE leading @ from a doubled @@, leaving the second", () => {
    expect(normalizeHandle("@@wildan")).toBe("@wildan");
  });

  it("normalises a bare @ to the empty string", () => {
    expect(normalizeHandle("@")).toBe("");
  });

  it("normalises a bare @ surrounded by whitespace to the empty string", () => {
    expect(normalizeHandle("  @  ")).toBe("");
  });

  it("a leading @ plus a 31-character handle normalises to 31 characters (still too long)", () => {
    const withoutAt = "a".repeat(31);
    const normalised = normalizeHandle(`@${withoutAt}`);
    expect(normalised).toBe(withoutAt);
    expect(normalised).toHaveLength(31);
    expect(isValidHandle(normalised)).toBe(false);
  });
});

describe("isValidHandle", () => {
  it("accepts lowercase letters, digits and underscore, 3-30 chars", () => {
    expect(isValidHandle("wil_dan_99")).toBe(true);
    expect(isValidHandle("abc")).toBe(true);
  });

  it("rejects a handle shorter than 3 characters", () => {
    expect(isValidHandle("ab")).toBe(false);
  });

  it("rejects a handle longer than 30 characters", () => {
    expect(isValidHandle("a".repeat(31))).toBe(false);
  });

  it("rejects a handle with a disallowed character", () => {
    expect(isValidHandle("wildan!")).toBe(false);
  });

  it("rejects a handle that is not already normalised (has uppercase)", () => {
    expect(isValidHandle("Wildan")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidHandle("")).toBe(false);
  });
});

/**
 * **Why any handle is reserved at all.** `/users` mounts `userRoutes` and then
 * `postRoutes`, and both declare literal segments — `/users/signup`,
 * `/users/feed` — alongside the parameterised `/users/:handle/follow` and
 * `/users/:handle/posts`. Nothing stopped somebody registering the handle
 * `posts`: their profile would then be permanently unreachable and they could
 * be followed but never unfollowed. Task 2's review found the mount-order half
 * of that (`C1`) and fixed it; this is the other half, and it was parked
 * because it looked like it needed a migration for existing accounts.
 *
 * It does not. `app_user` holds no rows and no personal-account code is
 * deployed, so there is nothing to grandfather — which makes now the cheapest
 * this decision will ever be. The route-derived guard in `routes/users.test.ts`
 * is what keeps the list honest as routes are added.
 */
describe("isReservedHandle", () => {
  it("reserves each of the five handles that shadow a real /users route", () => {
    expect(isReservedHandle("posts")).toBe(true);
    expect(isReservedHandle("feed")).toBe(true);
    expect(isReservedHandle("signup")).toBe(true);
    expect(isReservedHandle("login")).toBe(true);
    expect(isReservedHandle("explore")).toBe(true);
  });

  it("does not reserve an ordinary handle", () => {
    expect(isReservedHandle("wildan")).toBe(false);
    expect(isReservedHandle("budi_99")).toBe(false);
  });

  /**
   * A handle CONTAINING a reserved word is fine — only the whole segment can
   * shadow a route. Reserving by prefix would cost `postscript` for nothing.
   */
  it("does not reserve a handle that merely contains a reserved word", () => {
    expect(isReservedHandle("postscript")).toBe(false);
    expect(isReservedHandle("myfeed")).toBe(false);
    expect(isReservedHandle("feeds")).toBe(false);
  });

  /**
   * The route segments `me`, `by-handle` and `password-reset` are NOT in the
   * list, and must not be: `me` is 2 characters and the other two contain
   * hyphens, so `^[a-z0-9_]{3,30}$` already makes all three unregisterable.
   * Reserving them would imply a hazard that does not exist and would invite
   * the next reader to widen the pattern to match.
   */
  it("leaves the segments the handle pattern already makes impossible out of the list", () => {
    expect(isValidHandle("me")).toBe(false);
    expect(isValidHandle("by-handle")).toBe(false);
    expect(isValidHandle("password-reset")).toBe(false);
    expect(isReservedHandle("me")).toBe(false);
    expect(isReservedHandle("by-handle")).toBe(false);
    expect(isReservedHandle("password-reset")).toBe(false);
  });

  /**
   * It answers about a NORMALISED handle, like `isValidHandle` beside it — the
   * caller normalises first. `@Posts` is the reserved `posts` and a check
   * running before `normalizeHandle` would wave it straight through.
   */
  it("answers on the normalised form, so @Posts is the reserved posts", () => {
    expect(isReservedHandle(normalizeHandle("@Posts"))).toBe(true);
    expect(isReservedHandle(normalizeHandle("  FEED  "))).toBe(true);
  });
});
