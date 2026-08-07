import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { creators, communities, membershipTiers } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("core schema round-trip", () => {
  it("persists and reads back a creator, community, and membership tier", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", whatsappNumber: "+6281111111111", tierPlan: "starter" })
      .returning();

    const [community] = await db
      .insert(communities)
      .values({
        creatorId: creator.id,
        name: "Kelas Bimbel Budi",
        slug: "kelas-bimbel-budi",
        niche: "bimbel",
      })
      .returning();

    const [tier] = await db
      .insert(membershipTiers)
      .values({
        communityId: community.id,
        name: "Basic",
        priceAmount: 50000,
        billingCycle: "monthly",
      })
      .returning();

    const [found] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, tier.id));

    expect(found.name).toBe("Basic");
    expect(found.communityId).toBe(community.id);
    expect(found.isActive).toBe(true);
  });
});
