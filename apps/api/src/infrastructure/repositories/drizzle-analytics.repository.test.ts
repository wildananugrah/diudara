import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import {
  communities,
  creators,
  members,
  membershipTiers,
  subscriptions,
  transactions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleAnalyticsRepository } from "./drizzle-analytics.repository";

beforeEach(resetDatabase);

const repo = new DrizzleAnalyticsRepository(db);

let seedCounter = 0;

/** A creator with one community, which is what every test here starts from. */
async function seedCreatorWithCommunity(name = "Rina") {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: `Kelas ${name}`,
      slug: `kelas-${name.toLowerCase()}-${seedCounter}`,
    })
    .returning();
  return { creator, community };
}

async function seedTier(
  communityId: string,
  overrides: { name?: string; priceAmount?: number } = {}
) {
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId,
      name: overrides.name ?? "Basic",
      priceAmount: overrides.priceAmount ?? 50_000,
      billingCycle: "monthly",
    })
    .returning();
  return tier;
}

async function seedMember(label = "Siti") {
  seedCounter += 1;
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+62810${String(seedCounter).padStart(7, "0")}`,
      name: label,
    })
    .returning();
  return member;
}

/** A subscription in an explicit status, with its own fresh member. */
async function seedSubscription(tierId: string, status: string) {
  const member = await seedMember();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId, status })
    .returning();
  return { subscription, member };
}

async function seedTransaction(subscriptionId: string, amount: number, status: string) {
  const [transaction] = await db
    .insert(transactions)
    .values({ subscriptionId, amount, status, paymentMethod: "qris" })
    .returning();
  return transaction;
}

describe("DrizzleAnalyticsRepository.getMetricsForCreator — scoping", () => {
  it("returns null for a community another creator owns", async () => {
    const owner = await seedCreatorWithCommunity("Rina");
    const stranger = await seedCreatorWithCommunity("Budi");
    const tier = await seedTier(owner.community.id, { name: "VIP", priceAmount: 250_000 });
    const { subscription } = await seedSubscription(tier.id, "active");
    await seedTransaction(subscription.id, 250_000, "success");

    // THE MUTATION-CHECK TARGET. Removing `eq(communities.creatorId, creatorId)`
    // from the repository's scoping query makes this return a full metrics object
    // for a creator who owns nothing here, and this expectation is what dies.
    expect(
      await repo.getMetricsForCreator(owner.community.id, stranger.creator.id)
    ).toBeNull();
  });

  it("returns null for a community that does not exist", async () => {
    const { creator } = await seedCreatorWithCommunity();
    expect(
      await repo.getMetricsForCreator("00000000-0000-4000-8000-000000000000", creator.id)
    ).toBeNull();
  });

  it("never counts another creator's members, revenue or tiers", async () => {
    const mine = await seedCreatorWithCommunity("Rina");
    const theirs = await seedCreatorWithCommunity("Budi");

    const myTier = await seedTier(mine.community.id, { name: "Mine", priceAmount: 10_000 });
    const { subscription: mySub } = await seedSubscription(myTier.id, "active");
    await seedTransaction(mySub.id, 10_000, "success");

    const theirTier = await seedTier(theirs.community.id, { name: "Theirs", priceAmount: 99_000 });
    const { subscription: theirSub } = await seedSubscription(theirTier.id, "active");
    await seedTransaction(theirSub.id, 99_000, "success");

    const metrics = await repo.getMetricsForCreator(mine.community.id, mine.creator.id);
    expect(metrics).not.toBeNull();
    expect(metrics!.members).toEqual({ active: 1, pastDue: 0, churned: 0 });
    expect(metrics!.grossRevenueAmount).toBe(10_000);
    expect(metrics!.tierDistribution).toHaveLength(1);
    expect(metrics!.tierDistribution[0]!.tierName).toBe("Mine");
  });
});

describe("DrizzleAnalyticsRepository.getMetricsForCreator — member counts", () => {
  it("reports active, past_due and churned separately", async () => {
    // `past_due` IS REPORTED SEPARATELY RATHER THAN FOLDED INTO `active`.
    // A past_due member still has channel access (they are inside their grace
    // period), so "how many people can currently see my group" is active +
    // pastDue, while "how many are paid up" is active alone. Those are two
    // different questions a creator asks, and any single number answers one of
    // them wrongly — so the repository answers neither and reports the three
    // figures it actually knows.
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);

    await seedSubscription(tier.id, "active");
    await seedSubscription(tier.id, "past_due");
    await seedSubscription(tier.id, "past_due");
    await seedSubscription(tier.id, "churned");
    await seedSubscription(tier.id, "churned");
    await seedSubscription(tier.id, "churned");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.members).toEqual({ active: 1, pastDue: 2, churned: 3 });
  });

  it("counts nobody for a status that is not a membership", async () => {
    // `pending` is an unpaid checkout, `cancelled` a member who never activated,
    // `superseded` a double-submit that was rolled into an existing membership.
    // None of the three is a member of anything, and counting any of them would
    // tell a creator they have subscribers they do not have.
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);

    await seedSubscription(tier.id, "pending");
    await seedSubscription(tier.id, "cancelled");
    await seedSubscription(tier.id, "superseded");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.members).toEqual({ active: 0, pastDue: 0, churned: 0 });
  });

  it("reports zeroes for a community with no members at all", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.members).toEqual({ active: 0, pastDue: 0, churned: 0 });
    expect(metrics!.grossRevenueAmount).toBe(0);
    expect(metrics!.tierDistribution).toEqual([]);
  });
});

describe("DrizzleAnalyticsRepository.getMetricsForCreator — gross revenue", () => {
  it("sums ONLY successful transactions", async () => {
    // A creator seeing revenue they never received is worse than seeing none.
    // Every state Phase 5 can leave behind is seeded here on purpose:
    //
    //   success              50 000 + 30 000  counted — the money arrived
    //   pending             999 999           NOT counted — an invoice nobody paid
    //   failed              888 888           NOT counted — a payment that did not go through
    //   subscription_churned rollback leftover
    //                       777 777           NOT counted — markPaid rolled the WHOLE
    //                                         statement back for a churned subscription,
    //                                         so the row is still `pending`
    //   superseded settlement
    //                        20 000           COUNTED, and this is deliberate — see the
    //                                         dedicated test below.
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);

    const active = await seedSubscription(tier.id, "active");
    await seedTransaction(active.subscription.id, 50_000, "success");
    await seedTransaction(active.subscription.id, 30_000, "success");
    await seedTransaction(active.subscription.id, 999_999, "pending");
    await seedTransaction(active.subscription.id, 888_888, "failed");

    // The `subscription_churned` outcome: markPaid throws
    // ChurnedSubscriptionRefusal and the transaction row's settlement is rolled
    // back with everything else, so what survives is a `pending` row against a
    // `churned` subscription.
    const churned = await seedSubscription(tier.id, "churned");
    await seedTransaction(churned.subscription.id, 777_777, "pending");

    const superseded = await seedSubscription(tier.id, "superseded");
    await seedTransaction(superseded.subscription.id, 20_000, "success");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.grossRevenueAmount).toBe(100_000);
  });

  it("counts a superseded settlement, because that money really arrived", async () => {
    // THE ONE PLACE THIS IMPLEMENTATION DISAGREES WITH THE PLAN'S WORDING, stated
    // here so the disagreement is a decision rather than an accident.
    //
    // The plan lists `superseded` among the "rolled-back settlements" that must not
    // be summed. It is not one. `DrizzleSubscriptionRepository.markPaid` settles the
    // TRANSACTION as `success` on that path and marks only the duplicate
    // SUBSCRIPTION `superseded` — its own comment says why: "The transaction still
    // settles: the money arrived, and hiding that hides a refund that is owed."
    // Only `subscription_churned` rolls the settlement back.
    //
    // So this figure is what the creator's Xendit statement shows, gross, which is
    // the only number a revenue total can honestly be. Excluding it would understate
    // their receipts and silently hide a refund they owe a member who paid twice.
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);
    const superseded = await seedSubscription(tier.id, "superseded");
    await seedTransaction(superseded.subscription.id, 20_000, "success");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.grossRevenueAmount).toBe(20_000);
  });

  it("reports 0 rather than null when nothing has ever been paid", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);
    const { subscription } = await seedSubscription(tier.id, "pending");
    await seedTransaction(subscription.id, 50_000, "pending");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.grossRevenueAmount).toBe(0);
  });

  it("returns an integer, never a string or a float", async () => {
    // Postgres `sum(integer)` is bigint, which the driver hands back as a STRING.
    // A dashboard that renders "1250000" concatenated onto another figure, or a
    // float that prints 1.25e6, is a money bug.
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);
    const { subscription } = await seedSubscription(tier.id, "active");
    await seedTransaction(subscription.id, 1_250_000, "success");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.grossRevenueAmount).toBe(1_250_000);
    expect(Number.isInteger(metrics!.grossRevenueAmount)).toBe(true);
  });
});

describe("DrizzleAnalyticsRepository.getMetricsForCreator — tier distribution", () => {
  it("includes a tier nobody has bought", async () => {
    // A tier with zero members is exactly what a creator needs to see: it is
    // either priced wrong or never advertised, and omitting the row hides the
    // problem instead of showing it.
    const { creator, community } = await seedCreatorWithCommunity();
    const bought = await seedTier(community.id, { name: "Basic", priceAmount: 50_000 });
    await seedTier(community.id, { name: "VIP", priceAmount: 250_000 });
    await seedSubscription(bought.id, "active");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.tierDistribution).toEqual([
      { tierId: bought.id, tierName: "Basic", priceAmount: 50_000, activeMembers: 1 },
      {
        tierId: metrics!.tierDistribution[1]!.tierId,
        tierName: "VIP",
        priceAmount: 250_000,
        activeMembers: 0,
      },
    ]);
  });

  it("counts only ACTIVE members per tier", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);
    await seedSubscription(tier.id, "active");
    await seedSubscription(tier.id, "active");
    await seedSubscription(tier.id, "past_due");
    await seedSubscription(tier.id, "churned");
    await seedSubscription(tier.id, "pending");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(metrics!.tierDistribution).toHaveLength(1);
    expect(metrics!.tierDistribution[0]!.activeMembers).toBe(2);
  });

  it("returns activeMembers as an integer", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const tier = await seedTier(community.id);
    await seedSubscription(tier.id, "active");

    const metrics = await repo.getMetricsForCreator(community.id, creator.id);
    expect(Number.isInteger(metrics!.tierDistribution[0]!.activeMembers)).toBe(true);
  });
});
