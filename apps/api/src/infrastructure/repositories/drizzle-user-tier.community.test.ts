import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, communities } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";

const repository = new DrizzleUserTierRepository(db);

let counter = 0;

/**
 * ONE owner holding BOTH kinds of tier. Every test below reads from this same
 * fixture, because two fixtures that each seeded one kind would both pass
 * while the filter that separates them was missing — the shape Phase 2
 * recorded when a `deleted_at` filter was present on three read paths and
 * absent on the fourth.
 */
async function seedBothKinds() {
  counter += 1;
  const [owner] = await db
    .insert(appUsers)
    .values({
      handle: `tierowner${counter}`,
      email: `tierowner${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Tier Owner ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: owner!.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();

  const personal = await repository.create({
    ownerId: owner!.id,
    name: "Pendukung",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const communityTier = await repository.create({
    ownerId: owner!.id,
    communityId: community!.id,
    name: "Premium",
    priceAmount: 99_000,
    billingCycle: "monthly",
  });
  return { owner: owner!, communityId: community!.id, personal, communityTier };
}

describe("the two kinds of tier never leak into each other's listing", () => {
  beforeEach(resetDatabase);

  test("create records which community a tier belongs to, or none", async () => {
    const { communityId, personal, communityTier } = await seedBothKinds();

    expect(personal.communityId).toBeNull();
    expect(communityTier.communityId).toBe(communityId);
  });

  /**
   * A personal profile shows personal tiers. A community tier appearing on its
   * owner's profile would offer a stranger a membership to a community they
   * are looking at no page for.
   */
  test.each([
    ["listByOwner", (ownerId: string) => repository.listByOwner(ownerId)],
    ["listActiveByOwner", (ownerId: string) => repository.listActiveByOwner(ownerId)],
  ])("%s returns only the personal tier", async (_label, read) => {
    const { owner } = await seedBothKinds();

    const rows = await read(owner.id);

    // Compare NAMES, never rows: a failing assertion holding a row serialises
    // everything joined to it.
    expect(rows.map((row) => row.name)).toEqual(["Pendukung"]);
  });

  test("listActiveByCommunity returns only that community's tier", async () => {
    const { communityId } = await seedBothKinds();

    const rows = await repository.listActiveByCommunity(communityId);

    expect(rows.map((row) => row.name)).toEqual(["Premium"]);
  });

  test("another community's tiers are not in it", async () => {
    const first = await seedBothKinds();
    const second = await seedBothKinds();

    const rows = await repository.listActiveByCommunity(first.communityId);

    expect(rows.map((row) => row.id)).toEqual([first.communityTier.id]);
    expect(rows.map((row) => row.id)).not.toContain(second.communityTier.id);
  });

  test("a deactivated community tier leaves the offer but stays findable", async () => {
    const { communityId, communityTier } = await seedBothKinds();

    await repository.deactivate(communityTier.id);

    expect(await repository.listActiveByCommunity(communityId)).toEqual([]);
    // Still resolvable by id — an existing subscription to it must keep
    // working, which is why `deactivate` flips a flag rather than deleting.
    expect((await repository.findById(communityTier.id))?.isActive).toBe(false);
  });
});
