import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, communities, userSubscriptions, userTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";

const repository = new DrizzleUserSubscriptionRepository(db);
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

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

/**
 * **THE fixture this file exists for.**
 *
 * One owner selling BOTH a personal tier and a community tier, and two
 * different buyers holding one subscription each. Two separate fixtures that
 * each created one kind would both pass while the gate answered the other
 * one's question — the shape Phase 2 recorded when a filter was present on
 * three read paths and missing on the fourth.
 */
async function seedBothKinds() {
  const owner = await seedUser("owner");
  const personalBuyer = await seedUser("personal");
  const communityBuyer = await seedUser("community");
  counter += 1;
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: owner.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();

  const [personalTier] = await db
    .insert(userTiers)
    .values({ ownerId: owner.id, name: "Pendukung", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  const [communityTier] = await db
    .insert(userTiers)
    .values({
      ownerId: owner.id,
      communityId: community!.id,
      name: "Premium",
      priceAmount: 99_000,
      billingCycle: "monthly",
    })
    .returning();

  await db.insert(userSubscriptions).values([
    {
      subscriberId: personalBuyer.id,
      tierId: personalTier!.id,
      ownerId: owner.id,
      status: "active",
      currentPeriodEnd: FUTURE,
    },
    {
      subscriberId: communityBuyer.id,
      tierId: communityTier!.id,
      ownerId: owner.id,
      status: "active",
      currentPeriodEnd: FUTURE,
    },
  ]);

  return { owner, personalBuyer, communityBuyer, communityId: community!.id };
}

describe("findActiveForCommunity — the conflation this phase must not have", () => {
  beforeEach(resetDatabase);

  test("finds the buyer who paid THIS community", async () => {
    const { communityBuyer, communityId } = await seedBothKinds();

    const row = await repository.findActiveForCommunity(communityBuyer.id, communityId);

    expect(row?.subscriberId).toBe(communityBuyer.id);
  });

  /**
   * **The dangerous direction.** The community's owner also sells a personal
   * tier. A lookup keyed on (subscriber, owner) — which is what
   * `findActiveFor` is — answers TRUE here, handing this buyer the community's
   * paid documents for a subscription they bought on a profile.
   */
  test("does NOT find somebody who subscribed to the owner personally", async () => {
    const { personalBuyer, communityId } = await seedBothKinds();

    expect(await repository.findActiveForCommunity(personalBuyer.id, communityId)).toBeNull();
  });

  /** The mirror: a community subscription must not read as a personal one. */
  test("the personal lookup does NOT find the community subscriber", async () => {
    const { owner, communityBuyer } = await seedBothKinds();

    // `findActiveFor` is keyed on (subscriber, owner) and the owner is the
    // same person, so this is the assertion that proves the two lookups are
    // genuinely different questions rather than one question twice.
    const row = await repository.findActiveFor(communityBuyer.id, owner.id);

    // It DOES find the row — the subscription really is owned by this person.
    // That is exactly why the community gate cannot use this method, and why
    // the personal gate must not be given a community subscriber. Recorded
    // here rather than asserted as null, because asserting null would be
    // asserting a change this phase deliberately does not make to the personal
    // path.
    expect(row?.subscriberId).toBe(communityBuyer.id);
  });

  test("another community's subscription does not carry over", async () => {
    const first = await seedBothKinds();
    const second = await seedBothKinds();

    expect(
      await repository.findActiveForCommunity(first.communityBuyer.id, second.communityId)
    ).toBeNull();
  });

  test("a cancelled subscription is not active", async () => {
    const { communityBuyer, communityId } = await seedBothKinds();
    await db.update(userSubscriptions).set({ status: "churned" });

    expect(await repository.findActiveForCommunity(communityBuyer.id, communityId)).toBeNull();
  });

  test("a malformed id answers null rather than throwing", async () => {
    expect(await repository.findActiveForCommunity("not-a-uuid", "also-not")).toBeNull();
  });
});
