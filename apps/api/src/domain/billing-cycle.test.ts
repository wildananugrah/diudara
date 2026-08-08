import { describe, expect, it } from "bun:test";
import { computeNextBillingDate } from "./billing-cycle";

/** The three cycles `membership_tier.billing_cycle` is allowed to hold (shared zod enum). */
describe("computeNextBillingDate", () => {
  it("advances a monthly cycle by one month", () => {
    expect(computeNextBillingDate(new Date("2026-08-09T10:00:00Z"), "monthly")).toBe("2026-09-09");
  });

  it("advances a quarterly cycle by three months", () => {
    expect(computeNextBillingDate(new Date("2026-08-09T10:00:00Z"), "quarterly")).toBe(
      "2026-11-09"
    );
  });

  it("advances a yearly cycle by twelve months", () => {
    expect(computeNextBillingDate(new Date("2026-08-09T10:00:00Z"), "yearly")).toBe("2027-08-09");
  });

  it("rolls the year over rather than producing month 13", () => {
    expect(computeNextBillingDate(new Date("2026-12-15T10:00:00Z"), "monthly")).toBe("2027-01-15");
    expect(computeNextBillingDate(new Date("2026-11-30T10:00:00Z"), "quarterly")).toBe(
      "2027-02-28"
    );
  });

  it("clamps to the last day of a shorter target month instead of overflowing", () => {
    // `new Date(2026, 0, 31).setMonth(1)` silently lands on 2026-03-03: a member
    // who paid on the 31st would be billed a month and three days later, and the
    // date drifts further every cycle. Clamp instead.
    expect(computeNextBillingDate(new Date("2026-01-31T10:00:00Z"), "monthly")).toBe("2026-02-28");
    expect(computeNextBillingDate(new Date("2026-03-31T10:00:00Z"), "monthly")).toBe("2026-04-30");
  });

  it("clamps to 29 February in a leap year", () => {
    expect(computeNextBillingDate(new Date("2028-01-31T10:00:00Z"), "monthly")).toBe("2028-02-29");
  });

  it("keeps 29 February on a yearly cycle from a leap year to a common year", () => {
    expect(computeNextBillingDate(new Date("2028-02-29T10:00:00Z"), "yearly")).toBe("2029-02-28");
  });

  it("zero-pads month and day so the value is a valid Postgres date literal", () => {
    expect(computeNextBillingDate(new Date("2026-08-05T10:00:00Z"), "monthly")).toBe("2026-09-05");
    expect(computeNextBillingDate(new Date("2026-12-05T10:00:00Z"), "monthly")).toBe("2027-01-05");
  });

  it("refuses an unrecognised billing cycle rather than guessing a date", () => {
    // `billing_cycle` is a varchar, not a Postgres enum, so a bad value CAN
    // reach here. Silently defaulting to monthly would bill a yearly member
    // eleven months early.
    expect(() => computeNextBillingDate(new Date("2026-08-09T10:00:00Z"), "weekly")).toThrow(
      /billing cycle/i
    );
    expect(() => computeNextBillingDate(new Date("2026-08-09T10:00:00Z"), "")).toThrow(
      /billing cycle/i
    );
  });
});
