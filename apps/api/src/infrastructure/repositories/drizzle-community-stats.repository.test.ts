import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import {
  appUsers,
  communities,
  communityMembers,
  userSubscriptions,
  userTiers,
  userTransactions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityStatsRepository } from "./drizzle-community-stats.repository";

const repository = new DrizzleCommunityStatsRepository(db);

/** The September 2026 WIB month, as UTC instants. */
const SEP_FROM = new Date("2026-08-31T17:00:00.000Z");
const SEP_TO = new Date("2026-09-30T17:00:00.000Z");

let counter = 0;

async function seedUser(prefix: string) {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `${prefix}${counter}`,
      email: `${prefix}${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `${prefix} ${counter}`,
    })
    .returning();
  return user!;
}

async function seedCommunity(ownerId: string) {
  counter += 1;
  const [community] = await db
    .insert(communities)
    .values({
      ownerId,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  return community!.id;
}

async function seedTier(ownerId: string, communityId: string, name: string) {
  const [tier] = await db
    .insert(userTiers)
    .values({ ownerId, communityId, name, priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  return tier!;
}

async function seedSubscription(input: {
  subscriberId: string;
  tierId: string;
  ownerId: string;
  communityId: string;
  status: string;
}) {
  const [row] = await db.insert(userSubscriptions).values(input).returning();
  return row!;
}

async function seedTransaction(subscriptionId: string, amount: number, status: string, paidAt: Date | null) {
  await db.insert(userTransactions).values({
    userSubscriptionId: subscriptionId,
    amount,
    status,
    ...(paidAt === null ? {} : { paidAt }),
  });
}

/**
 * **ONE fixture, TWO communities under the SAME owner.**
 *
 * Every leak this codebase has had was invisible to a single-scope fixture:
 * the query looked right because there was nothing else for it to pick up.
 * The second community exists solely so a missing `community_id` predicate
 * shows up as a wrong number rather than as a passing test.
 */
async function seedTwoCommunities() {
  const owner = await seedUser("owner");
  const buyer = await seedUser("buyer");
  const other = await seedUser("other");

  const mine = await seedCommunity(owner.id);
  const theirs = await seedCommunity(owner.id);

  const mineTier = await seedTier(owner.id, mine, "Premium");
  const theirsTier = await seedTier(owner.id, theirs, "Lain");

  const mineSub = await seedSubscription({
    subscriberId: buyer.id,
    tierId: mineTier.id,
    ownerId: owner.id,
    communityId: mine,
    status: "active",
  });
  const theirsSub = await seedSubscription({
    subscriberId: other.id,
    tierId: theirsTier.id,
    ownerId: owner.id,
    communityId: theirs,
    status: "active",
  });

  return { owner, buyer, other, mine, theirs, mineTier, theirsTier, mineSub, theirsSub };
}

describe("DrizzleCommunityStatsRepository", () => {
  beforeEach(resetDatabase);

  test("revenue counts paid only, and only this community's", async () => {
    const f = await seedTwoCommunities();
    await seedTransaction(f.mineSub.id, 50_000, "paid", new Date("2026-09-10T00:00:00.000Z"));
    await seedTransaction(f.mineSub.id, 50_000, "paid", new Date("2026-09-20T00:00:00.000Z"));
    // Neither of these is revenue: one has not arrived, one never will.
    await seedTransaction(f.mineSub.id, 999_000, "pending", null);
    await seedTransaction(f.mineSub.id, 999_000, "expired", null);
    // And this one belongs to the other community.
    await seedTransaction(f.theirsSub.id, 777_000, "paid", new Date("2026-09-10T00:00:00.000Z"));

    expect(await repository.totalRevenue(f.mine)).toBe(100_000);
  });

  test("a community with no transactions has zero revenue, which is a fact not an absence", async () => {
    const f = await seedTwoCommunities();
    expect(await repository.totalRevenue(f.mine)).toBe(0);
  });

  /**
   * The three statuses in ONE fixture. Three separate ones would each let a
   * mis-categorised status through: a test that only ever creates `paid` rows
   * passes whether or not `pending` is excluded.
   */
  test("terminal counts exclude pending from BOTH sides", async () => {
    const f = await seedTwoCommunities();
    await seedTransaction(f.mineSub.id, 1, "paid", new Date("2026-09-10T00:00:00.000Z"));
    await seedTransaction(f.mineSub.id, 1, "paid", new Date("2026-09-11T00:00:00.000Z"));
    await seedTransaction(f.mineSub.id, 1, "expired", null);
    await seedTransaction(f.mineSub.id, 1, "pending", null);
    await seedTransaction(f.theirsSub.id, 1, "paid", new Date("2026-09-10T00:00:00.000Z"));

    expect(await repository.terminalTransactionCounts(f.mine)).toEqual({ paid: 2, expired: 1 });
  });

  test("lifecycle counts exclude pending subscriptions, which never had a chance to churn", async () => {
    const f = await seedTwoCommunities();
    const base = { tierId: f.mineTier.id, ownerId: f.owner.id, communityId: f.mine };
    await seedSubscription({ ...base, subscriberId: (await seedUser("a")).id, status: "cancelled" });
    await seedSubscription({ ...base, subscriberId: (await seedUser("b")).id, status: "expired" });
    await seedSubscription({ ...base, subscriberId: (await seedUser("c")).id, status: "pending" });

    // One active (from the fixture) + one cancelled + one expired = 3 ever
    // active; the pending one is in neither number.
    expect(await repository.subscriptionLifecycleCounts(f.mine)).toEqual({
      everActive: 3,
      ended: 2,
    });
  });

  test("revenue by month groups on the WIB month, not the UTC one", async () => {
    const f = await seedTwoCommunities();
    // 1 September 2026, 00:30 WIB — which is 31 AUGUST in UTC. Grouping on
    // UTC parts files this under August and it vanishes from September.
    await seedTransaction(f.mineSub.id, 25_000, "paid", new Date("2026-08-31T17:30:00.000Z"));
    await seedTransaction(f.mineSub.id, 25_000, "paid", new Date("2026-09-15T00:00:00.000Z"));

    const byMonth = await repository.revenueByWibMonth(f.mine, SEP_FROM, SEP_TO);

    expect(byMonth.get("2026-09")).toBe(50_000);
    expect(byMonth.has("2026-08")).toBe(false);
  });

  test("revenue by month is keyed on paid_at, so a June invoice settled in July is July's", async () => {
    const f = await seedTwoCommunities();
    await seedTransaction(f.mineSub.id, 30_000, "paid", new Date("2026-09-05T00:00:00.000Z"));

    const august = await repository.revenueByWibMonth(
      f.mine,
      new Date("2026-07-31T17:00:00.000Z"),
      SEP_FROM
    );

    expect(august.size).toBe(0);
  });

  test("revenue by month is SPARSE — zero-filling belongs to the caller", async () => {
    const f = await seedTwoCommunities();

    const byMonth = await repository.revenueByWibMonth(f.mine, SEP_FROM, SEP_TO);

    expect(byMonth.size).toBe(0);
  });

  /**
   * The LEFT JOIN's whole point. An INNER join hides exactly the tier an owner
   * most needs to see.
   */
  test("tier distribution includes a tier nobody has bought", async () => {
    const f = await seedTwoCommunities();
    await seedTier(f.owner.id, f.mine, "Sepi");

    const rows = await repository.tierDistribution(f.mine);

    expect(rows.map((row) => [row.name, row.subscriberCount])).toEqual([
      ["Premium", 1],
      ["Sepi", 0],
    ]);
  });

  test("tier distribution counts only ACTIVE subscriptions", async () => {
    const f = await seedTwoCommunities();
    await seedSubscription({
      subscriberId: (await seedUser("lapsed")).id,
      tierId: f.mineTier.id,
      ownerId: f.owner.id,
      communityId: f.mine,
      status: "cancelled",
    });

    const rows = await repository.tierDistribution(f.mine);

    expect(rows.map((row) => row.subscriberCount)).toEqual([1]);
  });

  test("tier distribution never shows another community's tier", async () => {
    const f = await seedTwoCommunities();

    const rows = await repository.tierDistribution(f.mine);

    expect(rows.map((row) => row.name)).toEqual(["Premium"]);
  });

  test("members joined counts this community's, inside the range only", async () => {
    const f = await seedTwoCommunities();
    const inside = await seedUser("inside");
    const before = await seedUser("before");
    const elsewhere = await seedUser("elsewhere");
    await db.insert(communityMembers).values([
      // 1 September, 00:30 WIB — inside the WIB month, August in UTC.
      { communityId: f.mine, userId: inside.id, joinedAt: new Date("2026-08-31T17:30:00.000Z") },
      // 31 August, 23:30 WIB — the last instant of the month before.
      { communityId: f.mine, userId: before.id, joinedAt: new Date("2026-08-31T16:30:00.000Z") },
      { communityId: f.theirs, userId: elsewhere.id, joinedAt: new Date("2026-09-05T00:00:00.000Z") },
    ]);

    expect(await repository.membersJoinedBetween(f.mine, SEP_FROM, SEP_TO)).toBe(1);
  });
});

describe("DrizzleCommunityStatsRepository.recentMembers", () => {
  beforeEach(resetDatabase);

  test("is newest first, with the standing fields joined in", async () => {
    const f = await seedTwoCommunities();
    const older = await seedUser("older");
    await db.insert(communityMembers).values([
      { communityId: f.mine, userId: f.buyer.id, joinedAt: new Date("2026-09-10T00:00:00.000Z") },
      { communityId: f.mine, userId: older.id, joinedAt: new Date("2026-09-01T00:00:00.000Z") },
    ]);

    const rows = await repository.recentMembers(f.mine, 5);

    expect(rows.map((row) => row.handle)).toEqual([f.buyer.handle, older.handle]);
    // The buyer holds the fixture's active subscription to THIS community.
    expect(rows[0]!.subscriptionStatus).toBe("active");
    // A member with no subscription is the COMMON case — joining is free —
    // and the LEFT join is what keeps them in their own roster.
    expect(rows[1]!.subscriptionStatus).toBeNull();
  });

  /**
   * The conflation, in query form. The subscription join is scoped to this
   * COMMUNITY, not to the owner — a member who subscribed to that person on
   * their profile has not subscribed here.
   */
  test("a subscription to another community does not count as standing here", async () => {
    const f = await seedTwoCommunities();
    await db.insert(communityMembers).values({
      communityId: f.mine,
      userId: f.other.id,
      joinedAt: new Date("2026-09-10T00:00:00.000Z"),
    });

    const rows = await repository.recentMembers(f.mine, 5);
    const other = rows.find((row) => row.handle === f.other.handle)!;

    // `other` holds an active subscription — to the OTHER community.
    expect(other.subscriptionStatus).toBeNull();
  });

  test("another community's members are absent", async () => {
    const f = await seedTwoCommunities();
    await db.insert(communityMembers).values({
      communityId: f.theirs,
      userId: f.other.id,
      joinedAt: new Date("2026-09-10T00:00:00.000Z"),
    });

    expect(await repository.recentMembers(f.mine, 5)).toEqual([]);
  });

  test("respects the limit", async () => {
    const f = await seedTwoCommunities();
    for (let i = 0; i < 4; i += 1) {
      const user = await seedUser(`m${i}`);
      await db.insert(communityMembers).values({
        communityId: f.mine,
        userId: user.id,
        joinedAt: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
      });
    }

    expect((await repository.recentMembers(f.mine, 2)).length).toBe(2);
  });
});
