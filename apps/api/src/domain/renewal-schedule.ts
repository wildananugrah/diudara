/**
 * The renewal reminder schedule, as pure arithmetic over two instants.
 *
 * This module IMPORTS NOTHING, deliberately. Every prior phase was triggered by an
 * HTTP request; this one is triggered by a clock, and the decision "which reminder,
 * if any, does this subscription deserve right now" is the one piece of that which
 * can be tested without a database, a provider or a scheduler. Keeping it free of
 * imports is what keeps it that way.
 */

/**
 * The reminder stages, ordered earliest to latest.
 *
 * The order is load-bearing twice over: `dueStageFor` scans it to find the most
 * advanced applicable stage, and `renewal_reminder`'s unique `(subscription_id,
 * stage)` uses these exact strings as the once-per-stage key.
 */
export const REMINDER_STAGES = ["pre_3d", "due", "overdue_1d", "overdue_3d", "overdue_7d"] as const;

export type ReminderStage = (typeof REMINDER_STAGES)[number];

/**
 * How many whole Asia/Jakarta days after the due date each stage fires. Negative
 * is before. Must stay in the same order as `REMINDER_STAGES`, ascending.
 */
const STAGE_DAY_OFFSET: Record<ReminderStage, number> = {
  pre_3d: -3,
  due: 0,
  overdue_1d: 1,
  overdue_3d: 3,
  overdue_7d: 7,
};

/** How many days after the due date a past_due subscription stops being tolerated. */
const GRACE_DAYS = 7;

/**
 * The single place an instant is turned into an Asia/Jakarta calendar day.
 *
 * Returns the count of whole days since the Unix epoch **as WIB reckons them** —
 * a plain integer, so two of them can be subtracted to get a number of calendar
 * days apart.
 *
 * WHY A CALENDAR DATE AND NOT A MILLISECOND DELTA. `subscription.next_billing_date`
 * is a Postgres `date`: it names a DAY, not an instant, and `computeNextBillingDate`
 * writes it as "2026-03-10". Reading it back gives `new Date("2026-03-10")` — UTC
 * midnight, which is 07:00 WIB. Subtracting timestamps and dividing by 86_400_000
 * then measures from 07:00 WIB, so 00:30 WIB on the 11th comes out as 0.7 days and
 * floors to "still due" for a member who is a full WIB day overdue. A member's
 * reminder — and downstream, the day they lose Telegram access — has to turn over at
 * WIB midnight, because that is when the member's own date changes. Comparing
 * calendar days is the only thing that puts the boundary there.
 *
 * `Intl.DateTimeFormat` does the conversion with no dependency and, importantly, no
 * hardcoded offset. Indonesia has observed no DST since 1964 and WIB has been a flat
 * UTC+7, but reading the offset out of the tz database per instant means this stays
 * correct if that ever stops being true, or if the zone is ever changed to one that
 * does shift — a `+ 7 * 3_600_000` would silently misfile a day's reminders.
 *
 * `en-CA` is asked for because it formats as `YYYY-MM-DD`; the parts are read
 * individually rather than parsed out of the string, so the locale only has to be a
 * Gregorian one and cannot smuggle in a different day.
 */
const JAKARTA_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function jakartaDayNumber(instant: Date): number {
  const parts = JAKARTA_DATE_FORMAT.formatToParts(instant);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  // Date.UTC of the WIB civil date: a fixed, DST-free frame in which the division
  // is exact, used only to turn Y/M/D into a comparable ordinal.
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/**
 * The reminder a subscription due on `nextBillingDate` deserves at `now`, or null
 * if it is not yet in the reminder window.
 *
 * RETURNS ONE STAGE — THE MOST ADVANCED APPLICABLE ONE — NOT A LIST. That is the
 * whole reason a reminder pass that has been down for three days sends one message
 * instead of a burst of five: at four days overdue the answer is `overdue_3d`, and
 * `pre_3d`, `due` and `overdue_1d` are simply never asked for. The catch-up is a
 * property of this function, not of the caller's bookkeeping.
 *
 * It stays at `overdue_7d` indefinitely rather than inventing later stages, so a
 * churned subscription that was never cleaned up — hundreds of days past due, and
 * still read on every pass — gets a defined answer. `renewal_reminder`'s unique
 * `(subscription_id, stage)` is what stops that answer being re-sent.
 */
export function dueStageFor(nextBillingDate: Date, now: Date): ReminderStage | null {
  const daysSinceDue = jakartaDayNumber(now) - jakartaDayNumber(nextBillingDate);

  let stage: ReminderStage | null = null;
  // REMINDER_STAGES is ascending, so the last one whose offset has been reached is
  // the most advanced applicable one.
  for (const candidate of REMINDER_STAGES) {
    if (STAGE_DAY_OFFSET[candidate] <= daysSinceDue) stage = candidate;
  }
  return stage;
}

/**
 * The latest `next_billing_date` that can be inside the reminder window at `now`, as
 * the `YYYY-MM-DD` string the `date` column stores.
 *
 * The renewal pass cannot read every subscription in the table on every tick, so it
 * needs a SQL cut-off — and the cut-off has to be derived from the same Asia/Jakarta
 * day `dueStageFor` compares in. Deriving it in UTC instead would move the edge by
 * seven hours, and a subscription filtered out here is never offered to the schedule at
 * all: the member would simply never be reminded, with nothing anywhere saying why.
 *
 * It is the FIRST stage's offset that sets the edge (three days before the due date
 * today), read out of the table rather than written as a literal, so adding an earlier
 * stage widens the query automatically instead of silently starving it.
 */
export function latestDueDateInReminderWindow(now: Date): string {
  const cutOffDayNumber = jakartaDayNumber(now) - STAGE_DAY_OFFSET[REMINDER_STAGES[0]];
  // Exact: a day number times 86_400_000 is UTC midnight of that civil date, so the
  // first ten characters are its calendar date with no rounding.
  return new Date(cutOffDayNumber * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether a stage means the due date has arrived or gone past — i.e. whether the
 * member is now LATE rather than being warned in advance.
 *
 * The reminder pass uses it for the `active` → `past_due` transition, and it has to be
 * a property of the stage rather than `stage === "due"`: a pass that has been down for
 * three days is answered `overdue_3d` and never sees `"due"` at all, so an equality
 * test would leave that member `active` for ever — never churned, keeping paid access
 * indefinitely, with every later pass agreeing that nothing needs doing.
 */
export function isDueOrOverdue(stage: ReminderStage): boolean {
  return STAGE_DAY_OFFSET[stage] >= 0;
}

/**
 * When the grace period for a subscription due on `nextBillingDate` runs out.
 *
 * Whole days of elapsed time, not a calendar-day rollover: this is a DEADLINE the
 * member is measured against, and it is stored on the subscription when it enters
 * `past_due` precisely so a later timezone or config change cannot retroactively
 * move it (Global Constraints). Adding milliseconds keeps it exact, and since WIB
 * has no DST it also lands at the same wall-clock time of day.
 */
export function computeGraceEndsAt(nextBillingDate: Date): Date {
  return new Date(nextBillingDate.getTime() + GRACE_DAYS * 86_400_000);
}

/**
 * Whether `now` is past a stored grace deadline.
 *
 * Strictly after: at the deadline the member still has access. Losing access is
 * irreversible from the member's side (they need a new invite link), so the
 * boundary case resolves in their favour.
 */
export function isPastGrace(graceEndsAt: Date, now: Date): boolean {
  return now.getTime() > graceEndsAt.getTime();
}
