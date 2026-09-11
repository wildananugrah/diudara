import { describe, expect, test } from "bun:test";
import { lastWibMonths, wibMonthRange } from "./wib-month";

/**
 * Every assertion here is at or beside a boundary. A test at midday proves
 * nothing about a rule that can only ever be wrong within seven hours of
 * midnight — the discipline `billing-cycle.ts` and
 * `remind-expiring-membership.ts` each established separately.
 */
describe("wibMonthRange", () => {
  test("a named month spans WIB midnight to WIB midnight", () => {
    const { from, to } = wibMonthRange("2026-09", new Date("2026-01-01T00:00:00.000Z"));
    // 1 September 2026, 00:00 WIB is 31 August 2026, 17:00 UTC.
    expect(from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    // 1 October 2026, 00:00 WIB — exclusive.
    expect(to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });

  test("an event in the first WIB hour of the month is inside it, not the month before", () => {
    // 1 September 2026, 00:30 WIB — which is still AUGUST in UTC. Reading
    // `month` as a UTC month files this under August and it vanishes from
    // September's grid.
    const at = new Date("2026-08-31T17:30:00.000Z");
    const september = wibMonthRange("2026-09", new Date(0));
    const august = wibMonthRange("2026-08", new Date(0));

    expect(at >= september.from && at < september.to).toBe(true);
    expect(at >= august.from && at < august.to).toBe(false);
  });

  test("an event in the last WIB hour of the month is inside it, not the month after", () => {
    // 30 September 2026, 23:30 WIB = 30 September, 16:30 UTC.
    const at = new Date("2026-09-30T16:30:00.000Z");
    const september = wibMonthRange("2026-09", new Date(0));
    const october = wibMonthRange("2026-10", new Date(0));

    expect(at >= september.from && at < september.to).toBe(true);
    expect(at >= october.from && at < october.to).toBe(false);
  });

  test("December rolls the year, not the month number", () => {
    const { from, to } = wibMonthRange("2026-12", new Date(0));
    expect(from.toISOString()).toBe("2026-11-30T17:00:00.000Z");
    expect(to.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  /**
   * `now` is the injected clock's, never `new Date()` — the reason
   * `clock.port.ts` already records, and what makes this boundary nameable
   * at all.
   */
  test("an absent month is the WIB month containing now, taken at the boundary", () => {
    // 1 September 2026, 00:30 WIB. A UTC reading of `now` says August.
    const now = new Date("2026-08-31T17:30:00.000Z");
    expect(wibMonthRange(undefined, now)).toEqual(wibMonthRange("2026-09", now));
  });

  test("a malformed month falls back to now's month rather than throwing", () => {
    const now = new Date("2026-09-15T09:00:00.000Z");
    const expected = wibMonthRange("2026-09", now);
    for (const bad of ["", "2026", "2026-13", "2026-00", "besok", "2026-9", "20260-09"]) {
      expect(wibMonthRange(bad, now)).toEqual(expected);
    }
  });
});

describe("lastWibMonths", () => {
  test("is oldest first and ends with the month containing now", () => {
    expect(lastWibMonths(new Date("2026-09-15T09:00:00.000Z"), 6)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  test("rolls back across a year boundary", () => {
    expect(lastWibMonths(new Date("2026-02-15T09:00:00.000Z"), 4)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  /** At the boundary, because the WIB month is what decides the last entry. */
  test("takes the WIB month at midnight, not the UTC one", () => {
    // 1 September 2026, 00:30 WIB — August in UTC.
    expect(lastWibMonths(new Date("2026-08-31T17:30:00.000Z"), 2)).toEqual(["2026-08", "2026-09"]);
  });
});
