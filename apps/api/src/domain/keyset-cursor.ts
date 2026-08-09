/**
 * WHERE A PAGE ENDS: a timestamp AND a row id, together.
 *
 * Shared by the activity feed and the member roster because both paginate the same
 * way and the parsing is security-relevant enough that two copies of it is one copy
 * too many.
 *
 * BOTH HALVES, and that is the whole point. `created_at` and `joined_at` default to
 * `now()`, which under Postgres is the TRANSACTION timestamp — so every row a single
 * transaction writes shares one value exactly, and `HandlePaymentWebhook` writes more
 * than one. A cursor of the timestamp alone then either SKIPS the boundary row's ties
 * (`<`) or REPEATS them (`<=`). The id breaks the tie, so `(timestamp, id)` is
 * strictly ordered and a page boundary may fall anywhere — including in the middle of
 * a group of rows sharing one timestamp.
 *
 * NOT AN OFFSET, for the reason both feeds are append-heavy: a payment, a reminder or
 * a revocation can land between two "load more" clicks, and a single newly-prepended
 * row makes `offset n` repeat the previous page's last entry and drop one of the
 * originals. A cursor anchored on a row cannot drift.
 *
 * PURE, and it imports nothing.
 */
export interface KeysetCursor {
  timestamp: Date;
  id: string;
}

/** The one character separating the halves. Present in neither an ISO timestamp nor a uuid. */
const CURSOR_SEPARATOR = "|";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Renders a cursor for a `?before=` query parameter.
 *
 * Readable rather than base64: a cursor that turns up in a log line, a bug report or
 * a browser's address bar should say which moment it points at. It carries no secret
 * — a row id and a timestamp the creator is already looking at — so there is nothing
 * opacity would protect.
 */
export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return `${cursor.timestamp.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`;
}

/**
 * Parses a `?before=` value, or `null` if it is not one this function produced.
 *
 * STRICT, AND THE CALLER TURNS `null` INTO A 400. Treating a malformed cursor as "no
 * cursor" would restart the list at page 1, so a "load more" button with a corrupted
 * cursor would loop for ever showing the same rows — worse than an error, because
 * nothing tells the reader anything is wrong.
 */
export function decodeKeysetCursor(value: string): KeysetCursor | null {
  const parts = value.split(CURSOR_SEPARATOR);
  if (parts.length !== 2) return null;

  const [timestamp, id] = parts as [string, string];
  if (!UUID_PATTERN.test(id)) return null;

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip check: `new Date("2026")` parses, and accepting it would make two
  // different strings mean the same page while looking like different cursors.
  if (parsed.toISOString() !== timestamp) return null;

  return { timestamp: parsed, id };
}
