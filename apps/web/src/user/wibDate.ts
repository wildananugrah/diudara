/**
 * WIB (Asia/Jakarta, UTC+7) calendar arithmetic for the Kegiatan tab.
 *
 * **Why this is not `relativeTime.ts`.** That module formats from
 * `getUTCDate()`/`getUTCMonth()`, which is harmless for a relative label
 * ("2j", "3h") and wrong for a calendar: an event at 00:30 WIB on the 16th is
 * `2026-09-15T17:30Z`, and a grid bucketing on UTC parts files it under the
 * 15th. It is left alone rather than "fixed" — its UTC reads are a separate
 * question about a shipped surface, and answering it inside an events phase is
 * how an events phase breaks the feed's timestamps.
 *
 * The technique is `wib-month.ts`'s on the API side and
 * `remind-expiring-membership.ts`'s before that: Indonesia has never observed
 * daylight saving, so shifting the instant by a fixed seven hours and reading
 * its UTC fields gives the WIB wall clock exactly.
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * A LITERAL ARRAY, not `Intl.DateTimeFormat("id-ID")` — the reason
 * `relativeTime.ts` records: a Bun or Node build without full ICU silently
 * falls back to English, which passes locally and prints "September" as
 * "September" but "Mei" as "May" in production.
 */
const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
] as const;

/** Monday-first, because the grid is. `weekday` indexes into this. */
export const WEEKDAYS_ID = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"] as const;

export interface WibParts {
  year: number;
  /** 0-based, matching `Date`'s own month numbering. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday, 6 = Sunday — the grid's column order, not `getDay()`'s. */
  weekday: number;
}

/** The WIB wall-clock fields of an ISO instant. */
export function wibParts(iso: string): WibParts {
  const shifted = new Date(new Date(iso).getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    // `getUTCDay()` is Sunday-0; the grid is Monday-first.
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

/** `YYYY-MM` in WIB — the shape `GET /communities/:slug/events?month=` expects. */
export function wibMonthOf(iso: string): string {
  const { year, month } = wibParts(iso);
  return `${year}-${pad(month + 1)}`;
}

/** `"16.00 WIB"`. A dot separator, which is how Indonesian writes a clock time. */
export function wibTimeLabel(iso: string): string {
  const { hour, minute } = wibParts(iso);
  return `${pad(hour)}.${pad(minute)} WIB`;
}

/** `"15 September 2026"` — the WIB calendar day of an instant. */
export function wibDateLabel(iso: string): string {
  const { year, month, day } = wibParts(iso);
  return `${day} ${MONTHS_ID[month]} ${year}`;
}

/** `"2026-09"` → `"September 2026"`. */
export function wibMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-");
  return `${MONTHS_ID[Number(monthNumber) - 1]} ${year}`;
}

/** How many days the WIB month `YYYY-MM` has. */
export function daysInWibMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
}

/** The Monday-indexed weekday the WIB month `YYYY-MM` starts on. */
export function firstWeekdayOfWibMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return (new Date(Date.UTC(year!, monthNumber! - 1, 1)).getUTCDay() + 6) % 7;
}

/** `"2026-09"` shifted by whole months, staying `YYYY-MM`. */
export function shiftWibMonth(month: string, by: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  // `Date.UTC` normalises an out-of-range month index across the year, so
  // December + 1 and January - 1 need no special case.
  const shifted = new Date(Date.UTC(year!, monthNumber! - 1 + by, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/**
 * A WIB wall clock — `"2026-09-15"` and `"16:00"`, exactly what native
 * `<input type="date">` and `<input type="time">` produce — as a UTC instant.
 *
 * THE INVERSE OF `wibParts`, and the composer's whole reason for existing in
 * this module. A creator typing 16:00 means 16:00 in Jakarta; sending
 * `2026-09-15T16:00:00.000Z` would move every event they schedule seven hours
 * later. `new Date("2026-09-15T16:00")` is worse still — that reads as the
 * BROWSER's local zone, so the same form would produce different instants for
 * a creator travelling.
 *
 * Returns `null` on anything that is not a complete, real date and time, so a
 * half-filled form is a disabled button rather than an Invalid Date on the
 * wire.
 */
export function wibWallClockToIso(date: string, time: string): string | null {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(time);
  if (dateParts === null || timeParts === null) return null;
  const [year, month, day] = dateParts.slice(1).map(Number);
  const [hour, minute] = timeParts.slice(1).map(Number);
  const at = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!) - WIB_OFFSET_MS);
  if (Number.isNaN(at.getTime())) return null;
  // `Date.UTC` silently rolls 31 February into 3 March. A round trip through
  // `wibParts` is what catches that: a date the calendar does not have comes
  // back as a different one.
  const round = wibParts(at.toISOString());
  if (round.year !== year || round.month !== month! - 1 || round.day !== day) return null;
  return at.toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
