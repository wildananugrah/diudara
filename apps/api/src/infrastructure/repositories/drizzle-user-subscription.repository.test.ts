import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";

beforeEach(resetDatabase);

const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

let seedCounter = 0;

/** Follows `drizzle-user-tier.repository.test.ts`'s `createUser` shape exactly. */
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

describe("DrizzleUserSubscriptionRepository", () => {
  it("creates a pending subscription and returns the row", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });

    const created = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    expect(created.subscriberId).toBe(bob.id);
    expect(created.tierId).toBe(tier.id);
    expect(created.ownerId).toBe(alice.id);
    expect(created.status).toBe("pending");
    expect(created.currentPeriodEnd).toBe(null);
  });

  it("returns null from findById for an unknown id", async () => {
    expect(await subs.findById("00000000-0000-4000-8000-000000000000")).toBe(null);
  });

  it("finds a subscription by id", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    expect(await subs.findById(created.id)).toEqual(created);
  });

  it("activates a subscription, setting status and current_period_end", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });
    const periodEnd = new Date("2026-09-18T00:00:00.000Z");

    const activated = await subs.activate(created.id, periodEnd);

    expect(activated?.status).toBe("active");
    expect(activated?.currentPeriodEnd).toEqual(periodEnd);
  });

  it("finds the active subscription for a (subscriber, owner) pair", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });
    await subs.activate(created.id, new Date("2026-09-18T00:00:00.000Z"));

    const found = await subs.findActiveFor(bob.id, alice.id);

    expect(found?.id).toBe(created.id);
  });

  it("returns null from findActiveFor when no active subscription exists", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    // Created but never activated — still 'pending'.
    await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });

    expect(await subs.findActiveFor(bob.id, alice.id)).toBe(null);
  });

  it("creates a transaction against a subscription and finds it by id", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const subscription = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    const created = await subs.createTransaction({
      userSubscriptionId: subscription.id,
      amount: 50_000,
    });

    expect(created.userSubscriptionId).toBe(subscription.id);
    expect(created.amount).toBe(50_000);
    expect(created.status).toBe("pending");
    expect(created.paidAt).toBe(null);
    expect(await subs.findTransactionById(created.id)).toEqual(created);
  });

  it("marks a transaction paid, setting status and paid_at", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const subscription = await subs.create({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });
    const transaction = await subs.createTransaction({
      userSubscriptionId: subscription.id,
      amount: 50_000,
    });
    const paidAt = new Date("2026-08-20T12:00:00.000Z");

    const paid = await subs.markTransactionPaid(transaction.id, paidAt);

    expect(paid?.status).toBe("paid");
    expect(paid?.paidAt).toEqual(paidAt);
  });

  it("REFUSES a subscription whose owner disagrees with its tier's owner", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const carol = await createUser("carol");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });

    // carol subscribing to a tier that is alice's, but claiming bob owns it.
    await expect(
      subs.create({ subscriberId: carol.id, tierId: tier.id, ownerId: bob.id }),
    ).rejects.toThrow();
  });

  it("REFUSES subscribing to yourself", async () => {
    const alice = await createUser("alice");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });

    await expect(
      subs.create({ subscriberId: alice.id, tierId: tier.id, ownerId: alice.id }),
    ).rejects.toThrow();
  });

  it("REFUSES a second ACTIVE membership to the same person, but allows one after a cancellation", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });

    const first = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(first.id, new Date("2026-09-18T00:00:00.000Z"));

    // A second active-bound subscription for the same (subscriber, owner)
    // pair, while the first is still active, must be refused.
    const second = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await expect(subs.activate(second.id, new Date("2026-09-18T00:00:00.000Z"))).rejects.toThrow();

    // Cancel the first, freeing the (subscriber, owner) pair. Proves the
    // unique index is PARTIAL — a plain unique index would keep refusing
    // forever even after cancellation.
    await subs.cancel(first.id);
    const activatedSecond = await subs.activate(second.id, new Date("2026-09-18T00:00:00.000Z"));

    expect(activatedSecond?.status).toBe("active");
  });
});
