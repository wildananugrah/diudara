import { describe, expect, it } from "bun:test";
import {
  createScheduledPassLoops,
  DEFAULT_RENEWAL_INTERVAL_MS,
  formatChurnPassLine,
  formatMembershipReminderLine,
  formatMembershipSweepLine,
  formatOrphanSweepLine,
  formatPassFailure,
  formatRenewalPassLine,
  ORPHAN_SWEEP_WINDOW_MS,
  resolveRenewalIntervalMs,
  SweepExpiredMemberships,
  SweepOrphanMedia,
} from "./scheduled-passes";

/**
 * Like `poll-loop.test.ts`, these tests import only worker modules and the API's
 * dependency-free `log-safety` helper. `bun run --workspaces test` runs this from
 * `apps/worker`, where `apps/api/.env` is not loaded, so anything reaching
 * `db/client.ts` would fail on a missing DATABASE_URL instead of testing anything.
 */

const NOTHING_HAPPENED_RENEWAL = {
  considered: 0,
  reminded: 0,
  alreadyReminded: 0,
  skipped: 0,
  transitionedToPastDue: 0,
};

const NOTHING_HAPPENED_CHURN = {
  considered: 0,
  churned: 0,
  alreadyChurned: 0,
  revocationsQueued: 0,
  skippedRevocation: 0,
};

const NOTHING_HAPPENED_SWEEP = {
  considered: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
};

const NOTHING_HAPPENED_MEMBERSHIP_SWEEP = {
  considered: 0,
  retired: 0,
  skipped: 0,
  failed: 0,
};

const NOTHING_HAPPENED_MEMBERSHIP_REMINDER = {
  considered: 0,
  reminded: 0,
  alreadyReminded: 0,
  skipped: 0,
  failed: 0,
};

/** Counts, an optional stage-free label, `=` and spaces. Nothing else may appear. */
const COUNTS_ONLY = /^\[(renewals|churn|media|memberships|membership-reminders)\] (?:[a-z_]+=\d+ ?)+$/;

describe("formatRenewalPassLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    // A daily-ish pass over an empty window is the normal case, and one
    // "considered 0" line per tick would bury the lines that matter.
    expect(formatRenewalPassLine(NOTHING_HAPPENED_RENEWAL)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatRenewalPassLine({
      considered: 4,
      reminded: 2,
      alreadyReminded: 1,
      skipped: 1,
      transitionedToPastDue: 2,
    });

    expect(line).toBe(
      "[renewals] considered=4 reminded=2 already_reminded=1 skipped=1 past_due=2"
    );
  });

  it("speaks up when a pass considered rows and reminded nobody", () => {
    // `considered>0, reminded=0` is the shape of a pass that is finding rows and
    // failing to act on them, so it must not be silent.
    expect(formatRenewalPassLine({ ...NOTHING_HAPPENED_RENEWAL, considered: 3 })).toContain(
      "considered=3"
    );
  });

  it("emits counts and nothing else — no member, no link, no phone number", () => {
    const line = formatRenewalPassLine({
      considered: 1,
      reminded: 1,
      alreadyReminded: 0,
      skipped: 0,
      transitionedToPastDue: 1,
    });

    expect(line).toMatch(COUNTS_ONLY);
  });
});

describe("formatChurnPassLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    expect(formatChurnPassLine(NOTHING_HAPPENED_CHURN)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatChurnPassLine({
      considered: 3,
      churned: 2,
      alreadyChurned: 1,
      revocationsQueued: 2,
      skippedRevocation: 0,
    });

    expect(line).toBe(
      "[churn] considered=3 churned=2 already_churned=1 revocations_queued=2 skipped_revocation=0"
    );
  });

  it("emits counts and nothing else", () => {
    expect(formatChurnPassLine({ ...NOTHING_HAPPENED_CHURN, considered: 2, churned: 1 })).toMatch(
      COUNTS_ONLY
    );
  });
});

describe("formatOrphanSweepLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    expect(formatOrphanSweepLine(NOTHING_HAPPENED_SWEEP)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatOrphanSweepLine({ considered: 6, deleted: 3, skipped: 1, failed: 2 });

    expect(line).toBe("[media] considered=6 deleted=3 skipped=1 failed=2");
  });

  it("speaks up when every row in the pass failed to sweep", () => {
    // `considered>0, deleted=0` is the shape of a pass finding orphans and failing
    // to collect them — the exact silent-failure mode this task exists to prevent.
    expect(formatOrphanSweepLine({ considered: 2, deleted: 0, skipped: 0, failed: 2 })).toContain(
      "failed=2"
    );
  });

  it("emits counts and nothing else", () => {
    expect(formatOrphanSweepLine({ considered: 1, deleted: 1, skipped: 0, failed: 0 })).toMatch(
      COUNTS_ONLY
    );
  });
});

describe("formatMembershipSweepLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    expect(formatMembershipSweepLine(NOTHING_HAPPENED_MEMBERSHIP_SWEEP)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatMembershipSweepLine({ considered: 6, retired: 3, skipped: 1, failed: 2 });

    expect(line).toBe("[memberships] considered=6 retired=3 skipped=1 failed=2");
  });

  it("speaks up when every row in the pass failed to retire", () => {
    // `considered>0, retired=0` is the shape of a pass finding lapsed memberships and
    // failing to retire them — the exact silent-failure mode this task exists to prevent.
    expect(
      formatMembershipSweepLine({ considered: 2, retired: 0, skipped: 0, failed: 2 })
    ).toContain("failed=2");
  });

  it("emits counts and nothing else — no subscriber id, no owner id", () => {
    expect(
      formatMembershipSweepLine({ considered: 1, retired: 1, skipped: 0, failed: 0 })
    ).toMatch(COUNTS_ONLY);
  });
});

describe("formatMembershipReminderLine", () => {
  it("says nothing when the pass had nothing to do", () => {
    expect(formatMembershipReminderLine(NOTHING_HAPPENED_MEMBERSHIP_REMINDER)).toBeNull();
  });

  it("reports every count when the pass did something", () => {
    const line = formatMembershipReminderLine({
      considered: 9,
      reminded: 5,
      alreadyReminded: 2,
      skipped: 1,
      failed: 1,
    });

    expect(line).toBe(
      "[membership-reminders] considered=9 reminded=5 already_reminded=2 skipped=1 failed=1"
    );
  });

  it("SPEAKS UP for a pass that reached nobody at all", () => {
    // The failure this whole pass exists to prevent is "the member was never told",
    // and the shape of it is `considered>0, reminded=0`. A line that stayed silent
    // here would make a pass that reached nobody look exactly like a pass that had
    // nothing to do.
    const line = formatMembershipReminderLine({
      considered: 4,
      reminded: 0,
      alreadyReminded: 0,
      skipped: 4,
      failed: 0,
    });

    expect(line).toBe(
      "[membership-reminders] considered=4 reminded=0 already_reminded=0 skipped=4 failed=0"
    );
  });

  it("emits counts and nothing else — no subscriber id, no email, no number", () => {
    expect(
      formatMembershipReminderLine({
        considered: 1,
        reminded: 1,
        alreadyReminded: 0,
        skipped: 0,
        failed: 0,
      })
    ).toMatch(COUNTS_ONLY);
  });
});

describe("formatPassFailure", () => {
  it("drops the bound parameters of a failed query", () => {
    // Exactly what Phase 4 found in the worker's log: drizzle formats a query
    // failure as the statement plus its bound values, and the values are the
    // member's phone number.
    const drizzle = new Error(
      'Failed query: insert into "renewal_reminder" ("subscription_id") values ($1)\n' +
        "params: +6281234567890,Siti"
    );
    drizzle.cause = new Error('duplicate key value violates unique constraint "renewal_reminder_subscription_id_stage_unique"');

    const line = formatPassFailure("renewals", drizzle);

    expect(line).not.toContain("+6281234567890");
    expect(line).not.toContain("params:");
    // …and it still says what actually went wrong, which is the reason the cause
    // chain is walked rather than the outer message truncated.
    expect(line).toContain("duplicate key");
    expect(line.startsWith("[renewals] pass failed: ")).toBe(true);
  });

  it("redacts anything URL-shaped, because an invite link is a bearer credential", () => {
    const line = formatPassFailure("churn", new Error("telegram said no for https://t.me/+aBcSecret"));

    expect(line).not.toContain("t.me");
    expect(line).toContain("[link redacted]");
  });

  it("is always one line, so a thrown message cannot forge a second one", () => {
    const line = formatPassFailure("renewals", new Error("boom\n[worker] all is well"));

    expect(line.split("\n")).toHaveLength(1);
  });

  it("survives a non-Error being thrown without printing its contents", () => {
    const line = formatPassFailure("churn", { whatsappNumber: "+6281234567890" });

    expect(line).not.toContain("6281234567890");
    expect(line).toContain("non-Error");
  });

  it("is wired for the media sweep's own tag", () => {
    const line = formatPassFailure("media", new Error("bucket unreachable"));

    expect(line.startsWith("[media] pass failed: ")).toBe(true);
  });

  it("is wired for the membership sweep's own tag", () => {
    const line = formatPassFailure("memberships", new Error("connection reset"));

    expect(line.startsWith("[memberships] pass failed: ")).toBe(true);
  });
});

describe("ORPHAN_SWEEP_WINDOW_MS", () => {
  it("is 24 hours — spec §8's generous window, a person may leave a composer open for an hour", () => {
    expect(ORPHAN_SWEEP_WINDOW_MS).toBe(24 * 60 * 60_000);
  });
});

/**
 * In-memory `OrphanMediaRepository`, for `SweepOrphanMedia`'s own tests — no database,
 * so these run at unit-test speed. `listUnclaimedBefore` re-implements the same two
 * conditions the partial index enforces for real (`post_id is null`, `created_at <
 * cutoff`), which is what lets "claimed is never touched" and "the window boundary"
 * be pinned here without touching `DrizzleMediaRepository` at all — that repository's
 * own test (`drizzle-media.repository.test.ts`) already pins the SQL side.
 */
class FakeOrphanMediaRepository {
  readonly rows = new Map<string, { postId: string | null; createdAt: Date }>();
  readonly deletedIds: string[] = [];

  seed(id: string, postId: string | null, createdAt: Date): void {
    this.rows.set(id, { postId, createdAt });
  }

  async listUnclaimedBefore(cutoff: Date, limit: number): Promise<{ id: string }[]> {
    return [...this.rows.entries()]
      .filter(([, row]) => row.postId === null && row.createdAt.getTime() < cutoff.getTime())
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
      .slice(0, limit)
      .map(([id]) => ({ id }));
  }

  /** Reads the row exactly as `DrizzleMediaRepository.findById` does — `null` when gone. */
  async findById(id: string): Promise<{ postId: string | null } | null> {
    return this.rows.get(id) ?? null;
  }

  async deleteIfUnclaimed(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.postId !== null) return false;
    this.rows.delete(id);
    this.deletedIds.push(id);
    return true;
  }

  /** The race, as a test can spell it: somebody's composer claims this row right now. */
  claim(id: string, postId: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) row.postId = postId;
  }
}

/** In-memory `OrphanMediaStorage` that can be told to fail on specific ids. */
class FakeOrphanMediaStorage {
  readonly removedIds: string[] = [];
  readonly failFor = new Set<string>();

  async remove(id: string): Promise<void> {
    if (this.failFor.has(id)) {
      // The real adapter throws an AggregateError on a genuine failure (expired
      // credentials, a 403, a network partition) — see s3-media-storage.adapter.ts.
      throw new AggregateError([new Error("403 Forbidden")], `remove(${id}) failed`);
    }
    this.removedIds.push(id);
  }
}

describe("SweepOrphanMedia", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60_000);

  it("sweeps an unclaimed row past the window: the OBJECTS are removed before the ROW", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("m1", null, hoursAgo(25));

    // Wraps both fakes to record the ORDER calls actually happen in — the pin the
    // brief asks for: a test that fails if the order flips.
    const events: string[] = [];
    const removeSpy = storage.remove.bind(storage);
    storage.remove = async (id) => {
      events.push(`remove:${id}`);
      await removeSpy(id);
    };
    const deleteSpy = media.deleteIfUnclaimed.bind(media);
    media.deleteIfUnclaimed = async (id) => {
      events.push(`delete:${id}`);
      return deleteSpy(id);
    };

    const sweep = new SweepOrphanMedia(media, storage, { now: () => NOW });
    const result = await sweep.execute();

    expect(events).toEqual(["remove:m1", "delete:m1"]);
    expect(result).toEqual({ considered: 1, deleted: 1, skipped: 0, failed: 0 });
  });

  it("leaves an unclaimed row that is newer than the window untouched", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("fresh", null, hoursAgo(1));

    const sweep = new SweepOrphanMedia(media, storage, { now: () => NOW });
    const result = await sweep.execute();

    expect(media.deletedIds).toEqual([]);
    expect(storage.removedIds).toEqual([]);
    expect(result).toEqual({ considered: 0, deleted: 0, skipped: 0, failed: 0 });
  });

  it("never touches a claimed row, however old", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("claimed", "post-1", hoursAgo(24 * 365));

    const sweep = new SweepOrphanMedia(media, storage, { now: () => NOW });
    const result = await sweep.execute();

    expect(media.deletedIds).toEqual([]);
    expect(storage.removedIds).toEqual([]);
    expect(result).toEqual({ considered: 0, deleted: 0, skipped: 0, failed: 0 });
  });

  /**
   * **THE RACE THIS SWEEP COULD LOSE, and the data it used to destroy.** Final
   * whole-branch review, Important 4: `listUnclaimedBefore` returns a row, a
   * composer that has been open overnight claims it onto a post a moment later,
   * and the sweep — whose delete carried no guard — removed both the bytes and
   * the row. The post silently held fewer photos than its author sent.
   *
   * The row is re-read immediately before the bytes go, so a claim that lands
   * anywhere in the (long) window between the page listing and this row's turn
   * costs nothing at all.
   */
  it("skips a row that has been claimed since the page was listed, bytes and row intact", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("claimed-late", null, hoursAgo(48));
    media.seed("really-orphaned", null, hoursAgo(47));

    // The claim lands after the page is listed and before the row is swept —
    // exactly the window the guard exists for.
    const listSpy = media.listUnclaimedBefore.bind(media);
    media.listUnclaimedBefore = async (cutoff, limit) => {
      const page = await listSpy(cutoff, limit);
      media.claim("claimed-late", "post-1");
      return page;
    };

    const sweep = new SweepOrphanMedia(media, storage, { now: () => NOW });
    const result = await sweep.execute();

    expect(storage.removedIds).toEqual(["really-orphaned"]);
    expect(media.deletedIds).toEqual(["really-orphaned"]);
    expect(result).toEqual({ considered: 2, deleted: 1, skipped: 1, failed: 0 });
  });

  /**
   * The residual window — a claim landing between the re-read and the DELETE —
   * cannot be closed without inverting the objects-before-row order this class
   * is built on (see its docstring). What it CAN do is refuse to compound the
   * loss and say so out loud, which is what the conditional delete buys.
   */
  it("refuses to delete a row claimed in the last instant, and says so out loud", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("m1", null, hoursAgo(48));

    const removeSpy = storage.remove.bind(storage);
    storage.remove = async (id) => {
      await removeSpy(id);
      media.claim(id, "post-1");
    };

    const errors: string[] = [];
    const sweep = new SweepOrphanMedia(media, storage, {
      now: () => NOW,
      logError: (line) => errors.push(line),
    });
    const result = await sweep.execute();

    expect(media.deletedIds).toEqual([]);
    expect(result).toEqual({ considered: 1, deleted: 0, skipped: 1, failed: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("m1");
  });

  it("does not abort the pass when one row's storage removal fails, and that row survives for retry", async () => {
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("a", null, hoursAgo(48));
    media.seed("b", null, hoursAgo(30));
    media.seed("c", null, hoursAgo(25));
    storage.failFor.add("b");

    const errors: string[] = [];
    const sweep = new SweepOrphanMedia(media, storage, {
      now: () => NOW,
      logError: (line) => errors.push(line),
    });
    const result = await sweep.execute();

    expect(result).toEqual({ considered: 3, deleted: 2, skipped: 0, failed: 1 });
    expect(media.deletedIds.sort()).toEqual(["a", "c"]);
    // THE row whose object removal failed was never handed to deleteById — the
    // ordering pin holds on the failure path, not just the happy path.
    expect(media.deletedIds).not.toContain("b");
    // …and the failure is VISIBLE, not just absorbed into a count nobody reads.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("b");
  });

  it("does not loop forever when every row in a page fails", async () => {
    // batchSize matches the number of failing rows exactly, so without a
    // no-progress guard the pass would re-fetch the identical page forever:
    // neither row is ever deleted, so `listUnclaimedBefore` keeps returning both.
    const media = new FakeOrphanMediaRepository();
    const storage = new FakeOrphanMediaStorage();
    media.seed("x", null, hoursAgo(48));
    media.seed("y", null, hoursAgo(47));
    storage.failFor.add("x");
    storage.failFor.add("y");

    const sweep = new SweepOrphanMedia(media, storage, {
      now: () => NOW,
      batchSize: 2,
      logError: () => undefined,
    });
    const result = await sweep.execute();

    expect(result).toEqual({ considered: 2, deleted: 0, skipped: 0, failed: 2 });
  });
});

/**
 * In-memory `ExpiredMembershipRepository`, for `SweepExpiredMemberships`'s own tests —
 * no database, same reason as `FakeOrphanMediaRepository` above. `listExpiredActive`
 * re-implements the same two conditions Task 1's real query enforces (`status =
 * 'active'`, `current_period_end <= now`), which is what lets the boundary be pinned
 * here without touching `DrizzleUserSubscriptionRepository` at all — that repository's
 * own test already pins the SQL side. `retireExpired` re-implements the CONDITIONAL
 * UPDATE, not a bare status flip, so a race that retires the pair between the list and
 * this row's turn is observable here exactly as it is against the real database.
 */
class FakeExpiredMembershipRepository {
  readonly rows = new Map<
    string,
    { subscriberId: string; ownerId: string; status: string; currentPeriodEnd: Date }
  >();
  readonly failFor = new Set<string>();

  seed(row: {
    id: string;
    subscriberId: string;
    ownerId: string;
    status: string;
    currentPeriodEnd: Date;
  }): void {
    this.rows.set(row.id, {
      subscriberId: row.subscriberId,
      ownerId: row.ownerId,
      status: row.status,
      currentPeriodEnd: row.currentPeriodEnd,
    });
  }

  statusOf(id: string): string | undefined {
    return this.rows.get(id)?.status;
  }

  async listExpiredActive(
    now: Date,
    limit: number
  ): Promise<{ id: string; subscriberId: string; ownerId: string }[]> {
    return [...this.rows.entries()]
      .filter(([, row]) => row.status === "active" && row.currentPeriodEnd.getTime() <= now.getTime())
      .sort((a, b) => a[1].currentPeriodEnd.getTime() - b[1].currentPeriodEnd.getTime())
      .slice(0, limit)
      .map(([id, row]) => ({ id, subscriberId: row.subscriberId, ownerId: row.ownerId }));
  }

  async retireExpired(subscriberId: string, ownerId: string, now: Date): Promise<boolean> {
    const entry = [...this.rows.entries()].find(
      ([, row]) => row.subscriberId === subscriberId && row.ownerId === ownerId
    );
    if (entry === undefined) return false;
    const [id, row] = entry;
    if (this.failFor.has(id)) {
      // The real adapter's `retireExpired` is a single UPDATE against a live
      // connection — a thrown error here stands in for the database being briefly
      // unreachable, or the statement itself failing.
      throw new Error(`retireExpired(${id}) failed: connection reset`);
    }
    if (row.status !== "active" || row.currentPeriodEnd.getTime() > now.getTime()) return false;
    row.status = "expired";
    return true;
  }

  /** The race, as a test can spell it: another caller retires this pair first — a
   * concurrent sweep pass, or Task 2's lazy retirement on the purchase path. */
  retireExternally(id: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) row.status = "expired";
  }
}

describe("SweepExpiredMemberships", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z");
  const secondsFromNow = (s: number) => new Date(NOW.getTime() + s * 1000);

  it("retires an active membership one second past its period end", async () => {
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "sub-1",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-1),
    });

    const sweep = new SweepExpiredMemberships(subscriptions, { now: () => NOW });
    const result = await sweep.execute();

    expect(subscriptions.statusOf("sub-1")).toBe("expired");
    expect(result).toEqual({ considered: 1, retired: 1, skipped: 0, failed: 0 });
  });

  /**
   * THE BOUNDARY, the other direction. A sweep that retired every active membership
   * (or one that flipped the comparison) would pass every test above and this test
   * catches it: one second BEFORE the period ends, the membership is still live and
   * must not be touched.
   */
  it("does NOT retire an active membership one second before its period end", async () => {
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "sub-1",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(1),
    });

    const sweep = new SweepExpiredMemberships(subscriptions, { now: () => NOW });
    const result = await sweep.execute();

    expect(subscriptions.statusOf("sub-1")).toBe("active");
    expect(result).toEqual({ considered: 0, retired: 0, skipped: 0, failed: 0 });
  });

  it("leaves a live membership untouched however long ago it was created, as long as its period has not ended", async () => {
    // "Live" here means "not yet lapsed" — a membership bought years ago with a
    // period end far in the future must be untouched, exactly like a membership
    // bought a minute ago whose period has not ended either.
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "sub-old",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000),
    });

    const sweep = new SweepExpiredMemberships(subscriptions, { now: () => NOW });
    const result = await sweep.execute();

    expect(subscriptions.statusOf("sub-old")).toBe("active");
    expect(result).toEqual({ considered: 0, retired: 0, skipped: 0, failed: 0 });
  });

  it("counts a membership raced away by a concurrent retirement as skipped, not failed", async () => {
    // The same race `SweepOrphanMedia` guards against, one layer down: `listExpiredActive`
    // produced this id, and something else — another sweep pass, or Task 2's lazy
    // retirement on the purchase path — retired the pair before this row's turn.
    // `retireExpired`'s conditional UPDATE answers `false`, not an error.
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "raced",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-10),
    });
    subscriptions.seed({
      id: "real",
      subscriberId: "budi",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-9),
    });

    const listSpy = subscriptions.listExpiredActive.bind(subscriptions);
    subscriptions.listExpiredActive = async (now, limit) => {
      const page = await listSpy(now, limit);
      subscriptions.retireExternally("raced");
      return page;
    };

    const sweep = new SweepExpiredMemberships(subscriptions, { now: () => NOW });
    const result = await sweep.execute();

    expect(subscriptions.statusOf("real")).toBe("expired");
    expect(result).toEqual({ considered: 2, retired: 1, skipped: 1, failed: 0 });
  });

  it("does not abort the pass when one row's retireExpired throws, and that row is left active for the next pass", async () => {
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "a",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-30),
    });
    subscriptions.seed({
      id: "b",
      subscriberId: "budi",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-20),
    });
    subscriptions.seed({
      id: "c",
      subscriberId: "citra",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-10),
    });
    subscriptions.failFor.add("b");

    const errors: string[] = [];
    const sweep = new SweepExpiredMemberships(subscriptions, {
      now: () => NOW,
      logError: (line) => errors.push(line),
    });
    const result = await sweep.execute();

    expect(result).toEqual({ considered: 3, retired: 2, skipped: 0, failed: 1 });
    expect(subscriptions.statusOf("a")).toBe("expired");
    expect(subscriptions.statusOf("c")).toBe("expired");
    // THE row whose retireExpired threw is left ACTIVE — still expired-by-date, so the
    // very next pass finds it again and retries it.
    expect(subscriptions.statusOf("b")).toBe("active");
    // …and the failure is VISIBLE, not just absorbed into a count nobody reads.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("b");
  });

  it("does not loop forever when every row in a page fails", async () => {
    // batchSize matches the number of failing rows exactly, so without a no-progress
    // guard the pass would re-fetch the identical page forever: neither row is ever
    // retired, so listExpiredActive keeps returning both.
    const subscriptions = new FakeExpiredMembershipRepository();
    subscriptions.seed({
      id: "x",
      subscriberId: "alice",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-30),
    });
    subscriptions.seed({
      id: "y",
      subscriberId: "budi",
      ownerId: "rina",
      status: "active",
      currentPeriodEnd: secondsFromNow(-20),
    });
    subscriptions.failFor.add("x");
    subscriptions.failFor.add("y");

    const sweep = new SweepExpiredMemberships(subscriptions, {
      now: () => NOW,
      batchSize: 2,
      logError: () => undefined,
    });
    const result = await sweep.execute();

    expect(result).toEqual({ considered: 2, retired: 0, skipped: 0, failed: 2 });
  });
});

describe("resolveRenewalIntervalMs", () => {
  it("defaults when the variable is unset or blank", () => {
    expect(resolveRenewalIntervalMs(undefined)).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
    expect(resolveRenewalIntervalMs("")).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
    expect(resolveRenewalIntervalMs("   ")).toBe(DEFAULT_RENEWAL_INTERVAL_MS);
  });

  it("defaults to an interval MUCH longer than the outbox pass", () => {
    // The outbox pass is 5s because it is the delay a paying member sees on their
    // invite. These passes decide whole WIB calendar days, so a 5s cadence would
    // be tens of thousands of pointless queries a day.
    expect(DEFAULT_RENEWAL_INTERVAL_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("uses a configured value", () => {
    expect(resolveRenewalIntervalMs("60000")).toBe(60_000);
  });

  it("refuses a value that is not a usable interval, naming its own variable", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "1e9999"]) {
      expect(() => resolveRenewalIntervalMs(bad)).toThrow(/WORKER_RENEWAL_INTERVAL_MS/);
    }
  });
});

/** A pass that counts its calls and can be told to throw. */
function fakePass<T>(result: T) {
  const state = { calls: 0, throwOnCall: 0 };
  return {
    state,
    execute: async (): Promise<T> => {
      state.calls += 1;
      if (state.calls === state.throwOnCall) throw new Error("database was briefly unreachable");
      return result;
    },
  };
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("createScheduledPassLoops", () => {
  it("runs one pass of each type immediately, then waits out the interval", async () => {
    const processRenewals = fakePass({ ...NOTHING_HAPPENED_RENEWAL, reminded: 1 });
    const processChurn = fakePass({ ...NOTHING_HAPPENED_CHURN, churned: 1 });
    const processOrphanSweep = fakePass({ ...NOTHING_HAPPENED_SWEEP, deleted: 1 });
    const processMembershipSweep = fakePass({ ...NOTHING_HAPPENED_MEMBERSHIP_SWEEP, retired: 1 });
    const processMembershipReminder = fakePass({
      ...NOTHING_HAPPENED_MEMBERSHIP_REMINDER,
      reminded: 1,
    });
    const lines: string[] = [];
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals,
      processChurn,
      processOrphanSweep,
      processMembershipSweep,
      processMembershipReminder,
      intervalMs: 60_000,
      log: (line) => lines.push(line),
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(
      () =>
        processRenewals.state.calls > 0 &&
        processChurn.state.calls > 0 &&
        processOrphanSweep.state.calls > 0 &&
        processMembershipSweep.state.calls > 0 &&
        processMembershipReminder.state.calls > 0,
      "the first pass of each type"
    );
    // Long enough that a 5s-ish interval — or no interval at all — would show up
    // as a second pass.
    await Bun.sleep(25);
    expect(processRenewals.state.calls).toBe(1);
    expect(processChurn.state.calls).toBe(1);
    expect(processOrphanSweep.state.calls).toBe(1);
    expect(processMembershipSweep.state.calls).toBe(1);
    expect(processMembershipReminder.state.calls).toBe(1);

    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    const finished = await Promise.race([
      running.then(() => "stopped"),
      Bun.sleep(2_000).then(() => "still sleeping in the interval"),
    ]);

    expect(finished).toBe("stopped");
    expect(lines).toEqual([
      "[renewals] considered=0 reminded=1 already_reminded=0 skipped=0 past_due=0",
      "[churn] considered=0 churned=1 already_churned=0 revocations_queued=0 skipped_revocation=0",
      "[media] considered=0 deleted=1 skipped=0 failed=0",
      "[memberships] considered=0 retired=1 skipped=0 failed=0",
      "[membership-reminders] considered=0 reminded=1 already_reminded=0 skipped=0 failed=0",
    ]);
  });

  it("keeps running after a pass throws, and keeps the OTHER passes running too", async () => {
    // The rows are still in the database and the next pass is their retry. An
    // unhandled rejection here would take the whole worker down — including the
    // outbox loop that delivers what payments already bought.
    const processRenewals = fakePass(NOTHING_HAPPENED_RENEWAL);
    processRenewals.state.throwOnCall = 1;
    const processChurn = fakePass(NOTHING_HAPPENED_CHURN);
    const processOrphanSweep = fakePass(NOTHING_HAPPENED_SWEEP);
    const processMembershipSweep = fakePass(NOTHING_HAPPENED_MEMBERSHIP_SWEEP);
    const errors: string[] = [];
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals,
      processChurn,
      processOrphanSweep,
      processMembershipSweep,
      processMembershipReminder: fakePass(NOTHING_HAPPENED_MEMBERSHIP_REMINDER),
      intervalMs: 1,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(
      () =>
        processRenewals.state.calls >= 3 &&
        processChurn.state.calls >= 3 &&
        processOrphanSweep.state.calls >= 3 &&
        processMembershipSweep.state.calls >= 3,
      "all four passes to keep going after the throw"
    );
    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    await running;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[renewals] pass failed: database was briefly unreachable");
  });

  it("keeps running after the orphan sweep pass itself throws, and keeps the other passes running too", async () => {
    // A per-ROW storage failure is handled inside `SweepOrphanMedia` and never
    // reaches here (see its own describe block) — this is the backstop for
    // something the pass-level query itself cannot survive, e.g. the database
    // being briefly unreachable, the same case the renewal/churn loops handle.
    const processOrphanSweep = fakePass(NOTHING_HAPPENED_SWEEP);
    processOrphanSweep.state.throwOnCall = 1;
    const errors: string[] = [];
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals: fakePass(NOTHING_HAPPENED_RENEWAL),
      processChurn: fakePass(NOTHING_HAPPENED_CHURN),
      processOrphanSweep,
      processMembershipSweep: fakePass(NOTHING_HAPPENED_MEMBERSHIP_SWEEP),
      processMembershipReminder: fakePass(NOTHING_HAPPENED_MEMBERSHIP_REMINDER),
      intervalMs: 1,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(() => processOrphanSweep.state.calls >= 3, "the sweep to keep going after the throw");
    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    await running;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[media] pass failed: database was briefly unreachable");
  });

  it("keeps running after the membership sweep pass itself throws, and keeps the other passes running too", async () => {
    // A per-ROW `retireExpired` failure is handled inside `SweepExpiredMemberships` and
    // never reaches here (see its own describe block) — this is the backstop for
    // something the pass-level query itself cannot survive, the same case the
    // renewal/churn/media loops handle.
    const processMembershipSweep = fakePass(NOTHING_HAPPENED_MEMBERSHIP_SWEEP);
    processMembershipSweep.state.throwOnCall = 1;
    const errors: string[] = [];
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals: fakePass(NOTHING_HAPPENED_RENEWAL),
      processChurn: fakePass(NOTHING_HAPPENED_CHURN),
      processOrphanSweep: fakePass(NOTHING_HAPPENED_SWEEP),
      processMembershipSweep,
      processMembershipReminder: fakePass(NOTHING_HAPPENED_MEMBERSHIP_REMINDER),
      intervalMs: 1,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(
      () => processMembershipSweep.state.calls >= 3,
      "the membership sweep to keep going after the throw"
    );
    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    await running;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[memberships] pass failed: database was briefly unreachable");
  });

  it("keeps running after the reminder pass itself throws, and keeps the other passes running too", async () => {
    // A per-MEMBERSHIP failure is handled inside `RemindExpiringMembership` and never
    // reaches here — this is the backstop for something the pass-level query itself
    // could not survive. Its own loop, so a reminder query that fails every time
    // cannot also stop the retirement sweep that frees members to buy again.
    const processMembershipReminder = fakePass(NOTHING_HAPPENED_MEMBERSHIP_REMINDER);
    processMembershipReminder.state.throwOnCall = 1;
    const errors: string[] = [];
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals: fakePass(NOTHING_HAPPENED_RENEWAL),
      processChurn: fakePass(NOTHING_HAPPENED_CHURN),
      processOrphanSweep: fakePass(NOTHING_HAPPENED_SWEEP),
      processMembershipSweep: fakePass(NOTHING_HAPPENED_MEMBERSHIP_SWEEP),
      processMembershipReminder,
      intervalMs: 1,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(
      () => processMembershipReminder.state.calls >= 3,
      "the reminder pass to keep going after the throw"
    );
    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    await running;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "[membership-reminders] pass failed: database was briefly unreachable"
    );
  });

  it("never overlaps two passes of the same type", async () => {
    // The passes page through the whole backlog, so a slow one must not have a
    // second copy of itself claiming the same rows. `PollLoop` guarantees this;
    // the assertion is that these loops are built on it rather than on a timer.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slowRenewals = {
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        calls += 1;
        return NOTHING_HAPPENED_RENEWAL;
      },
    };
    const {
      renewalLoop,
      churnLoop,
      orphanSweepLoop,
      membershipSweepLoop,
      membershipReminderLoop,
    } = createScheduledPassLoops({
      processRenewals: slowRenewals,
      processChurn: fakePass(NOTHING_HAPPENED_CHURN),
      processOrphanSweep: fakePass(NOTHING_HAPPENED_SWEEP),
      processMembershipSweep: fakePass(NOTHING_HAPPENED_MEMBERSHIP_SWEEP),
      processMembershipReminder: fakePass(NOTHING_HAPPENED_MEMBERSHIP_REMINDER),
      intervalMs: 1,
      log: () => undefined,
    });

    const running = Promise.all([
      renewalLoop.run(),
      churnLoop.run(),
      orphanSweepLoop.run(),
      membershipSweepLoop.run(),
      membershipReminderLoop.run(),
    ]);
    await waitUntil(() => calls >= 3, "three renewal passes");
    renewalLoop.stop();
    churnLoop.stop();
    orphanSweepLoop.stop();
    membershipSweepLoop.stop();
    membershipReminderLoop.stop();
    await running;

    expect(maxInFlight).toBe(1);
  });
});
