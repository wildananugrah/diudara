import { describe, expect, test } from "bun:test";
import { formatBytes } from "./formatBytes";

/**
 * Asserted at the UNIT BOUNDARIES, which is the only place a rounding or
 * threshold error is visible. A test on 2.4 MB passes under an off-by-one in
 * the divisor and under a `>=` that should be `>`.
 */
describe("formatBytes", () => {
  test("an empty file is bytes, not 0,0 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  test("stays in bytes right up to the kilobyte", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("crosses into KB at exactly 1024", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1,5 KB");
  });

  test("crosses into MB at exactly 1024 KB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
  });

  /** The decimal separator is a COMMA — Indonesian, matching api.ts's money formatting. */
  test("uses a comma for the decimal, never a dot", () => {
    expect(formatBytes(2_516_582)).toBe("2,4 MB");
    expect(formatBytes(1024 * 1024 * 3.1)).toBe("3,1 MB");
  });

  test("drops a trailing zero rather than showing 2,0 MB", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
  });

  test("the upload cap reads as a round number", () => {
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });

  test("a negative or non-finite size is 0 B rather than NaN on screen", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
