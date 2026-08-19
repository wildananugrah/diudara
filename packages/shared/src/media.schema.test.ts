import { describe, expect, it } from "bun:test";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS, UPLOAD_ERROR_CODE } from "./media.schema";

describe("MAX_UPLOAD_BYTES", () => {
  it("is 10 MB", () => {
    // The LITERAL, never the constant — a test that asserts the constant
    // against itself passes whatever the constant becomes.
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("MAX_UPLOAD_PIXELS", () => {
  it("is 40 megapixels", () => {
    expect(MAX_UPLOAD_PIXELS).toBe(40_000_000);
  });
});

describe("UPLOAD_ERROR_CODE", () => {
  it("carries the four refusals POST /users/media can answer with", () => {
    expect(UPLOAD_ERROR_CODE).toEqual({
      missingFile: "media_missing_file",
      tooLarge: "media_too_large",
      tooManyPixels: "media_too_many_pixels",
      unsupportedFormat: "media_unsupported_format",
    });
  });
});
