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
 * TIMEZONE ASSUMPTION — read this before building recurring billing (Phase 5).
 * The arithmetic is in UTC, so the result does not depend on the server's local
 * timezone, but it is NOT anchored to the member's. DIUDARA's members are in
 * Indonesia (UTC+7): a payment at 06:00 Asia/Jakarta is 23:00 UTC the previous
 * day, so the stored date can be one day earlier than the member would count.
 * Accepted for Phase 3 (owner ruling, 2026-08-09) because it only shifts a
 * charge by a day and has no security consequence. Whoever writes the renewal
 * job inherits this: either compare in the same UTC frame this function uses,
 * or change both this function and the job together — never one of the two.
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
