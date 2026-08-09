import { describe, expect, it, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  communities,
  creators,
  members,
  membershipTiers,
  outbox,
  renewalReminders,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleRenewalReminderRepository } from "../../infrastructure/repositories/drizzle-renewal-reminder.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import type { RenewalReminderRepositoryPort } from "../ports/renewal-reminder-repository.port";
import { OUTBOX_SEND_RENEWAL_REMINDER } from "../ports/outbox-repository.port";
import {
  ProcessRenewals,
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SKIPPED,
} from "./process-renewals";

beforeEach(resetDatabase);

/** The stored `next_billing_date`, exactly as `computeNextBillingDate` writes it. */
const DUE_DATE = "2026-03-10";

/** 2026-03-10 00:00 Asia/Jakarta === 2026-03-09T17:00:00Z. */
const DUE_MIDNIGHT_WIB = new Date("2026-03-09T17:00:00.000Z");

/**
 * `n` whole WIB days after the due date, at 09:00 WIB — a plausible time for a daily
 * pass to run, and deliberately NOT midnight: the boundary cases belong to
 * renewal-schedule.test.ts, and a use-case test that only ever ran at midnight would
 * hide a use-case that had reintroduced millisecond arithmetic.
 */
function at(daysAfterDue: number, hoursIntoWibDay = 9): Date {
  return new Date(
    DUE_MIDNIGHT_WIB.getTime() + daysAfterDue * 86_400_000 + hoursIntoWibDay * 3_600_000
  );
}

/**
 * The grace deadline the pass must store for a subscription due on `DUE_DATE`:
 * `new Date("2026-03-10")` (UTC midnight, 07:00 WIB) plus ten days. Written out as a
 * literal rather than recomputed with `computeGraceEndsAt`, so a change to the domain
 * helper cannot silently move a deadline this test claims to pin.
 */
const EXPECTED_GRACE_ENDS_AT = "2026-03-20T00:00:00.000Z";

let seedCounter = 0;

async function seedSubscription(
  options: {
    status?: string;
    nextBillingDate?: string | null;
    communityStatus?: string;
    graceEndsAt?: Date | null;
    priceAmount?: number;
  } = {}
) {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-rina-${seedCounter}`,
      status: options.communityStatus ?? "active",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Basic",
      priceAmount: options.priceAmount ?? 50_000,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62812000${String(seedCounter).padStart(4, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: options.status ?? "active",
      nextBillingDate: options.nextBillingDate === undefined ? DUE_DATE : options.nextBillingDate,
      graceEndsAt: options.graceEndsAt ?? null,
      startedAt: new Date("2026-02-10T00:00:00.000Z"),
    })
    .returning();
  return { creator, community, tier, member, subscription };
}

interface Wiring {
  useCase: ProcessRenewals;
  clock: FixedClock;
}

function wire(
  options: {
    now?: Date;
    batchSize?: number;
    /** Swaps the reminder repository, for the forced-interleaving test only. */
    reminders?: RenewalReminderRepositoryPort;
  } = {}
): Wiring {
  const clock = new FixedClock(options.now ?? at(0));
  const useCase = new ProcessRenewals(
    new DrizzleSubscriptionRepository(db),
    options.reminders ?? new DrizzleRenewalReminderRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock,
    options.batchSize === undefined ? {} : { batchSize: options.batchSize }
  );
  return { useCase, clock };
}

async function reminderRows() {
  return db.select().from(renewalReminders).orderBy(asc(renewalReminders.sentAt));
}

async function outboxRows() {
  return db.select().from(outbox).orderBy(asc(outbox.createdAt));
}

async function activityRows() {
  return db.select().from(activityLogs).orderBy(asc(activityLogs.createdAt));
}

async function reloadSubscription(id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row;
}

describe("ProcessRenewals", () => {
  it("reminds a member three days before the due date, without touching their status", async () => {
    const { subscription, member, community } = await seedSubscription();
    const { useCase } = wire({ now: at(-3) });

    const result = await useCase.execute();

    expect(result.reminded).toBe(1);
    const reminders = await reminderRows();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].stage).toBe("pre_3d");

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe(OUTBOX_SEND_RENEWAL_REMINDER);
    // IDS AND A STAGE, nothing else. The reminder is delivered by a separate process
    // that resolves the member itself, so nothing about the payer belongs in here.
    expect(rows[0].payload).toEqual({ subscriptionId: subscription.id, stage: "pre_3d" });

    const audit = await activityRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].eventType).toBe(RENEWAL_REMINDER_QUEUED);
    expect(audit[0].memberId).toBe(member.id);
    expect(audit[0].communityId).toBe(community.id);
    expect(audit[0].metadata).toEqual({ stage: "pre_3d", subscriptionId: subscription.id });

    // pre_3d is a WARNING, not a lapse: the member has not missed anything yet, so
    // moving them to past_due here would start a grace clock three days early.
    const reloaded = await reloadSubscription(subscription.id);
    expect(reloaded.status).toBe("active");
    expect(reloaded.graceEndsAt).toBeNull();
  });

  it("sends nothing at all before the reminder window opens", async () => {
    await seedSubscription();
    const { useCase } = wire({ now: at(-10) });

    const result = await useCase.execute();

    expect(result.reminded).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await activityRows()).toHaveLength(0);
  });

  it("reads the clock on every pass, not once at construction", async () => {
    // The phase's defining constraint is that time is INJECTED. A use-case that
    // captured `clock.now()` in its constructor would pass every other test in this
    // file and then remind nobody in a long-running worker.
    await seedSubscription();
    const { useCase, clock } = wire({ now: at(-10) });

    expect((await useCase.execute()).reminded).toBe(0);
    clock.set(at(-3));

    expect((await useCase.execute()).reminded).toBe(1);
  });

  it("RUNNING THE PASS TWICE SENDS ONE REMINDER", async () => {
    // Counts, not final state. Phase 4 shipped a five-credential leak past a test
    // that asserted only the end state — the subscription row looks identical after
    // one send and after two, and it is the member's inbox that is at risk.
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(0) });

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    expect(second.alreadyReminded).toBe(1);

    expect(await reminderRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
    expect(await activityRows()).toHaveLength(1);
    // And the transition happened exactly once, so `updated_at` cannot be moved by
    // a pass that had nothing to do.
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");
  });

  it("SENDS ONE REMINDER after a job that has been down for three days", async () => {
    // Down from before pre_3d until day 4. The member must receive overdue_3d once,
    // not pre_3d + due + overdue_1d + overdue_3d in a burst. Proven here at the
    // USE-CASE level and not only in renewal-schedule.test.ts, because it is the
    // use-case that decides how many rows to write.
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(4) });

    const result = await useCase.execute();

    expect(result.reminded).toBe(1);
    const reminders = await reminderRows();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].stage).toBe("overdue_3d");

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ subscriptionId: subscription.id, stage: "overdue_3d" });
    expect(await activityRows()).toHaveLength(1);

    // The skipped stages must not be claimed either: a member who renews and lapses
    // again in a later period would otherwise find stages already spent.
    expect(reminders.map((row) => row.stage)).toEqual(["overdue_3d"]);
  });

  it("moves an active subscription to past_due on the due date and stores the deadline", async () => {
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(0) });

    const result = await useCase.execute();

    expect(result.transitionedToPastDue).toBe(1);
    const reloaded = await reloadSubscription(subscription.id);
    expect(reloaded.status).toBe("past_due");
    expect(reloaded.graceEndsAt?.toISOString()).toBe(EXPECTED_GRACE_ENDS_AT);
    expect(reloaded.updatedAt.getTime()).toBeGreaterThan(reloaded.createdAt.getTime());
  });

  it("still moves a subscription to past_due when the due stage itself was missed", async () => {
    // A pass that comes back at day 4 sees overdue_3d and never sees `due`. If the
    // transition were bound to the `due` stage alone, this member would stay `active`
    // for ever, never churn, and keep their Telegram access without paying.
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(4) });

    await useCase.execute();

    const reloaded = await reloadSubscription(subscription.id);
    expect(reloaded.status).toBe("past_due");
    // Measured from the DUE DATE, not from when the pass happened to run — otherwise
    // a job that was down for three days would silently extend everybody's grace.
    expect(reloaded.graceEndsAt?.toISOString()).toBe(EXPECTED_GRACE_ENDS_AT);
  });

  it("WRITES grace_ends_at ONCE — a later pass does not move it", async () => {
    const { subscription } = await seedSubscription();
    const { useCase, clock } = wire({ now: at(0) });

    await useCase.execute();
    const afterFirst = await reloadSubscription(subscription.id);
    clock.set(at(1));
    await useCase.execute();
    const afterSecond = await reloadSubscription(subscription.id);

    expect(afterSecond.graceEndsAt?.toISOString()).toBe(afterFirst.graceEndsAt?.toISOString());
    expect(afterSecond.graceEndsAt?.toISOString()).toBe(EXPECTED_GRACE_ENDS_AT);
    // Two stages, two reminders — the second pass DID do work, so the unchanged
    // deadline is not just an unchanged row.
    expect((await reminderRows()).map((row) => row.stage)).toEqual(["due", "overdue_1d"]);
    expect(await outboxRows()).toHaveLength(2);
  });

  /**
   * I1, final whole-branch review. THE DEPLOYMENT CASE, which is not hypothetical: Phase
   * 4 delivered channel access with no renewal tracking at all, so production already
   * holds subscriptions whose `next_billing_date` is well past. The first pass this phase
   * ever runs meets them all at once.
   */
  describe("the first pass ever, on a subscription that is long overdue", () => {
    it("gives it a deadline in the FUTURE, not one that has already expired", async () => {
      const { subscription } = await seedSubscription();
      const firstPassEver = at(40);
      const { useCase } = wire({ now: firstPassEver });

      const result = await useCase.execute();

      expect(result.transitionedToPastDue).toBe(1);
      const reloaded = await reloadSubscription(subscription.id);
      expect(reloaded.status).toBe("past_due");
      // Before the clamp this was 2026-03-20 — twenty days before the pass ran — so the
      // churn pass would have evicted them in the same tick that first warned them.
      const graceEndsAt = reloaded.graceEndsAt;
      if (graceEndsAt === null) throw new Error("no deadline was stored");
      expect(graceEndsAt.getTime()).toBeGreaterThan(firstPassEver.getTime());
      // Three whole days, the same notice the ordinary schedule gives between the final
      // warning and the deadline.
      expect(graceEndsAt.getTime() - firstPassEver.getTime()).toBe(3 * 86_400_000);
    });

    it("warns them FIRST: the final stage is queued, and it is the only thing queued", async () => {
      const { subscription } = await seedSubscription();
      const { useCase } = wire({ now: at(40) });

      await useCase.execute();

      // One message, the most advanced stage — the catch-up is `dueStageFor`'s job — and
      // no eviction anywhere near it.
      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe(OUTBOX_SEND_RENEWAL_REMINDER);
      expect(rows[0].payload).toEqual({ subscriptionId: subscription.id, stage: "overdue_7d" });
    });

    it("is still WRITE-ONCE: a later pass does not push the clamped deadline out again", async () => {
      // The clamp must not become a rolling deadline. `markPastDue` is predicated on
      // `active`, so the second pass never reaches the row — but a future change that
      // recomputed the deadline would extend it for ever and no member would ever churn.
      const { subscription } = await seedSubscription();
      const { useCase, clock } = wire({ now: at(40) });

      await useCase.execute();
      const afterFirst = await reloadSubscription(subscription.id);
      clock.set(at(41));
      await useCase.execute();

      expect((await reloadSubscription(subscription.id)).graceEndsAt?.toISOString()).toBe(
        afterFirst.graceEndsAt?.toISOString()
      );
    });
  });

  it("leaves a deadline that was already recorded exactly as it found it", async () => {
    // The discriminating case, and the reason the previous test is not enough: a
    // deadline recomputed from `next_billing_date` on every pass would come out at the
    // same value and look immutable. Here the stored deadline is deliberately NOT what
    // this code would compute, which is what a config or timezone change looks like
    // from the row's point of view. A member's eviction date must not move under them.
    const alreadyPromised = new Date("2026-03-20T05:00:00.000Z");
    const { subscription } = await seedSubscription({
      status: "past_due",
      graceEndsAt: alreadyPromised,
    });
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.reminded).toBe(1);
    const reloaded = await reloadSubscription(subscription.id);
    expect(reloaded.graceEndsAt?.toISOString()).toBe(alreadyPromised.toISOString());
    expect(reloaded.status).toBe("past_due");
  });

  it("escalates a past_due subscription through the overdue stages, one row per stage", async () => {
    const { subscription } = await seedSubscription();
    const { useCase, clock } = wire({ now: at(0) });

    for (const day of [0, 1, 3, 7]) {
      clock.set(at(day));
      await useCase.execute();
      // Twice per day: a worker restart mid-pass must not double up.
      await useCase.execute();
    }

    expect((await reminderRows()).map((row) => row.stage)).toEqual([
      "due",
      "overdue_1d",
      "overdue_3d",
      "overdue_7d",
    ]);
    expect(await outboxRows()).toHaveLength(4);
    expect(await activityRows()).toHaveLength(4);
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");
  });

  it("stops sending once the last stage is claimed, however stale the row gets", async () => {
    // `dueStageFor` saturates at overdue_7d rather than inventing later stages, so a
    // subscription nobody cleaned up is read on every pass for ever. The constraint,
    // not the schedule, is what keeps it quiet — and this proves the pass does not
    // trip over it.
    await seedSubscription({ status: "past_due" });
    const { useCase, clock } = wire({ now: at(7) });
    await useCase.execute();

    clock.set(at(400));
    const result = await useCase.execute();

    expect(result.reminded).toBe(0);
    expect(await reminderRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  });

  it("REMINDS NOBODY in an archived community, and records that it did not", async () => {
    const { subscription, member, community } = await seedSubscription({
      communityStatus: "archived",
    });
    const { useCase } = wire({ now: at(0) });

    const result = await useCase.execute();

    expect(result.reminded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await outboxRows()).toHaveLength(0);

    const audit = await activityRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].eventType).toBe(RENEWAL_REMINDER_SKIPPED);
    expect(audit[0].memberId).toBe(member.id);
    expect(audit[0].communityId).toBe(community.id);
    expect(audit[0].metadata).toEqual({
      reason: "community_not_accepting_renewals",
      communityStatus: "archived",
      stage: "due",
      subscriptionId: subscription.id,
    });

    // And no eviction clock is started either — spec §8: an archived community gets
    // no reminders AND no revocation.
    const reloaded = await reloadSubscription(subscription.id);
    expect(reloaded.status).toBe("active");
    expect(reloaded.graceEndsAt).toBeNull();
  });

  it("records the archived skip ONCE, however often the pass runs", async () => {
    // A daily pass over a community that was archived a year ago must not write a row
    // a day for ever. The stage claim bounds the audit trail as well as the sends.
    await seedSubscription({ communityStatus: "archived" });
    const { useCase } = wire({ now: at(0) });

    await useCase.execute();
    await useCase.execute();
    await useCase.execute();

    expect(await activityRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("still reminds a member of a PAUSED community", async () => {
    // `paused` stops NEW purchases (spec §9.1); it does not abandon the members who
    // already paid. An allowlist that only accepted `active` would silently let every
    // existing member of a paused community lapse without a word.
    await seedSubscription({ communityStatus: "paused" });
    const { useCase } = wire({ now: at(0) });

    expect((await useCase.execute()).reminded).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
  });

  it("only considers active and past_due subscriptions", async () => {
    // The query must filter by STATUS. `dueStageFor` never returns null for a stale
    // row, so an unfiltered query would keep attempting inserts the constraint
    // rejects — safe, but it would also mean pending, cancelled, superseded and
    // churned members receiving renewal reminders.
    for (const status of ["pending", "cancelled", "superseded", "churned"]) {
      await seedSubscription({ status });
    }
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.considered).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await activityRows()).toHaveLength(0);
  });

  it("ignores a subscription with no next_billing_date at all", async () => {
    await seedSubscription({ nextBillingDate: null });
    const { useCase } = wire({ now: at(30) });

    expect((await useCase.execute()).considered).toBe(0);
  });

  it("REMINDS EVERY due member even when the batch size is smaller than the backlog", async () => {
    // Written first as "one pass reminds one, the next pass picks up the rest", which
    // FAILED — and the failure was the design, not the test. Unlike the outbox, a
    // reminded subscription does not leave `findDueForRenewal`'s result set (the claim
    // lives in `renewal_reminder`), so a pass that took the first `batchSize` rows and
    // stopped read the SAME rows on every subsequent pass: with a batch size of 1 and
    // two due members, the second was never reminded by any pass, ever. The batch size
    // now bounds a QUERY and the pass walks the backlog with a keyset cursor.
    await seedSubscription();
    await seedSubscription();
    const { useCase } = wire({ now: at(0), batchSize: 1 });

    const result = await useCase.execute();

    expect(result.reminded).toBe(2);
    expect(result.considered).toBe(2);
    expect(await reminderRows()).toHaveLength(2);
    expect(await outboxRows()).toHaveLength(2);

    // And a second pass over the same backlog still sends nothing.
    expect((await useCase.execute()).reminded).toBe(0);
    expect(await outboxRows()).toHaveLength(2);
  });

  it("walks a backlog several pages deep, reminding each member exactly once", async () => {
    // The cursor has to be total: `next_billing_date` is a DAY, so these five members
    // all tie on it, and a cursor that carried only the date would either loop for ever
    // or skip the rest of the cohort.
    for (let index = 0; index < 5; index += 1) {
      await seedSubscription();
    }
    const { useCase } = wire({ now: at(0), batchSize: 2 });

    const result = await useCase.execute();

    expect(result.considered).toBe(5);
    expect(result.reminded).toBe(5);
    expect(await outboxRows()).toHaveLength(5);
  });

  it("TWO CONCURRENT PASSES DO NOT DOUBLE-SEND", async () => {
    // Reachable without a second host: the worker's own pass can overlap a manual
    // run, and Task 7 puts two scheduled passes in one process.
    //
    // THE INTERLEAVING IS FORCED. Two bare concurrent `execute()` calls prove nothing
    // — whichever pass claims first, the other reads the committed row and behaves,
    // which is exactly how a select-then-insert `recordIfNew` passes a "concurrency"
    // test. The latch holds BOTH passes at the entry to `recordIfNew` until both have
    // arrived, so both have decided to claim the same (subscription, stage) before
    // either writes. Causal, not temporal — see ArrivalLatch.
    const { subscription } = await seedSubscription();
    const latch = new ArrivalLatch(2);
    const real = new DrizzleRenewalReminderRepository(db);
    const synchronised: RenewalReminderRepositoryPort = {
      recordIfNew: async (input) => {
        await latch.arriveAndWait();
        return real.recordIfNew(input);
      },
    };
    const first = wire({ now: at(0), reminders: synchronised });
    const second = wire({ now: at(0), reminders: synchronised });

    const [a, b] = await Promise.all([first.useCase.execute(), second.useCase.execute()]);

    // ONE reminder claimed, ONE outbox row, ONE audit entry. The member's inbox is
    // the thing being protected, so the count of outbox rows is the assertion that
    // matters most.
    expect(await reminderRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
    expect(await activityRows()).toHaveLength(1);
    expect(a.reminded + b.reminded).toBe(1);
    // Both passes may have transitioned the row; the UPDATE is predicated on
    // `active`, so at most one of them can have.
    expect(a.transitionedToPastDue + b.transitionedToPastDue).toBe(1);
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");
  });

  it("keeps going after one subscription's community turns out to be unreminded", async () => {
    // One member's problem must not cost every later member in the batch their
    // reminder. Ordering is by due date, so the archived row is reached first.
    await seedSubscription({ communityStatus: "archived", nextBillingDate: "2026-03-09" });
    await seedSubscription({ nextBillingDate: DUE_DATE });
    const { useCase } = wire({ now: at(0) });

    const result = await useCase.execute();

    expect(result.skipped).toBe(1);
    expect(result.reminded).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
  });
});
