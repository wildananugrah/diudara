/**
 * **The photo-upload limits and the refusal codes, in the ONE place both sides
 * read them.**
 *
 * Same precedent as `MAX_POST_BODY_LENGTH` in `auth.schema.ts`, and the final
 * whole-branch review is what forced the move: `MAX_UPLOAD_BYTES` was declared
 * twice — `apps/api/src/domain/image.ts` and `apps/web/src/user/apiClient.ts` —
 * on the argument that the two could only drift in a safe direction. Drifting
 * LOW is safe (a file refused locally that the server would have taken, in
 * Bahasa, naming the limit). Drifting HIGH is NOT: an oversized file then
 * reaches the API, comes back a 400, and the copy the client picks would have
 * confidently called it an unsupported format. One definition removes the
 * question.
 *
 * Tests on every side assert the LITERALS, never these names — see
 * `MAX_EXPLORE_QUERY_LENGTH` for why.
 */

/** The biggest photo the API will accept, in bytes on the wire. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * **The biggest photo the API will DECODE, in pixels — the bound that the byte
 * cap above cannot express.**
 *
 * Final whole-branch review, Important 1, measured rather than reasoned about:
 * a solid-colour 12000×12000 PNG is 446 KB on the wire — two orders of
 * magnitude under `MAX_UPLOAD_BYTES` — and made the API allocate **1.41 GB**
 * decoding it (an 8000² one, 197 KB, took 754 MB). sharp's own default ceiling
 * is 268 megapixels, which at the measured ~9.8 MB of RSS per megapixel permits
 * roughly 2.6 GB per request. Signup is open, the API is a single process, and
 * the file costs nothing to upload — so this is an OOM kill on demand, not a
 * theoretical one.
 *
 * 40 MP is the number because it is comfortably above every real camera whose
 * output this route accepts (a 12 MP phone photo is 0.3× this; a 48 MP sensor's
 * full-resolution JPEG is 0.8×) and because the refusal happens at the header
 * read, before a single pixel is decoded, so the peak allocation for a refused
 * file is the file itself.
 */
export const MAX_UPLOAD_PIXELS = 40_000_000;

/**
 * **The machine-readable reason `POST /users/media` refused an upload — sent on
 * the wire as `code` beside `error`, and the thing the client BRANCHES on.**
 *
 * Deferred through Task 8 and made load-bearing by the final whole-branch
 * review. The client's upload copy used to infer: "any 400 from this route is
 * an unsupported format", which held only while there were exactly three 400s
 * and two of them were unreachable. The pixel bound above is a fourth, and a
 * proxy's 413 is a fifth failure mode — so the inference now produces
 * confidently WRONG advice ("foto iPhone (HEIC) belum didukung") for a photo
 * that is simply too big. A code costs one field and removes the guessing.
 *
 * These are protocol tokens, not copy: they are never shown to anyone, they are
 * stable across wording changes, and the Bahasa sentence the person actually
 * reads is chosen on the CLIENT (`errorCopy.ts`), which is the rule the whole
 * of `no-raw-server-errors.test.ts` exists to enforce.
 */
export const UPLOAD_ERROR_CODE = {
  /** No `file` part in the multipart body. */
  missingFile: "media_missing_file",
  /** Over `MAX_UPLOAD_BYTES`. */
  tooLarge: "media_too_large",
  /** Over `MAX_UPLOAD_PIXELS` — a small file that decodes to an enormous bitmap. */
  tooManyPixels: "media_too_many_pixels",
  /** Not a JPEG, PNG or WebP, decided by the file's own header. */
  unsupportedFormat: "media_unsupported_format",
} as const;

export type UploadErrorCode = (typeof UPLOAD_ERROR_CODE)[keyof typeof UPLOAD_ERROR_CODE];
