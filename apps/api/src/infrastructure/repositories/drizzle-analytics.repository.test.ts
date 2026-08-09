import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import {
  activityLogs,
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

// ===========================================================================
// Task 3: the activity feed
// ===========================================================================

/**
 * One `activity_log` row with an EXPLICIT `created_at`, which is what makes the
 * keyset tests possible: `defaultNow()` is the TRANSACTION timestamp, so rows
 * written by one statement all share it — and sharing it is precisely the case a
 * naive `created_at < cursor` loses.
 */
async function seedActivity(
  communityId: string,
  eventType: string,
  options: { createdAt?: Date; memberId?: string | null; metadata?: unknown } = {}
) {
  const [row] = await db
    .insert(activityLogs)
    .values({
      communityId,
      eventType,
      memberId: options.memberId ?? null,
      metadata: options.metadata ?? null,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning();
  return row;
}

/** `2026-08-10T00:00:00Z` plus `seconds`, so every seeded row has a known order. */
function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 7, 10, 0, 0, seconds));
}

describe("DrizzleAnalyticsRepository.listActivityForCreator — scoping", () => {
  it("returns null for a community another creator owns", async () => {
    const owner = await seedCreatorWithCommunity("Rina");
    const stranger = await seedCreatorWithCommunity("Budi");
    await seedActivity(owner.community.id, "joined", { createdAt: at(1) });

    expect(
      await repo.listActivityForCreator(owner.community.id, stranger.creator.id, { limit: 10 })
    ).toBeNull();
  });

  it("returns null for a community that does not exist", async () => {
    const { creator } = await seedCreatorWithCommunity();
    expect(
      await repo.listActivityForCreator("00000000-0000-4000-8000-000000000000", creator.id, {
        limit: 10,
      })
    ).toBeNull();
  });

  it("never returns another community's rows", async () => {
    const mine = await seedCreatorWithCommunity("Rina");
    const theirs = await seedCreatorWithCommunity("Budi");
    const mineRow = await seedActivity(mine.community.id, "joined", { createdAt: at(1) });
    await seedActivity(theirs.community.id, "joined", { createdAt: at(2) });

    const rows = await repo.listActivityForCreator(mine.community.id, mine.creator.id, {
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows![0]!.id).toBe(mineRow.id);
  });
});

describe("DrizzleAnalyticsRepository.listActivityForCreator — the allowlist", () => {
  it("produces exactly ONE row for one reminder, not two", async () => {
    // THE TRAP. `ProcessRenewals` writes `renewal_reminder_queued` when it claims the
    // stage and `SendRenewalReminder` writes `renewal_reminder_sent` when the message
    // reaches the provider. One reminder, two rows, and only the second means the
    // member was told. A feed that shows both doubles every reminder figure, and
    // nobody notices until a creator counts by hand.
    const { creator, community } = await seedCreatorWithCommunity();
    const member = await seedMember();
    await seedActivity(community.id, "renewal_reminder_queued", {
      createdAt: at(1),
      memberId: member.id,
      metadata: { stage: "pre_3d" },
    });
    await seedActivity(community.id, "renewal_reminder_sent", {
      createdAt: at(2),
      memberId: member.id,
      metadata: { stage: "pre_3d" },
    });

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows![0]!.eventType).toBe("renewal_reminder_sent");
  });

  it("returns no internal diagnostics at all", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    for (const [index, hidden] of [
      "renewal_reminder_queued",
      "renewal_reminder_skipped",
      "renewal_reminder_not_sent",
      "access_not_granted",
      "access_not_revoked",
      "churn_revoke_skipped",
    ].entries()) {
      await seedActivity(community.id, hidden, { createdAt: at(index + 1) });
    }

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 50 });
    expect(rows).toEqual([]);
  });

  it("returns the six ordinary events and the two warnings", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const visible = [
      "joined",
      "renewed",
      "churned",
      "renewal_reminder_sent",
      "channel_access_granted",
      "channel_access_revoked",
      "access_manual_required",
      "revocation_manual_required",
    ];
    for (const [index, eventType] of visible.entries()) {
      await seedActivity(community.id, eventType, { createdAt: at(index + 1) });
    }

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 50 });
    expect([...rows!].map((row) => row.eventType).sort()).toEqual([...visible].sort());
  });

  it("keeps `renewed` distinct from `joined`", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    await seedActivity(community.id, "renewed", { createdAt: at(1) });

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows![0]!.eventType).toBe("renewed");
    expect(rows![0]!.eventType).not.toBe("joined");
  });
});

describe("DrizzleAnalyticsRepository.listActivityForCreator — ordering and the member join", () => {
  it("returns newest first", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const oldest = await seedActivity(community.id, "joined", { createdAt: at(1) });
    const middle = await seedActivity(community.id, "renewed", { createdAt: at(2) });
    const newest = await seedActivity(community.id, "churned", { createdAt: at(3) });

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 10 });
    expect(rows!.map((row) => row.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it("carries the member's name but never their WhatsApp number", async () => {
    // The feed is creator-facing and authenticated, so a name is useful. A WhatsApp
    // number is personal data with one legitimate destination (the CSV export, which
    // the creator asks for deliberately) and no business being in a screen that is
    // open all day.
    const { creator, community } = await seedCreatorWithCommunity();
    const member = await seedMember("Siti Aminah");
    await seedActivity(community.id, "joined", { createdAt: at(1), memberId: member.id });

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 10 });
    expect(rows![0]!.memberId).toBe(member.id);
    expect(rows![0]!.memberName).toBe("Siti Aminah");
    expect(JSON.stringify(rows![0])).not.toContain(member.whatsappNumber);
  });

  it("handles a community-scoped row with no member attached", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    await seedActivity(community.id, "joined", { createdAt: at(1), memberId: null });

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 10 });
    expect(rows![0]!.memberId).toBeNull();
    expect(rows![0]!.memberName).toBeNull();
  });
});

describe("DrizzleAnalyticsRepository.listActivityForCreator — keyset pagination", () => {
  it("honours the limit", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    for (let i = 1; i <= 5; i++) {
      await seedActivity(community.id, "joined", { createdAt: at(i) });
    }

    const rows = await repo.listActivityForCreator(community.id, creator.id, { limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("skips and duplicates nothing when a row is inserted between page 1 and page 2", async () => {
    // WHY KEYSET AND NOT OFFSET. The feed is append-heavy: a payment, a reminder or a
    // revocation can land between two "load more" clicks. With `offset 2` the newly
    // prepended row pushes everything down one, so page 2 REPEATS the last row of
    // page 1 and the reader never sees one of the originals. A cursor anchored on the
    // row itself cannot drift.
    const { creator, community } = await seedCreatorWithCommunity();
    const seeded = [];
    for (let i = 1; i <= 5; i++) {
      seeded.push(await seedActivity(community.id, "joined", { createdAt: at(i) }));
    }
    const newestFirst = [...seeded].reverse().map((row) => row.id);

    const page1 = await repo.listActivityForCreator(community.id, creator.id, { limit: 2 });
    expect(page1!.map((row) => row.id)).toEqual(newestFirst.slice(0, 2));

    // A payment settles while the creator is reading.
    const interloper = await seedActivity(community.id, "joined", { createdAt: at(99) });

    const last = page1![page1!.length - 1]!;
    const page2 = await repo.listActivityForCreator(community.id, creator.id, {
      limit: 2,
      before: { createdAt: last.createdAt, id: last.id },
    });

    expect(page2!.map((row) => row.id)).toEqual(newestFirst.slice(2, 4));

    const seen = [...page1!, ...page2!].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(interloper.id);
  });

  it("loses nothing when several rows share one created_at", async () => {
    // `created_at` defaults to `now()`, which is the TRANSACTION timestamp — so every
    // row a single transaction writes has the SAME value. `created_at < cursor` alone
    // silently drops the boundary row's ties; `(created_at, id) < (cursor, cursorId)`
    // does not. Four rows, one timestamp, two pages of two.
    const { creator, community } = await seedCreatorWithCommunity();
    const shared = at(7);
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await seedActivity(community.id, "joined", { createdAt: shared })).id);
    }

    const page1 = await repo.listActivityForCreator(community.id, creator.id, { limit: 2 });
    const last = page1![1]!;
    const page2 = await repo.listActivityForCreator(community.id, creator.id, {
      limit: 2,
      before: { createdAt: last.createdAt, id: last.id },
    });

    const seen = [...page1!, ...page2!].map((row) => row.id);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("returns an empty page rather than null once the feed is exhausted", async () => {
    // `null` means "not your community". An exhausted feed is a different answer and
    // must not become a 404 on the last "load more" click.
    const { creator, community } = await seedCreatorWithCommunity();
    const only = await seedActivity(community.id, "joined", { createdAt: at(1) });

    const page2 = await repo.listActivityForCreator(community.id, creator.id, {
      limit: 10,
      before: { createdAt: only.createdAt, id: only.id },
    });
    expect(page2).toEqual([]);
  });
});
