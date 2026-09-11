import { describe, expect, test, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./client";
import { appUsers, communities, communityDocuments, userTiers } from "./schema";
import { resetDatabase } from "./test-helpers";

let counter = 0;

async function seedCommunity() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `seller${counter}`,
      email: `seller${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Seller ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: user!.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  return { user: user!, communityId: community!.id };
}

describe("user_tier.community_id", () => {
  beforeEach(resetDatabase);

  /**
   * The additive half: every row that existed before this column is a personal
   * tier, and a tier created without naming a community still is one.
   */
  test("defaults to null, which is a personal tier", async () => {
    const { user } = await seedCommunity();

    const [tier] = await db
      .insert(userTiers)
      .values({ ownerId: user.id, name: "Pendukung", priceAmount: 50_000, billingCycle: "monthly" })
      .returning();

    expect(tier!.communityId).toBeNull();
  });

  test("a community tier carries the community it belongs to", async () => {
    const { user, communityId } = await seedCommunity();

    const [tier] = await db
      .insert(userTiers)
      .values({
        ownerId: user.id,
        communityId,
        name: "Anggota Premium",
        priceAmount: 99_000,
        billingCycle: "monthly",
      })
      .returning();

    expect(tier!.communityId).toBe(communityId);
  });

  /**
   * The separation the two offer endpoints depend on, asserted from ONE
   * fixture holding both kinds — two tests that each created one kind would
   * both pass while the filter was missing.
   */
  test("the two kinds are separable by the column alone", async () => {
    const { user, communityId } = await seedCommunity();
    const base = { ownerId: user.id, priceAmount: 10_000, billingCycle: "monthly" as const };
    await db.insert(userTiers).values([
      { ...base, name: "Pribadi" },
      { ...base, name: "Komunitas", communityId },
    ]);

    const personal = await db
      .select({ name: userTiers.name })
      .from(userTiers)
      .where(and(eq(userTiers.ownerId, user.id), isNull(userTiers.communityId)));
    const community = await db
      .select({ name: userTiers.name })
      .from(userTiers)
      .where(eq(userTiers.communityId, communityId));

    expect(personal.map((row) => row.name)).toEqual(["Pribadi"]);
    expect(community.map((row) => row.name)).toEqual(["Komunitas"]);
  });
});

describe("community_document.members_only", () => {
  beforeEach(resetDatabase);

  /** Additive: every document uploaded before this phase stays as readable as it was. */
  test("defaults to false", async () => {
    const { user, communityId } = await seedCommunity();

    const [row] = await db
      .insert(communityDocuments)
      .values({
        communityId,
        uploaderId: user.id,
        name: "Terbuka.pdf",
        contentType: "application/pdf",
        byteSize: 1,
      })
      .returning();

    expect(row!.membersOnly).toBe(false);
  });

  test("can be set at upload", async () => {
    const { user, communityId } = await seedCommunity();

    const [row] = await db
      .insert(communityDocuments)
      .values({
        communityId,
        uploaderId: user.id,
        name: "Khusus.pdf",
        contentType: "application/pdf",
        byteSize: 1,
        membersOnly: true,
      })
      .returning();

    expect(row!.membersOnly).toBe(true);
  });
});
