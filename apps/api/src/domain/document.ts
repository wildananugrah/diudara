import {
  DOCUMENT_ERROR_CODE,
  MAX_DOCUMENT_NAME_LENGTH,
  type DocumentErrorCode,
} from "@diudara/shared";

/**
 * A refusal the UPLOAD ROUTE turns into a 400, carrying the wire code the
 * client's copy branches on.
 *
 * A plain `Error` and not an `AppError`, mirroring `ImageRejectedError`: the
 * domain says what is wrong, and only the route layer knows that a caller
 * error here should be rendered rather than logged as a fault.
 */
export class DocumentRejectedError extends Error {
  constructor(
    message: string,
    readonly code: DocumentErrorCode
  ) {
    super(message);
    this.name = "DocumentRejectedError";
  }
}

/**
 * Path separators, the dot-dot sequence, and every C0/C1 control character.
 *
 * Stripped rather than escaped, because there is no context in which this
 * value legitimately contains any of them: it is display text and a suggested
 * download filename, never a path and never part of a bucket key (the key is
 * the document's id alone).
 */
const SEPARATORS = /[/\\]/g;
const DOT_DOT = /\.\./g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The original filename, made safe to store, to display, and to put in a
 * `Content-Disposition` header.
 *
 * **Order matters.** Separators go before the dot-dot pass, so `../../etc`
 * cannot leave a `..` behind that a single pass would miss; the dot-dot pass
 * then runs until nothing changes, because `....` collapses to `..` on one
 * pass and would survive.
 *
 * THROWS on an empty result rather than defaulting. A file with no usable name
 * is a caller error, and inventing `document.pdf` for it hides whatever
 * produced it.
 */
export function sanitiseDocumentName(raw: string): string {
  let name = raw.replace(SEPARATORS, "").replace(CONTROL, "");
  // Repeat until stable: one pass turns `....` into `..`, which is exactly the
  // sequence being removed.
  let previous: string;
  do {
    previous = name;
    name = name.replace(DOT_DOT, "");
  } while (name !== previous);

  name = name.trim().slice(0, MAX_DOCUMENT_NAME_LENGTH);
  if (name.length === 0) {
    throw new DocumentRejectedError("nama berkas tidak valid", DOCUMENT_ERROR_CODE.invalidName);
  }
  return name;
}

/**
 * The download's `Content-Disposition`.
 *
 * **`attachment`, unconditionally** — one of the three measures that make
 * storing an unverified content type safe (the spec's "The security
 * decision"). The browser saves rather than renders, so even a correctly
 * labelled HTML file would not execute. There is no `inline` branch here on
 * purpose: a preview feature would have to add one deliberately and re-read
 * that section first.
 *
 * BOTH filename forms are sent. `filename=` is a quoted ASCII fallback with
 * its quotes stripped — a `"` would otherwise close the string early and turn
 * the rest of the name into new header parameters. `filename*=UTF-8''…` is
 * what a current browser actually reads, and is what lets a Bahasa or accented
 * name survive intact.
 *
 * `name` is assumed to have been through `sanitiseDocumentName` already — it
 * is what the row stores — so this function defends the quoting, not the
 * newlines.
 */
export function contentDispositionFor(name: string): string {
  const ascii = name.replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
