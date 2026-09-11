import { describe, expect, test } from "bun:test";
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENT_ERROR_CODE,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_NAME_LENGTH,
  isAllowedDocumentType,
} from "./document.schema";

describe("the document allowlist", () => {
  test("accepts the office, text and image types the library takes", () => {
    for (const type of [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]) {
      expect(isAllowedDocumentType(type)).toBe(true);
    }
  });

  /**
   * The exclusions are the point of the list, so they are asserted by name
   * rather than left to "anything not above". Each one is here for its own
   * reason and removing any of them should turn this red.
   */
  test("refuses the types the security decision excludes", () => {
    // Stored XSS on the app's own origin, with a session in scope.
    expect(isAllowedDocumentType("text/html")).toBe(false);
    // An image everywhere except in the one way that matters: SVG executes script.
    expect(isAllowedDocumentType("image/svg+xml")).toBe(false);
    // Phase 4b's problem, and far past the cap besides.
    expect(isAllowedDocumentType("video/mp4")).toBe(false);
    expect(isAllowedDocumentType("audio/mpeg")).toBe(false);
    // An archive's contents are invisible to every check we make — the
    // allowlist would be vouching for bytes it cannot see.
    expect(isAllowedDocumentType("application/zip")).toBe(false);
    // The catch-all a client sends when it has no idea.
    expect(isAllowedDocumentType("application/octet-stream")).toBe(false);
  });

  test("ignores parameters and case, which browsers add freely", () => {
    expect(isAllowedDocumentType("text/plain; charset=utf-8")).toBe(true);
    expect(isAllowedDocumentType("APPLICATION/PDF")).toBe(true);
    expect(isAllowedDocumentType("  application/pdf  ")).toBe(true);
    // A parameter must not smuggle a type past the check.
    expect(isAllowedDocumentType("text/html; charset=utf-8")).toBe(false);
  });

  test("the empty and the absent are refused, not defaulted", () => {
    expect(isAllowedDocumentType("")).toBe(false);
    expect(isAllowedDocumentType("   ")).toBe(false);
  });
});

describe("the shared limits", () => {
  /** Asserted as LITERALS, never as the names — the rule media.schema.ts records. */
  test("are the numbers both sides agreed on", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(26_214_400);
    expect(MAX_DOCUMENT_NAME_LENGTH).toBe(255);
  });

  test("the error codes are the labels the client's copy branches on", () => {
    expect(DOCUMENT_ERROR_CODE).toEqual({
      missingFile: "document_missing_file",
      tooLarge: "document_too_large",
      unsupportedFormat: "document_unsupported_format",
      invalidName: "document_invalid_name",
    });
  });

  test("ALLOWED_DOCUMENT_TYPES is exposed for the client's accept attribute", () => {
    expect(ALLOWED_DOCUMENT_TYPES).toContain("application/pdf");
    expect(ALLOWED_DOCUMENT_TYPES).not.toContain("text/html");
  });
});
