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
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { OUTBOX_REVOKE_SUBSCRIPTION_ACCESS } from "../ports/outbox-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import { CHURNED, CHURN_REVOKE_SKIPPED, ProcessChurn } from "./process-churn";

beforeEach(resetDatabase);

/** The stored `next_billing_date`, exactly as `computeNextBillingDate` writes it. */
const DUE_DATE = "2026-03-10";

/**
 * The deadline `ProcessRenewals` stores for a subscription due on `DUE_DATE`:
 * `new Date("2026-03-10")` plus ten days. A LITERAL, like the one in
 * process-renewals.test.ts, so a change to `computeGraceEndsAt` cannot silently move a
 * deadline this file claims to pin.
 */
const GRACE_ENDS_AT = new Date("2026-03-20T00:00:00.000Z");

/** `n` whole days after the grace deadline. Negative is before it. */
function at(daysAfterGrace: number, hoursIntoDay = 9): Date {
  return new Date(
    GRACE_ENDS_AT.getTime() + daysAfterGrace * 86_400_000 + hoursIntoDay * 3_600_000
  );
}

let seedCounter = 0;

async function seedSubscription(
  options: {
    status?: string;
    graceEndsAt?: Date | null;
    communityStatus?: string;
    nextBillingDate?: string | null;
  } = {}
) {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-churn-${seedCounter}-${Date.now()}`,
      status: options.communityStatus ?? "active",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Basic",
      priceAmount: 50_000,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+6281${String(seedCounter).padStart(4, "0")}${Date.now() % 100000}`.slice(
        0,
        15
      ),
      name: "Siti",
    })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: options.status ?? "past_due",
      nextBillingDate: options.nextBillingDate === undefined ? DUE_DATE : options.nextBillingDate,
      graceEndsAt: options.graceEndsAt === undefined ? GRACE_ENDS_AT : options.graceEndsAt,
      startedAt: new Date("2026-02-10T00:00:00.000Z"),
    })
    .returning();
  return { creator, community, tier, member, subscription };
}

/**
 * The real repository, held at the entry to `markChurned` until every concurrent pass
 * has reached it. A subclass rather than a hand-written stand-in: everything except the
 * one method under test must behave exactly as production does, and a cast-free object
 * literal implementing the whole port would be twenty methods of noise.
 */
class LatchedSubscriptionRepository extends DrizzleSubscriptionRepository {
  constructor(private readonly latch: ArrivalLatch) {
    super(db);
  }

  override async markChurned(subscriptionId: string): Promise<boolean> {
    await this.latch.arriveAndWait();
    return super.markChurned(subscriptionId);
  }
}

function wire(
  options: {
    now?: Date;
    batchSize?: number;
    /** Swaps the subscription repository, for the forced-interleaving test only. */
    subscriptions?: SubscriptionRepositoryPort;
  } = {}
) {
  const clock = new FixedClock(options.now ?? at(1));
  const useCase = new ProcessChurn(
    options.subscriptions ?? new DrizzleSubscriptionRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock,
    options.batchSize === undefined ? {} : { batchSize: options.batchSize }
  );
  return { useCase, clock };
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

describe("ProcessChurn", () => {
  it("churns a past_due subscription whose grace deadline has passed, and queues the revoke", async () => {
    const { subscription, member, community } = await seedSubscription();
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.churned).toBe(1);
    expect(result.revocationsQueued).toBe(1);

    expect((await reloadSubscription(subscription.id)).status).toBe("churned");

    // Through Phase 4's OUTBOX, not inline: a Telegram outage must delay one
    // member's removal, not abort the pass.
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe(OUTBOX_REVOKE_SUBSCRIPTION_ACCESS);
    expect(rows[0].payload).toEqual({ subscriptionId: subscription.id });
    expect(rows[0].status).toBe("pending");

    const logs = await activityRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe(CHURNED);
    expect(logs[0].memberId).toBe(member.id);
    expect(logs[0].communityId).toBe(community.id);
  });

  /**
   * THE IDEMPOTENCY TEST, asserted as COUNTS rather than final state (Global
   * Constraints): a second pass leaves the subscription `churned` either way, so only
   * the count of outbox rows can tell "churned once" from "revoked twice".
   */
  it("running the pass twice churns once and enqueues ONE revoke row", async () => {
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(1) });

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.churned).toBe(1);
    expect(second.churned).toBe(0);
    // The second pass must not even SEE it: `churned` is outside the query's status
    // filter, so there is nothing to consider.
    expect(second.considered).toBe(0);

    expect(await outboxRows()).toHaveLength(1);
    expect(await activityRows()).toHaveLength(1);
    expect((await reloadSubscription(subscription.id)).status).toBe("churned");
  });

  /**
   * Spec §8: "Member pays on day 5, before revocation → back to `active`, no new
   * invite". By the time churn runs they are `active` again, and the pass must leave
   * them completely alone.
   *
   * The row is seeded with the grace deadline STILL SET, which is the stale-row shape
   * the handoff warned about: if the query filtered on `grace_ends_at` alone it would
   * revoke a paying member's access.
   */
  it("skips a member who paid on day 5 and is active again", async () => {
    const { subscription } = await seedSubscription({
      status: "active",
      // Advanced by the renewal, and a deliberately STALE deadline left behind.
      nextBillingDate: "2026-04-10",
      graceEndsAt: GRACE_ENDS_AT,
    });
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.considered).toBe(0);
    expect(result.churned).toBe(0);
    expect((await reloadSubscription(subscription.id)).status).toBe("active");
    expect(await outboxRows()).toHaveLength(0);
    expect(await activityRows()).toHaveLength(0);
  });

  it("does not read a long-churned subscription at all, so it generates no noise", async () => {
    // A year past its deadline. Without the status filter this row would be
    // considered on every pass for ever.
    await seedSubscription({ status: "churned" });
    await seedSubscription({ status: "cancelled" });
    await seedSubscription({ status: "pending", graceEndsAt: GRACE_ENDS_AT });
    const { useCase } = wire({ now: at(365) });

    const result = await useCase.execute();

    expect(result.considered).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await activityRows()).toHaveLength(0);
  });

  it("leaves a member alone at the deadline itself, and churns them a second later", async () => {
    const { subscription } = await seedSubscription();
    const atDeadline = wire({ now: GRACE_ENDS_AT });

    expect((await atDeadline.useCase.execute()).churned).toBe(0);
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");

    const justAfter = wire({ now: new Date(GRACE_ENDS_AT.getTime() + 1) });
    expect((await justAfter.useCase.execute()).churned).toBe(1);
  });

  it("does not churn a member still inside their grace period", async () => {
    const { subscription } = await seedSubscription();
    const { useCase } = wire({ now: at(-1) });

    const result = await useCase.execute();

    expect(result.churned).toBe(0);
    expect(result.considered).toBe(0);
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("ignores a past_due row with no stored deadline rather than inventing one", async () => {
    // Nothing writes this today — `markPastDue` sets both columns in one statement —
    // but the column is nullable, and recomputing the deadline here is exactly what
    // "the grace deadline is stored, not recomputed" forbids.
    const { subscription } = await seedSubscription({ graceEndsAt: null });
    const { useCase } = wire({ now: at(365) });

    expect((await useCase.execute()).churned).toBe(0);
    expect((await reloadSubscription(subscription.id)).status).toBe("past_due");
  });

  /**
   * Spec §8: an archived community gets no reminders and NO REVOKE, recorded in
   * `activity_log`. The subscription is still churned — nobody is paying for it — so
   * the row leaves the query and the audit entry is written exactly once, rather than
   * once per pass for ever.
   */
  it("churns an archived community's member but does not touch their Telegram access", async () => {
    const { subscription, member, community } = await seedSubscription({
      communityStatus: "archived",
    });
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.churned).toBe(1);
    expect(result.revocationsQueued).toBe(0);
    expect(result.skippedRevocation).toBe(1);
    expect((await reloadSubscription(subscription.id)).status).toBe("churned");
    expect(await outboxRows()).toHaveLength(0);

    const logs = await activityRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe(CHURN_REVOKE_SKIPPED);
    expect(logs[0].memberId).toBe(member.id);
    expect(logs[0].communityId).toBe(community.id);

    // And a second pass says nothing more about it.
    await useCase.execute();
    expect(await activityRows()).toHaveLength(1);
  });

  it("still churns a PAUSED community's member: pausing stops new purchases, not billing", async () => {
    const { subscription } = await seedSubscription({ communityStatus: "paused" });
    const { useCase } = wire({ now: at(1) });

    const result = await useCase.execute();

    expect(result.churned).toBe(1);
    expect(result.revocationsQueued).toBe(1);
    expect((await reloadSubscription(subscription.id)).status).toBe("churned");
  });

  it("walks a backlog larger than one batch", async () => {
    const first = await seedSubscription();
    const second = await seedSubscription();
    const third = await seedSubscription();
    const { useCase } = wire({ now: at(1), batchSize: 1 });

    const result = await useCase.execute();

    expect(result.churned).toBe(3);
    expect(await outboxRows()).toHaveLength(3);
    for (const seeded of [first, second, third]) {
      expect((await reloadSubscription(seeded.subscription.id)).status).toBe("churned");
    }
  });

  it("leaves the member's reminder rows alone: they are not this pass's business", async () => {
    const { subscription } = await seedSubscription();
    await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });
    const { useCase } = wire({ now: at(1) });

    await useCase.execute();

    expect(await db.select().from(renewalReminders)).toHaveLength(1);
  });

  it("TWO CONCURRENT PASSES DO NOT REVOKE TWICE", async () => {
    // THE INTERLEAVING IS FORCED. Two bare concurrent `execute()` calls prove nothing
    // here: whichever pass writes `churned` first, the other's query no longer returns
    // the row, so a read-then-write `markChurned` would pass a "concurrency" test that
    // never constructed the race. The latch holds both passes at the entry to
    // `markChurned` until both have arrived, so both have already decided to churn the
    // same subscription before either writes — and only the UPDATE's own
    // `status = 'past_due'` predicate can then arbitrate.
    const { subscription } = await seedSubscription();
    const latch = new ArrivalLatch(2);
    const synchronised = new LatchedSubscriptionRepository(latch);
    const first = wire({ now: at(1), subscriptions: synchronised });
    const second = wire({ now: at(1), subscriptions: synchronised });

    const [a, b] = await Promise.all([first.useCase.execute(), second.useCase.execute()]);

    // ONE churn, ONE revoke row, ONE audit entry. The outbox count is the assertion
    // that matters: two rows would be two removals of the same member.
    expect(a.churned + b.churned).toBe(1);
    expect(a.alreadyChurned + b.alreadyChurned).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
    expect(await activityRows()).toHaveLength(1);
    expect((await reloadSubscription(subscription.id)).status).toBe("churned");
  });

  it("reads the clock, never Date.now(): a churn that is not yet due stays not due", async () => {
    // The whole pass is decided by the injected instant. With the clock set well
    // before the deadline nothing happens, however far the real wall clock is past it.
    await seedSubscription();
    const { useCase, clock } = wire({ now: at(-30) });

    expect((await useCase.execute()).churned).toBe(0);

    clock.set(at(1));
    expect((await useCase.execute()).churned).toBe(1);
  });
});
