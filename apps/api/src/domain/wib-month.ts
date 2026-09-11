/**
 * Asia/Jakarta is UTC+7 all year — Indonesia has never observed daylight
 * saving — so a WIB wall-clock time is readable by shifting the instant and
 * taking its UTC parts, and a WIB instant is buildable by doing the reverse.
 * `remind-expiring-membership.ts` carries the same constant and the same
 * reasoning for the same reason.
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** `YYYY-MM`, with the month constrained to 01–12 so `2026-13` never parses. */
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface WibMonthRange {
  /** WIB midnight on the 1st, as a UTC instant. Inclusive. */
  from: Date;
  /** WIB midnight on the 1st of the NEXT month, as a UTC instant. Exclusive. */
  to: Date;
}

/**
 * The half-open instant range covering one Asia/Jakarta calendar month.
 *
 * **A WIB month, not a UTC one, and the difference is not cosmetic.**
 * September in Jakarta begins seven hours before September in UTC, so an
 * event at 00:30 WIB on the 1st is `2026-08-31T17:30Z`. Ranging on UTC months
 * files it under August and it disappears from September's calendar grid —
 * visible only to someone who scheduled an early-morning event, which is
 * exactly the kind of bug that ships.
 *
 * `month` is `YYYY-MM`. Absent, empty or malformed falls back to the WIB
 * month containing `now` rather than throwing: this drives a calendar whose
 * query string a user can edit, and an unreadable `?month=` should show them
 * this month, not an error page.
 *
 * `now` IS A PARAMETER — the injected clock's, never `new Date()`. That is
 * what makes the fallback's own boundary testable, the reason `clock.port.ts`
 * and `relativeTime.ts` each record independently.
 */
export function wibMonthRange(month: string | null | undefined, now: Date): WibMonthRange {
  const matched = month == null ? null : MONTH_PATTERN.exec(month);
  const [year, monthIndex] =
    matched === null ? wibYearAndMonthOf(now) : [Number(matched[1]), Number(matched[2]) - 1];
  return { from: startOfWibMonth(year, monthIndex), to: startOfWibMonth(year, monthIndex + 1) };
}

/** The WIB calendar year and 0-based month an instant falls in. */
function wibYearAndMonthOf(at: Date): [number, number] {
  const shifted = new Date(at.getTime() + WIB_OFFSET_MS);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth()];
}

/**
 * `Date.UTC` normalises a month index of 12 into January of the next year, so
 * the `to` bound needs no special case for December.
 */
function startOfWibMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1) - WIB_OFFSET_MS);
}

/**
 * The last `count` WIB months ending with the one containing `now`, oldest
 * first — `["2026-04", … , "2026-09"]` for six.
 *
 * The LABELS, not the ranges: a caller sums a whole span in one query and
 * then reads this list to decide which keys must exist. That is what makes
 * zero-filling a decision about presentation rather than a second query per
 * month.
 *
 * `now` IS A PARAMETER, the injected clock's — the rule this module already
 * follows, and what makes the December roll-over testable at the boundary.
 */
export function lastWibMonths(now: Date, count: number): string[] {
  // A TUPLE, not an object — see `wibYearAndMonthOf`.
  const [year, month] = wibYearAndMonthOf(now);
  const months: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    // `Date.UTC` normalises a negative month index across the year, so
    // January minus five needs no special case.
    const at = new Date(Date.UTC(year, month - back, 1));
    months.push(`${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`);
  }
  return months;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
