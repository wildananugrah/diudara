import { describe, expect, it } from "bun:test";
import {
  REMINDER_STAGES,
  computeGraceEndsAt,
  dueStageFor,
  isDueOrOverdue,
  isPastGrace,
  latestDueDateInReminderWindow,
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
  it("is ten days after the due date", () => {
    expect(computeGraceEndsAt(DUE).toISOString()).toBe(day(10).toISOString());
  });
});

/**
 * THE INVARIANT THAT MAKES THE FINAL WARNING A WARNING, asserted as a RELATIONSHIP
 * between the schedule and the grace period rather than as two literals.
 *
 * Both numbers used to be 7. That is not a rounding detail: `overdue_7d` becomes
 * claimable at 00:00 WIB on day 7, while the deadline computed from the `date` column
 * lands at 07:00 WIB the same day — a seven-hour window in which the reminder pass and
 * the churn pass, two independent loops, race for the same member. Measured in Phase 5
 * Task 9 by walking the lifecycle in a running worker: churn won BOTH times, and the
 * member was removed having received `overdue_3d` as their last word.
 *
 * Spec 6 says the pre-warning exists because the charge is now a MANUAL action the
 * member must take, and Spec 8 says nobody is removed without warning. A member who
 * must act needs time to act, so the gap below is a real number of days and not merely
 * "greater than zero".
 *
 * Written against the public API — the last entry of `REMINDER_STAGES`, and the
 * deadline `computeGraceEndsAt` actually produces — so editing either constant alone
 * fails here. A pair of literal assertions would let someone reintroduce the race by
 * changing one number and updating the test that named it.
 */
describe("the grace period against the last reminder stage", () => {
  /** Whole days between the due date and the deadline `computeGraceEndsAt` produces. */
  function graceDays(): number {
    return (computeGraceEndsAt(DUE).getTime() - DUE.getTime()) / 86_400_000;
  }

  /** The first whole day after the due date on which the LAST stage is claimable. */
  function firstDayOfFinalStage(): number {
    const finalStage = REMINDER_STAGES[REMINDER_STAGES.length - 1];
    for (let offset = 0; offset <= 400; offset += 1) {
      if (dueStageFor(DUE, day(offset)) === finalStage) return offset;
    }
    throw new Error(`no day within a year reaches the final stage ${finalStage}`);
  }

  /**
   * How many whole days the member must still have after the final warning. Three,
   * because that is the smallest gap that is unambiguously not a race: the passes run
   * hourly, so a one-day gap survives a normal day but not a worker that was down, and
   * a member told "your access is about to be revoked" needs a weekend to act.
   */
  const MINIMUM_DAYS_BETWEEN_FINAL_WARNING_AND_CHURN = 3;

  it("leaves at least three whole days between the final warning and the deadline", () => {
    expect(graceDays() - firstDayOfFinalStage()).toBeGreaterThanOrEqual(
      MINIMUM_DAYS_BETWEEN_FINAL_WARNING_AND_CHURN
    );
  });

  it("puts the deadline strictly after the final stage, never on the same day", () => {
    // The 7/7 shape satisfied `>=` on the day number while still being a race, so the
    // comparison that matters is against the WHOLE day the final stage opens on.
    expect(graceDays()).toBeGreaterThan(firstDayOfFinalStage());
  });

  it("still has the member inside grace on the day the final warning is claimable", () => {
    const grace = computeGraceEndsAt(DUE);
    // Every hour of that WIB day, not just one: the reminder pass may run at any of
    // them, and at none of them may the member already be revocable.
    for (let hour = 0; hour < 24; hour += 1) {
      const instant = new Date(day(firstDayOfFinalStage()).getTime() + hour * 3_600_000);
      expect(dueStageFor(DUE, instant)).toBe(REMINDER_STAGES[REMINDER_STAGES.length - 1]);
      expect(isPastGrace(grace, instant)).toBe(false);
    }
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

/**
 * What the renewal pass hands to SQL. The pass must not read every subscription in
 * the table on every tick, so it needs a cut-off — and the cut-off has to be
 * computed in the SAME frame `dueStageFor` compares in, or a member on the edge of
 * the window is filtered out before the schedule is ever consulted.
 */
describe("latestDueDateInReminderWindow", () => {
  it("is three days after today in Asia/Jakarta, as a date-column string", () => {
    // 2026-03-10 09:00 WIB. The first stage fires three days BEFORE the due date, so
    // a subscription due on the 13th is already inside the window today.
    expect(latestDueDateInReminderWindow(new Date("2026-03-10T02:00:00.000Z"))).toBe("2026-03-13");
  });

  it("uses the WIB day, not the UTC one, either side of midnight", () => {
    // 2026-03-10 00:30 WIB is still 2026-03-09 in UTC. Taking the UTC day here would
    // shrink the window by a day for every pass that ran in the WIB small hours, and
    // a member due exactly at the edge would never be reminded at all.
    expect(latestDueDateInReminderWindow(new Date("2026-03-09T17:30:00.000Z"))).toBe("2026-03-13");
    // 2026-03-09 23:30 WIB is still the 9th locally.
    expect(latestDueDateInReminderWindow(new Date("2026-03-09T16:30:00.000Z"))).toBe("2026-03-12");
  });

  it("never filters out a subscription the schedule would remind", () => {
    // The two functions have to agree: anything `dueStageFor` gives a stage to must be
    // inside the cut-off. Checked across a month of due dates around `now`.
    const now = new Date("2026-03-10T02:00:00.000Z");
    const cutOff = latestDueDateInReminderWindow(now);
    for (let offset = -20; offset <= 20; offset += 1) {
      const dueDate = new Date(Date.UTC(2026, 2, 10 + offset));
      const stage = dueStageFor(dueDate, now);
      const inWindow = dueDate.toISOString().slice(0, 10) <= cutOff;
      if (stage !== null) {
        expect(inWindow).toBe(true);
      }
    }
  });

  it("rolls over a month and a year boundary correctly", () => {
    expect(latestDueDateInReminderWindow(new Date("2026-01-30T02:00:00.000Z"))).toBe("2026-02-02");
    expect(latestDueDateInReminderWindow(new Date("2026-12-30T02:00:00.000Z"))).toBe("2027-01-02");
  });
});

/**
 * Which stages mean "the due date has arrived or passed". The reminder pass uses it to
 * decide the `active` → `past_due` transition, and it must be a property of the STAGE
 * rather than an equality test against `"due"` — a pass that comes back after three
 * days of downtime never sees `"due"` at all, and a member who is never moved to
 * `past_due` is never churned either.
 */
describe("isDueOrOverdue", () => {
  it("is false for the pre-due warning only", () => {
    expect(isDueOrOverdue("pre_3d")).toBe(false);
    expect(isDueOrOverdue("due")).toBe(true);
    expect(isDueOrOverdue("overdue_1d")).toBe(true);
    expect(isDueOrOverdue("overdue_3d")).toBe(true);
    expect(isDueOrOverdue("overdue_7d")).toBe(true);
  });

  it("agrees with every stage in REMINDER_STAGES", () => {
    // Guards a stage added later with no thought about the transition: exactly one
    // stage in the list is pre-due today, and if that changes this test says so.
    expect(REMINDER_STAGES.filter((stage) => !isDueOrOverdue(stage))).toEqual(["pre_3d"]);
  });
});
