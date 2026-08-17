import { describe, expect, it } from "bun:test";
import { isValidHandle, normalizeHandle } from "./handle";

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
