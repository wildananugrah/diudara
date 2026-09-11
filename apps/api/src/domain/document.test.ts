import { describe, expect, test } from "bun:test";
import { DocumentRejectedError, contentDispositionFor, sanitiseDocumentName } from "./document";

/**
 * Tested at the HOSTILE inputs, not the friendly one. `"Rangkuman.pdf"` going
 * through unchanged proves nothing about any of the cases below, each of which
 * is a way this value reaches somewhere it must not.
 */
describe("sanitiseDocumentName", () => {
  test("keeps an ordinary filename exactly", () => {
    expect(sanitiseDocumentName("Rangkuman Trigonometri.pdf")).toBe("Rangkuman Trigonometri.pdf");
  });

  test("keeps a Bahasa name with accents and punctuation", () => {
    expect(sanitiseDocumentName("Ringkasan — Bab 1 (revisi).pdf")).toBe(
      "Ringkasan — Bab 1 (revisi).pdf"
    );
  });

  test("strips every path separator, so the value can never read as a path", () => {
    expect(sanitiseDocumentName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitiseDocumentName("folder/sub/file.pdf")).toBe("foldersubfile.pdf");
    // Backslashes too — a Windows client sends the full local path on some
    // browsers, and a bucket key built from this must not sprout a prefix.
    // The drive COLON survives, deliberately: it is not a separator anywhere
    // this value goes (the bucket key is the id alone), and stripping
    // characters that are merely unusual loses the name the uploader chose.
    expect(sanitiseDocumentName("C:\\Users\\budi\\file.pdf")).toBe("C:Usersbudifile.pdf");
  });

  test("strips the dot-dot sequence even when it survives separator removal", () => {
    expect(sanitiseDocumentName("..pdf")).toBe("pdf");
    expect(sanitiseDocumentName("....pdf")).toBe("pdf");
  });

  /**
   * The one place this value reaches an HTTP header. A newline here is header
   * injection into `Content-Disposition`.
   */
  test("strips control characters and newlines", () => {
    expect(sanitiseDocumentName("file\r\nX-Injected: yes.pdf")).toBe("fileX-Injected: yes.pdf");
    expect(sanitiseDocumentName("tab\there.pdf")).toBe("tabhere.pdf");
    expect(sanitiseDocumentName("null\u0000byte.pdf")).toBe("nullbyte.pdf");
  });

  test("trims, and truncates to the column width", () => {
    expect(sanitiseDocumentName("   spasi.pdf   ")).toBe("spasi.pdf");
    expect(sanitiseDocumentName(`${"a".repeat(300)}.pdf`).length).toBe(255);
  });

  /**
   * Rejected, not defaulted. Inventing `document.pdf` for a nameless file
   * hides whatever produced it.
   */
  test("throws when nothing usable survives", () => {
    for (const hostile of ["", "   ", "../..", "///", "\r\n\t"]) {
      expect(() => sanitiseDocumentName(hostile)).toThrow(DocumentRejectedError);
    }
  });

  test("the refusal carries the wire code, not just a message", () => {
    try {
      sanitiseDocumentName("///");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DocumentRejectedError).code).toBe("document_invalid_name");
    }
  });
});

describe("contentDispositionFor", () => {
  test("is always an attachment, never inline", () => {
    // The measure that makes storing an unverified content type safe: the
    // browser saves rather than renders, so even a correctly-labelled HTML
    // file would not execute.
    expect(contentDispositionFor("Rangkuman.pdf")).toStartWith("attachment; ");
  });

  test("carries the plain filename and the UTF-8 one", () => {
    expect(contentDispositionFor("Rangkuman.pdf")).toBe(
      `attachment; filename="Rangkuman.pdf"; filename*=UTF-8''Rangkuman.pdf`
    );
  });

  /**
   * A Bahasa or accented name must survive rather than being mangled. The
   * ASCII `filename=` is the fallback for old clients; `filename*=` is what a
   * current browser actually uses.
   */
  test("percent-encodes a non-ASCII name in the UTF-8 form", () => {
    const header = contentDispositionFor("Ringkasan — Bab 1.pdf");
    expect(header).toContain("filename*=UTF-8''Ringkasan%20%E2%80%94%20Bab%201.pdf");
  });

  /**
   * The quoted ASCII form is the injection surface: a `"` closes the quoted
   * string early and everything after it is read as new header parameters.
   */
  test("strips a quote from the ASCII form rather than letting it close the string", () => {
    const header = contentDispositionFor('evil".pdf');
    expect(header).toContain('filename="evil.pdf"');
  });
});
