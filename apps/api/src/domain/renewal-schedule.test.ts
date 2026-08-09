import { describe, expect, it } from "bun:test";
import {
  REMINDER_STAGES,
  computeGraceEndsAt,
  dueStageFor,
  isPastGrace,
} from "./renewal-schedule";

/** 2026-03-10 00:00 Asia/Jakarta (UTC+7) === 2026-03-09T17:00:00Z */
const DUE = new Date("2026-03-09T17:00:00.000Z");
const day = (n: number) => new Date(DUE.getTime() + n * 86_400_000);

describe("dueStageFor", () => {
  it("returns null well before the reminder window", () => {
    expect(dueStageFor(DUE, day(-10))).toBeNull();
  });

  it("returns pre_3d three days before the due date", () => {
    expect(dueStageFor(DUE, day(-3))).toBe("pre_3d");
  });

  it("returns due on the due date", () => {
    expect(dueStageFor(DUE, DUE)).toBe("due");
  });

  it("escalates through the overdue stages", () => {
    expect(dueStageFor(DUE, day(1))).toBe("overdue_1d");
    expect(dueStageFor(DUE, day(3))).toBe("overdue_3d");
    expect(dueStageFor(DUE, day(7))).toBe("overdue_7d");
  });

  it("returns the MOST ADVANCED stage after a missed window, not each skipped one", () => {
    // The job was down from before pre_3d until day 4. The member must receive
    // overdue_3d once — not pre_3d, due and overdue_1d in a burst.
    expect(dueStageFor(DUE, day(4))).toBe("overdue_3d");
  });

  it("stays at the final stage past day 7 rather than inventing a new one", () => {
    expect(dueStageFor(DUE, day(30))).toBe("overdue_7d");
  });

  it("does not treat 00:30 Asia/Jakarta on the due date as the previous day", () => {
    // 2026-03-10 00:30 WIB === 2026-03-09T17:30:00Z. Phase 3 deferred this drift;
    // here it decides whether a paying member loses access a day early.
    const justAfterMidnightWib = new Date("2026-03-09T17:30:00.000Z");
    expect(dueStageFor(DUE, justAfterMidnightWib)).toBe("due");
  });

  it("does not treat 23:30 Asia/Jakarta the day before as already due", () => {
    // 2026-03-09 23:30 WIB === 2026-03-09T16:30:00Z, still the 9th locally.
    const lateNightBefore = new Date("2026-03-09T16:30:00.000Z");
    expect(dueStageFor(DUE, lateNightBefore)).toBe("pre_3d");
  });
});

describe("REMINDER_STAGES", () => {
  it("is ordered from earliest to latest", () => {
    expect(REMINDER_STAGES).toEqual(["pre_3d", "due", "overdue_1d", "overdue_3d", "overdue_7d"]);
  });
});

describe("computeGraceEndsAt", () => {
  it("is seven days after the due date", () => {
    expect(computeGraceEndsAt(DUE).toISOString()).toBe(day(7).toISOString());
  });
});

describe("isPastGrace", () => {
  it("is false before and at the deadline, true after", () => {
    const grace = computeGraceEndsAt(DUE);
    expect(isPastGrace(grace, day(6))).toBe(false);
    expect(isPastGrace(grace, grace)).toBe(false);
    expect(isPastGrace(grace, new Date(grace.getTime() + 1))).toBe(true);
  });
});

/**
 * Beyond the brief's cases. A `next_billing_date` far outside the reminder window
 * is not hypothetical: a churned subscription that was never cleaned up sits
 * hundreds of days past due, and the reminder pass reads it on every run.
 * Neither end may throw or answer with something nonsensical.
 */
describe("dueStageFor outside the window", () => {
  it("answers null for a due date 60 days in the future", () => {
    expect(dueStageFor(DUE, day(-60))).toBeNull();
  });

  it("stays at overdue_7d for a due date 400 days in the past", () => {
    expect(dueStageFor(DUE, day(400))).toBe("overdue_7d");
  });
});

/**
 * The stage boundaries are calendar-day boundaries in Asia/Jakarta, so a pass
 * running at any hour of a given WIB day must reach the same verdict as a pass
 * running at any other hour of it. This is the property the 00:30/23:30 tests
 * above pin at one boundary, asserted across a whole day.
 */
describe("Asia/Jakarta day boundaries", () => {
  it("gives the same stage at every hour of the due date in WIB", () => {
    // 2026-03-10 00:00..23:00 WIB === 2026-03-09T17:00Z .. 2026-03-10T16:00Z
    for (let hour = 0; hour < 24; hour += 1) {
      const atHour = new Date(DUE.getTime() + hour * 3_600_000);
      expect(dueStageFor(DUE, atHour)).toBe("due");
    }
  });

  it("flips to overdue_1d only once WIB midnight has passed", () => {
    // 2026-03-10 23:59:59 WIB is still the due date; one second later is the 11th.
    expect(dueStageFor(DUE, new Date("2026-03-10T16:59:59.000Z"))).toBe("due");
    expect(dueStageFor(DUE, new Date("2026-03-10T17:00:00.000Z"))).toBe("overdue_1d");
  });
});

/**
 * `subscription.next_billing_date` is a Postgres `date`, which Drizzle reads back
 * as the string "2026-03-10" and `computeNextBillingDate` writes in that form. The
 * renewal pass therefore hands `dueStageFor` a `new Date("2026-03-10")` — UTC
 * midnight, which is 07:00 WIB on the 10th and so safely inside the intended WIB
 * day.
 *
 * These cases are the ones that DISCRIMINATE a calendar-date comparison from
 * millisecond arithmetic. The brief's own 00:30/23:30 pair does not: it uses a due
 * instant that is already exactly WIB midnight, where `delta / 86_400_000` happens
 * to agree. With a UTC-midnight due date it does not — 2026-03-11 00:30 WIB is only
 * 17.5 hours after it, which a division floors to day 0 and reports as `due` for a
 * member who is already a day overdue.
 */
describe("dueStageFor with a next_billing_date read off the date column", () => {
  const dueFromColumn = new Date("2026-03-10");

  it("treats the whole WIB day as the due date", () => {
    // 2026-03-10 00:30 WIB and 23:00 WIB.
    expect(dueStageFor(dueFromColumn, new Date("2026-03-09T17:30:00.000Z"))).toBe("due");
    expect(dueStageFor(dueFromColumn, new Date("2026-03-10T16:00:00.000Z"))).toBe("due");
  });

  it("is already overdue_1d at 00:30 WIB the following day", () => {
    expect(dueStageFor(dueFromColumn, new Date("2026-03-10T17:30:00.000Z"))).toBe("overdue_1d");
  });

  it("is pre_3d at 23:30 WIB four days before, not null", () => {
    // 2026-03-07 23:30 WIB === 2026-03-07T16:30:00Z, three WIB days before the 10th.
    expect(dueStageFor(dueFromColumn, new Date("2026-03-07T16:30:00.000Z"))).toBe("pre_3d");
  });
});
