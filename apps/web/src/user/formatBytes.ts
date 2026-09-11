/**
 * `"2,4 MB"` — a file size in Bahasa Indonesia.
 *
 * The decimal separator is a COMMA, matching `api.ts`'s existing `id-ID`
 * money formatting. Built by hand rather than with `Intl.NumberFormat`, the
 * reason `relativeTime.ts` records for its month names: a Bun or Node build
 * without full ICU silently falls back to a dot, which would pass locally and
 * print the wrong separator in production.
 *
 * Binary units (1024), because that is what the byte count on the row is and
 * what `MAX_DOCUMENT_BYTES` is expressed in — a cap that reads "25 MB" in the
 * copy and refuses at 26,214,400 bytes needs the two to agree.
 *
 * One decimal place, trailing zero dropped: `2,4 MB` and `2 MB`, never
 * `2,0 MB`.
 */
const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  // A negative or NaN size is a broken row, not something to render as
  // "NaN MB" on a member's screen.
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Bytes are whole by definition, so the fractional branch only applies once
  // a division has happened.
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${UNITS[unit]}`;
}
