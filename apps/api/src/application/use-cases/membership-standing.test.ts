import { describe, expect, it } from "bun:test";
import { membershipStanding } from "./is-member-of";

/**
 * `membershipStanding` is a PURE function, and these tests live in their own
 * file so they can prove it without a database.
 *
 * They started life inside `is-member-of.test.ts`, which carries a file-level
 * `beforeEach(resetDatabase)` — so the test pinning this feature's single
 * safety property (a PAID row with no period is NOT a member) could only run
 * against Postgres, and could go red for reasons that had nothing to do with
 * the predicate. Task 1's review called that out. `IsMemberOf`'s own
 * database-backed tests stay where they are; only the pure ones moved.
 *
 * THE PROPERTY THESE EXIST FOR: `status = 'active'` with no `current_period_end`
 * is the normal, permanent shape of a FREE membership, and would be a BUG on a
 * paid row (`activate()` always sets a period). `kind` is the only thing that
 * tells those two apart, so answering them differently is the whole job.
 */
describe("membershipStanding", () => {
  const PAID = {
    id: "s1",
    subscriberId: "u1",
    tierId: "t1",
    ownerId: "o1",
    status: "active",
    kind: "paid",
    createdAt: new Date(0),
    communityId: null,
  };

  const NOW = new Date("2026-08-25T00:00:00Z");
  const YESTERDAY = new Date("2026-08-24T00:00:00Z");
  const TOMORROW = new Date("2026-08-26T00:00:00Z");

  it("a free membership is a member with no period at all", () => {
    expect(membershipStanding({ ...PAID, kind: "free", currentPeriodEnd: null }, NOW)).toBe("member");
  });

  it("a PAID row with no period is still lapsed — the bug guard survives", () => {
    expect(membershipStanding({ ...PAID, currentPeriodEnd: null }, NOW)).toBe("lapsed");
  });

  it("a paid row whose period has passed is lapsed", () => {
    expect(membershipStanding({ ...PAID, currentPeriodEnd: YESTERDAY }, NOW)).toBe("lapsed");
  });

  /**
   * ADDED BY THE TASK 1 REVIEW, and it closes a real hole. Without it this
   * implementation passes every other test in this block:
   *
   *     if (!active) return "none";
   *     return active.kind === "free" ? "member" : "lapsed";
   *
   * — which denies every paying member on the box. It was caught only by
   * database-backed tests elsewhere, so the block that claims this predicate as
   * its subject was not actually pinning its most common answer.
   */
  it("a paid row whose period has NOT passed is a member — the ordinary paying case", () => {
    expect(membershipStanding({ ...PAID, currentPeriodEnd: TOMORROW }, NOW)).toBe("member");
  });

  it("a free row is a member even with a period in the past — kind wins", () => {
    expect(
      membershipStanding({ ...PAID, kind: "free", currentPeriodEnd: new Date("2026-01-01T00:00:00Z") }, NOW)
    ).toBe("member");
  });

  /**
   * Strict `>`, matching the repository's `gt`. An expiry landing exactly on
   * `now` is over — the two must not disagree by a millisecond.
   */
  it("a paid row expiring exactly now is lapsed, not a member", () => {
    expect(membershipStanding({ ...PAID, currentPeriodEnd: NOW }, NOW)).toBe("lapsed");
  });

  it("an unknown kind is treated as paid — fail closed, never as a free pass", () => {
    expect(membershipStanding({ ...PAID, kind: "trial", currentPeriodEnd: null }, NOW)).toBe("lapsed");
  });

  it("no row at all is 'none', not 'lapsed' — the offer is genuinely buyable", () => {
    expect(membershipStanding(null, NOW)).toBe("none");
  });
});
