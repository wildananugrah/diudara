import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import {
  communities,
  creators,
  members,
  membershipTiers,
  renewalReminders,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleRenewalReminderRepository } from "./drizzle-renewal-reminder.repository";

beforeEach(resetDatabase);

const repo = new DrizzleRenewalReminderRepository(db);

let seedCounter = 0;

/** A creator → community → tier → member → active subscription chain. */
async function seedSubscription() {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-rina-${seedCounter}` })
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
    .values({ whatsappNumber: `+62811000${String(seedCounter).padStart(4, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId: tier.id, status: "active" })
    .returning();
  return { creator, community, tier, member, subscription };
}

/**
 * `recordIfNew` is the reminder-once mechanism, and the thing under test is WHO
 * arbitrates it: the unique `(subscription_id, stage)` index, via
 * `onConflictDoNothing`, and never a preceding read. A select-then-insert would look
 * identical in every sequential test below and fail only under concurrency — which is
 * why the last test forces the interleaving instead of hoping for it.
 */
describe("DrizzleRenewalReminderRepository.recordIfNew", () => {
  it("records a stage the first time and reports that it was new", async () => {
    const { subscription } = await seedSubscription();

    expect(await repo.recordIfNew({ subscriptionId: subscription.id, stage: "due" })).toBe(true);

    const rows = await db.select().from(renewalReminders);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("due");
    expect(rows[0].subscriptionId).toBe(subscription.id);
    expect(rows[0].sentAt).toBeInstanceOf(Date);
  });

  it("reports the SECOND attempt at the same stage as not new, and inserts nothing", async () => {
    const { subscription } = await seedSubscription();
    await repo.recordIfNew({ subscriptionId: subscription.id, stage: "overdue_1d" });

    expect(await repo.recordIfNew({ subscriptionId: subscription.id, stage: "overdue_1d" })).toBe(
      false
    );

    expect(await db.select().from(renewalReminders)).toHaveLength(1);
  });

  it("does not throw on the conflict — the duplicate is absorbed, not raised", async () => {
    // The whole point of `onConflictDoNothing`: a second pass must get a plain
    // `false` and carry on with the rest of its batch, not a driver error that
    // aborts the pass and leaves everybody else unreminded.
    const { subscription } = await seedSubscription();
    await repo.recordIfNew({ subscriptionId: subscription.id, stage: "pre_3d" });

    await expect(
      repo.recordIfNew({ subscriptionId: subscription.id, stage: "pre_3d" })
    ).resolves.toBe(false);
  });

  it("treats a different stage of the same subscription as new", async () => {
    const { subscription } = await seedSubscription();
    await repo.recordIfNew({ subscriptionId: subscription.id, stage: "due" });

    expect(await repo.recordIfNew({ subscriptionId: subscription.id, stage: "overdue_1d" })).toBe(
      true
    );

    expect(await db.select().from(renewalReminders)).toHaveLength(2);
  });

  it("treats the same stage of a DIFFERENT subscription as new", async () => {
    const first = await seedSubscription();
    const second = await seedSubscription();
    await repo.recordIfNew({ subscriptionId: first.subscription.id, stage: "due" });

    expect(await repo.recordIfNew({ subscriptionId: second.subscription.id, stage: "due" })).toBe(
      true
    );

    expect(await db.select().from(renewalReminders)).toHaveLength(2);
  });

  it("refuses a reminder for a subscription that does not exist", async () => {
    // The foreign key. A stage claimed against nothing would be a reminder nobody
    // could ever send, sitting in the way of a real one.
    await expect(
      repo.recordIfNew({
        subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666",
        stage: "due",
      })
    ).rejects.toThrow();
  });

  it("lets the DATABASE arbitrate concurrent claims — exactly ONE is new", async () => {
    // THE MUTATION TEST'S TARGET. Rewritten as select-then-insert, every sequential
    // test above still passes: the reads are ordered, so the second caller sees the
    // first caller's row. This one does not, because the latch holds all five callers
    // at the entry to `recordIfNew` until every one of them has arrived — so all five
    // reads happen before any write, which is precisely the state a pre-check cannot
    // survive. Causal, not temporal: the release is caused by the arrivals and by
    // nothing else (see ArrivalLatch).
    const { subscription } = await seedSubscription();
    const callers = 5;
    const latch = new ArrivalLatch(callers);

    const results = await Promise.all(
      Array.from({ length: callers }, async () => {
        await latch.arriveAndWait();
        return repo.recordIfNew({ subscriptionId: subscription.id, stage: "overdue_3d" });
      })
    );

    expect(results.filter((isNew) => isNew)).toHaveLength(1);
    expect(await db.select().from(renewalReminders)).toHaveLength(1);
  });
});
