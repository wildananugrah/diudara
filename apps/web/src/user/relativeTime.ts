/**
 * "2j", "3h", "11 Agu 2026" — Bahasa Indonesia, from an ISO string.
 *
 * `now` IS A PARAMETER, not `Date.now()`. This project has a family of a dozen
 * flakes that are all a clock read on one side compared against a clock read on
 * the other, and they fire under CPU contention. A formatter that reads the
 * clock itself cannot be tested at a boundary at all.
 *
 * MONTH NAMES ARE A LITERAL ARRAY, not `Intl.DateTimeFormat("id-ID")`. A Bun or
 * Node build without full ICU silently falls back to English, which would make
 * this pass locally and print "Aug" in production.
 */
const MONTHS_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const at = then.getTime();
  if (Number.isNaN(at)) return "";

  const elapsed = now.getTime() - at;
  // A clock ahead of the server's is a skew, not a post from the future.
  if (elapsed < MINUTE) return "baru saja";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}j`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}h`;

  return `${then.getUTCDate()} ${MONTHS_ID[then.getUTCMonth()]} ${then.getUTCFullYear()}`;
}
