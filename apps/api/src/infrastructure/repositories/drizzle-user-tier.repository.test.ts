import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";

beforeEach(resetDatabase);

const repo = new DrizzleUserTierRepository(db);

let seedCounter = 0;

/** Follows `drizzle-media.repository.test.ts`'s `createUser` shape exactly. */
async function createUser(handle: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

describe("DrizzleUserTierRepository", () => {
  it("creates a tier and returns the row", async () => {
    const owner = await createUser("wildan");

    const created = await repo.create({
      ownerId: owner.id,
      name: "Supporter",
      priceAmount: 25_000,
      billingCycle: "monthly",
    });

    expect(created.ownerId).toBe(owner.id);
    expect(created.name).toBe("Supporter");
    expect(created.priceAmount).toBe(25_000);
    expect(created.billingCycle).toBe("monthly");
    expect(created.isActive).toBe(true);
  });

  it("lists only the given owner's tiers, active ones before deactivated ones", async () => {
    const owner = await createUser("wildan");
    const other = await createUser("someone-else");
    const active = await repo.create({
      ownerId: owner.id,
      name: "Fan",
      priceAmount: 10_000,
      billingCycle: "monthly",
    });
    const toDeactivate = await repo.create({
      ownerId: owner.id,
      name: "VIP",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    await repo.deactivate(toDeactivate.id);
    await repo.create({
      ownerId: other.id,
      name: "Not mine",
      priceAmount: 15_000,
      billingCycle: "monthly",
    });

    const rows = await repo.listByOwner(owner.id);

    expect(rows.map((r) => r.id)).toEqual([active.id, toDeactivate.id]);
    expect(rows.every((r) => r.ownerId === owner.id)).toBe(true);
  });

  it("excludes deactivated tiers from listActiveByOwner", async () => {
    const owner = await createUser("wildan");
    const active = await repo.create({
      ownerId: owner.id,
      name: "Fan",
      priceAmount: 10_000,
      billingCycle: "monthly",
    });
    const deactivated = await repo.create({
      ownerId: owner.id,
      name: "VIP",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    await repo.deactivate(deactivated.id);

    const rows = await repo.listActiveByOwner(owner.id);

    expect(rows.map((r) => r.id)).toEqual([active.id]);
  });

  it("returns null from findById for an unknown id", async () => {
    expect(await repo.findById("00000000-0000-4000-8000-000000000000")).toBe(null);
  });

  it("finds a tier by id", async () => {
    const owner = await createUser("wildan");
    const created = await repo.create({
      ownerId: owner.id,
      name: "Supporter",
      priceAmount: 25_000,
      billingCycle: "monthly",
    });

    expect(await repo.findById(created.id)).toEqual(created);
  });

  /**
   * `deactivate` must flip `is_active` in place, not delete — subscriptions
   * to a deactivated tier keep working per the spec's §4, and a delete would
   * leave nothing for such a subscription's foreign key to point at.
   */
  it("flips is_active without deleting the row", async () => {
    const owner = await createUser("wildan");
    const created = await repo.create({
      ownerId: owner.id,
      name: "Supporter",
      priceAmount: 25_000,
      billingCycle: "monthly",
    });

    const deactivated = await repo.deactivate(created.id);

    expect(deactivated?.isActive).toBe(false);
    const found = await repo.findById(created.id);
    expect(found).not.toBe(null);
    expect(found?.isActive).toBe(false);
  });

  it("returns null from deactivate for an unknown id", async () => {
    expect(await repo.deactivate("00000000-0000-4000-8000-000000000000")).toBe(null);
  });
});
