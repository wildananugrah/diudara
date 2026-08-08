import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMembershipTierRepository } from "./drizzle-membership-tier.repository";

beforeEach(resetDatabase);

async function makeCommunity(slug: string) {
  const [creator] = await db
    .insert(creators)
    .values({ name: "C", email: `${slug}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: slug, slug })
    .returning();
  return community;
}

const TIER = { name: "Basic", priceAmount: 50000, billingCycle: "monthly" };

describe("DrizzleMembershipTierRepository", () => {
  it("creates a tier with the schema's defaults applied", async () => {
    const repository = new DrizzleMembershipTierRepository(db);
    const community = await makeCommunity("kelas-a");

    const created = await repository.create({ communityId: community.id, ...TIER });

    expect(created.communityId).toBe(community.id);
    expect(created.name).toBe("Basic");
    expect(created.priceAmount).toBe(50000);
    expect(created.billingCycle).toBe("monthly");
    expect(created.isActive).toBe(true);
  });

  it("lists only the requested community's tiers", async () => {
    const repository = new DrizzleMembershipTierRepository(db);
    const a = await makeCommunity("kelas-a");
    const b = await makeCommunity("kelas-b");

    await repository.create({ communityId: a.id, ...TIER, name: "In A" });
    await repository.create({ communityId: b.id, ...TIER, name: "In B" });

    const listed = await repository.listByCommunity(a.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("In A");
  });

  it("updates a tier that belongs to the given community", async () => {
    const repository = new DrizzleMembershipTierRepository(db);
    const community = await makeCommunity("kelas-a");
    const tier = await repository.create({ communityId: community.id, ...TIER });

    const updated = await repository.updateForCommunity(tier.id, community.id, {
      priceAmount: 75000,
      isActive: false,
    });

    expect(updated).not.toBeNull();
    expect(updated!.priceAmount).toBe(75000);
    expect(updated!.isActive).toBe(false);
  });

  it("refuses to update a tier belonging to a different community", async () => {
    // This is the case the SQL scoping clause exists for. Removing
    // `eq(membershipTiers.communityId, communityId)` from updateForCommunity's
    // WHERE previously left the ENTIRE suite green: every route test that could
    // have reached here was stopped earlier by the community ownership check.
    const repository = new DrizzleMembershipTierRepository(db);
    const a = await makeCommunity("kelas-a");
    const b = await makeCommunity("kelas-b");
    const tierInB = await repository.create({ communityId: b.id, ...TIER });

    const result = await repository.updateForCommunity(tierInB.id, a.id, {
      name: "Dibajak",
      priceAmount: 1,
    });

    expect(result).toBeNull();

    // The row must be unchanged, not merely unreported.
    const stillInB = await repository.listByCommunity(b.id);
    expect(stillInB).toHaveLength(1);
    expect(stillInB[0].name).toBe(TIER.name);
    expect(stillInB[0].priceAmount).toBe(TIER.priceAmount);
  });

  it("returns null for a tier id that does not exist", async () => {
    const repository = new DrizzleMembershipTierRepository(db);
    const community = await makeCommunity("kelas-a");

    const result = await repository.updateForCommunity(
      "00000000-0000-4000-8000-000000000000",
      community.id,
      { name: "Nope" }
    );

    expect(result).toBeNull();
  });
});
