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
 * Arithmetic is in UTC so the result does not depend on the server's local
 * timezone. See the report's Concerns for the (revenue-only, non-security)
 * consequence for early-morning Asia/Jakarta payments.
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
