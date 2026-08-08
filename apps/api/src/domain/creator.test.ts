import { describe, expect, it } from "bun:test";
import { normalizeEmail } from "./creator";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Budi@Example.COM  ")).toBe("budi@example.com");
  });
});
