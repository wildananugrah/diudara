import type { BillingCycle } from "./membership-tier";

/** How many calendar months each cycle advances. */
const MONTHS_PER_CYCLE: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function isBillingCycle(value: string): value is BillingCycle {
  return Object.hasOwn(MONTHS_PER_CYCLE, value);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * The next billing date for a subscription that was just paid at `paidAt`,
 * formatted as `YYYY-MM-DD` for the `date` column `subscription.next_billing_date`.
 *
 * Two things this deliberately does NOT do:
 *
 *  1. It does not use `Date.prototype.setMonth`, which OVERFLOWS: 31 January
 *     plus one month becomes 3 March, so a member who paid on the 31st is
 *     billed late and drifts further every cycle. The day is clamped to the
 *     last day of the target month instead (31 Jan → 28 Feb, 29 Feb in a leap
 *     year).
 *  2. It does not fall back to a default cycle. `billing_cycle` is a varchar,
 *     not a Postgres enum, so an unrecognised value can physically reach here;
 *     guessing "monthly" would bill a yearly member eleven months early. It
 *     throws, and the webhook handler surfaces that as a 500 rather than
 *     writing a wrong date.
 *
 * TIMEZONE ASSUMPTION.
 * The arithmetic is in UTC, so the result does not depend on the server's local
 * timezone, but it is NOT anchored to the member's. DIUDARA's members are in
 * Indonesia (UTC+7): a payment at 06:00 Asia/Jakarta is 23:00 UTC the previous
 * day, so the stored date can be one day earlier than the member would count.
 * Accepted for Phase 3 (owner ruling, 2026-08-09) because it only shifts a
 * charge by a day and has no security consequence.
 *
 * HOW THE RENEWAL JOB READS IT — SUPERSEDED INSTRUCTION. This comment used to tell
 * whoever built recurring billing to "compare in the same UTC frame this function
 * uses". Phase 5 does NOT, by owner ruling: comparing in UTC puts the day boundary at
 * 07:00 WIB, so a member a full Asia/Jakarta day overdue still reads as merely due,
 * and the day they lose Telegram access is decided seven hours off the day their own
 * calendar changed. `domain/renewal-schedule.ts` therefore converts both instants to
 * an Asia/Jakarta CALENDAR DAY and compares those (see `jakartaDayNumber`).
 *
 * Nothing about the value written here moved — the stored date is unchanged, and this
 * function is deliberately untouched — only the interpretation of its boundary. The
 * one-day skew described above is still possible, and is still accepted for the same
 * reason. What is no longer true is that the two sides must share a frame: the DATE is
 * written in UTC and READ as the WIB day it names, which is what the `date` type means.
 *
 * WHAT `paidAt` IS ON A RENEWAL. The parameter is named for the ordinary case, and the
 * renewal path does not always pass the payment instant: it passes the LATER of the
 * payment and the due date being paid for, so a member who acts on their `pre_3d`
 * reminder three days early does not lose three days (see `renewalAnchor` in
 * infrastructure/repositories/drizzle-subscription.repository.ts). This function still
 * only adds months to whatever instant it is handed; the CHOICE of instant is the
 * caller's, and saying so here is what stops a future reader assuming it is always `now`.
 */
export function computeNextBillingDate(paidAt: Date, billingCycle: string): string {
  if (!isBillingCycle(billingCycle)) {
    throw new Error(
      `unrecognised billing cycle ${JSON.stringify(billingCycle)}; ` +
        `expected one of ${Object.keys(MONTHS_PER_CYCLE).join(", ")}`
    );
  }

  const monthsAhead = MONTHS_PER_CYCLE[billingCycle];
  const absoluteMonth = paidAt.getUTCMonth() + monthsAhead;
  const year = paidAt.getUTCFullYear() + Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12;

  // Day 0 of the FOLLOWING month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(paidAt.getUTCDate(), lastDayOfTargetMonth);

  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}
