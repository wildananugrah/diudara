import { describe, expect, test } from "bun:test";
import {
  daysInWibMonth,
  firstWeekdayOfWibMonth,
  shiftWibMonth,
  wibDateLabel,
  wibMonthLabel,
  wibMonthOf,
  wibParts,
  wibTimeLabel,
  wibWallClockToIso,
} from "./wibDate";

/**
 * Every case is at or beside a WIB midnight. A test at midday cannot fail
 * however wrong the offset handling is, and the whole reason this module
 * exists instead of `relativeTime.ts`'s `getUTC*` reads is the seven hours
 * either side of it.
 */
describe("wibParts", () => {
  test("an instant just after WIB midnight is the NEW day, not the UTC one", () => {
    // 16 September 2026, 00:30 WIB = 15 September, 17:30 UTC.
    const parts = wibParts("2026-09-15T17:30:00.000Z");
    expect(parts).toEqual({ year: 2026, month: 8, day: 16, hour: 0, minute: 30, weekday: 2 });
  });

  test("an instant just before WIB midnight is still the old day", () => {
    // 15 September 2026, 23:30 WIB = 15 September, 16:30 UTC.
    expect(wibParts("2026-09-15T16:30:00.000Z").day).toBe(15);
  });

  test("weekday is Monday-indexed, because the grid is Monday-first", () => {
    // 14 September 2026 is a Monday.
    expect(wibParts("2026-09-14T09:00:00.000Z").weekday).toBe(0);
    // 20 September 2026 is a Sunday.
    expect(wibParts("2026-09-20T09:00:00.000Z").weekday).toBe(6);
  });

  test("crossing midnight can also cross the month", () => {
    // 1 October 2026, 00:15 WIB = 30 September, 17:15 UTC.
    const parts = wibParts("2026-09-30T17:15:00.000Z");
    expect(parts.day).toBe(1);
    expect(parts.month).toBe(9);
  });
});

describe("wibMonthOf", () => {
  test("is the YYYY-MM the API's month parameter expects", () => {
    expect(wibMonthOf("2026-09-15T09:00:00.000Z")).toBe("2026-09");
  });

  test("takes the WIB month at the boundary, not the UTC one", () => {
    // 1 September 2026, 00:30 WIB — August in UTC.
    expect(wibMonthOf("2026-08-31T17:30:00.000Z")).toBe("2026-09");
  });

  test("pads a single-digit month", () => {
    expect(wibMonthOf("2026-01-15T09:00:00.000Z")).toBe("2026-01");
  });
});

describe("wibTimeLabel", () => {
  test("is 24-hour, zero-padded, and says WIB", () => {
    expect(wibTimeLabel("2026-09-15T09:00:00.000Z")).toBe("16.00 WIB");
    expect(wibTimeLabel("2026-09-15T02:05:00.000Z")).toBe("09.05 WIB");
  });

  test("reads the WIB hour across midnight", () => {
    expect(wibTimeLabel("2026-09-15T17:30:00.000Z")).toBe("00.30 WIB");
  });
});

describe("wibDateLabel", () => {
  test("names the WIB calendar day in Bahasa", () => {
    expect(wibDateLabel("2026-09-15T09:00:00.000Z")).toBe("15 September 2026");
  });

  test("takes the WIB day across midnight, not the UTC one", () => {
    // 16 September, 00:30 WIB — still the 15th in UTC.
    expect(wibDateLabel("2026-09-15T17:30:00.000Z")).toBe("16 September 2026");
  });
});

describe("wibMonthLabel", () => {
  test("names the month in Bahasa from a YYYY-MM", () => {
    expect(wibMonthLabel("2026-09")).toBe("September 2026");
    expect(wibMonthLabel("2026-01")).toBe("Januari 2026");
  });
});

describe("daysInWibMonth", () => {
  test("knows the short months and the long ones", () => {
    expect(daysInWibMonth("2026-09")).toBe(30);
    expect(daysInWibMonth("2026-10")).toBe(31);
  });

  test("February is 28 in a common year and 29 in a leap year", () => {
    expect(daysInWibMonth("2026-02")).toBe(28);
    expect(daysInWibMonth("2028-02")).toBe(29);
    // 2100 is divisible by 4 but NOT a leap year — the rule a naive `% 4`
    // gets wrong. `Date.UTC` knows; this asserts we are asking it.
    expect(daysInWibMonth("2100-02")).toBe(28);
  });
});

describe("firstWeekdayOfWibMonth", () => {
  test("is Monday-indexed", () => {
    // 1 September 2026 is a Tuesday.
    expect(firstWeekdayOfWibMonth("2026-09")).toBe(1);
    // 1 November 2026 is a Sunday — the index a Sunday-first grid gets wrong.
    expect(firstWeekdayOfWibMonth("2026-11")).toBe(6);
  });
});

describe("shiftWibMonth", () => {
  test("moves within a year", () => {
    expect(shiftWibMonth("2026-09", 1)).toBe("2026-10");
    expect(shiftWibMonth("2026-09", -1)).toBe("2026-08");
  });

  test("rolls the year at both ends", () => {
    expect(shiftWibMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftWibMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("wibWallClockToIso", () => {
  test("reads the typed time as Jakarta's, not UTC's", () => {
    // 16:00 in Jakarta is 09:00Z. Sending 16:00Z would move the event.
    expect(wibWallClockToIso("2026-09-15", "16:00")).toBe("2026-09-15T09:00:00.000Z");
  });

  test("an early-morning WIB time lands on the previous UTC day", () => {
    expect(wibWallClockToIso("2026-09-16", "00:30")).toBe("2026-09-15T17:30:00.000Z");
  });

  test("round-trips through wibParts", () => {
    const iso = wibWallClockToIso("2026-09-15", "16:00")!;
    expect(wibTimeLabel(iso)).toBe("16.00 WIB");
    expect(wibDateLabel(iso)).toBe("15 September 2026");
  });

  test("is null on an incomplete form rather than an Invalid Date", () => {
    expect(wibWallClockToIso("", "16:00")).toBeNull();
    expect(wibWallClockToIso("2026-09-15", "")).toBeNull();
    expect(wibWallClockToIso("2026-9-15", "16:00")).toBeNull();
  });

  test("is null on a date the calendar does not have", () => {
    // Date.UTC rolls this into 3 March without complaining; the round-trip
    // check is what refuses it.
    expect(wibWallClockToIso("2026-02-31", "16:00")).toBeNull();
    expect(wibWallClockToIso("2026-02-28", "16:00")).not.toBeNull();
  });
});
