/**
 * **The document-library limits and refusal codes, in the ONE place both sides
 * read them.**
 *
 * A new module beside `media.schema.ts` rather than more constants inside it:
 * the two pipelines share no limit and no code, and a single file would invite
 * a reader to assume `MAX_UPLOAD_BYTES` governs both.
 *
 * The reason for sharing at all is `media.schema.ts`'s: a limit declared twice
 * can drift, and drifting HIGH is the dangerous direction — an oversized file
 * reaches the API, comes back a 400, and the client's copy confidently calls
 * it an unsupported format.
 *
 * Tests assert the LITERALS, never these names.
 */

/** The biggest document the API will accept, in bytes on the wire. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Matches `community_document.name`'s column width. */
export const MAX_DOCUMENT_NAME_LENGTH = 255;

/**
 * **What the library accepts, and every exclusion is deliberate.**
 *
 * NO `text/html` and NO `image/svg+xml`: we store bytes as they arrive, so a
 * type that a browser executes is stored XSS on the app's own origin with a
 * session in scope. SVG is an image everywhere except in the one way that
 * matters here.
 *
 * NO video and NO audio: Phase 4b's problem, and far past the cap besides.
 *
 * NO archives: a zip's contents are invisible to every check made anywhere in
 * this pipeline, so the allowlist would be vouching for bytes it cannot see.
 *
 * NO `application/octet-stream`: it is what a client sends when it has no
 * idea, which is precisely when we should not be guessing either.
 */
export const ALLOWED_DOCUMENT_TYPES = [
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
] as const;

export type AllowedDocumentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_DOCUMENT_TYPES);

/**
 * Whether a `Content-Type` header names an accepted format.
 *
 * **Parameters are stripped and case is folded before the comparison**, because
 * browsers add them freely — `text/plain; charset=utf-8` is what a `.txt` file
 * actually arrives as, and refusing it would make the commonest text upload
 * fail for a reason nobody could see. Splitting on `;` FIRST is also what stops
 * a parameter smuggling a type past the check.
 *
 * This says nothing about the BYTES — it is a check on a string the client
 * chose. See the spec's "The security decision" for the three measures that
 * make storing an unverified type safe.
 */
export function isAllowedDocumentType(contentType: string): boolean {
  return ALLOWED.has(contentType.split(";")[0]!.trim().toLowerCase());
}

/**
 * Codes on the wire, mirroring `UPLOAD_ERROR_CODE`. The client's Bahasa copy
 * branches on the LABEL rather than on a matched message — an unlabelled
 * refusal gets described with the vaguest sentence available, which is the
 * failure `errorCopy.ts` exists to prevent.
 */
export const DOCUMENT_ERROR_CODE = {
  /** No `file` part in the multipart body. */
  missingFile: "document_missing_file",
  /** Over `MAX_DOCUMENT_BYTES`. */
  tooLarge: "document_too_large",
  /** Not in `ALLOWED_DOCUMENT_TYPES`. */
  unsupportedFormat: "document_unsupported_format",
  /** Nothing usable survived sanitising the filename. */
  invalidName: "document_invalid_name",
} as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODE)[keyof typeof DOCUMENT_ERROR_CODE];
