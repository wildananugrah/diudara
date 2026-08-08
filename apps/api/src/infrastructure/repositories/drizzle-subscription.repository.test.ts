import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
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
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";

beforeEach(resetDatabase);

const repo = new DrizzleSubscriptionRepository(db);

let seedCounter = 0;

/**
 * A creator → community → tier → member → pending subscription → pending
 * transaction chain, i.e. exactly what `StartCheckout` leaves behind.
 */
async function seedPendingCheckout(
  billingCycle: "monthly" | "quarterly" | "yearly" = "monthly",
  amount = 50000
) {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-rina-${seedCounter}` })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId: community.id, name: "Basic", priceAmount: amount, billingCycle })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62810000${String(seedCounter).padStart(4, "0")}`, name: "Siti" })
    .returning();
  const subscription = await repo.createPending({ memberId: member.id, tierId: tier.id });
  const transaction = await repo.createTransaction({
    subscriptionId: subscription.id,
    amount,
    paymentMethod: "invoice",
  });
  return { creator, community, tier, member, subscription, transaction };
}

describe("DrizzleSubscriptionRepository.findTransactionByExternalId", () => {
  it("returns the transaction we recorded, with OUR amount", async () => {
    const { transaction } = await seedPendingCheckout("monthly", 50000);

    const found = await repo.findTransactionByExternalId(transaction.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(transaction.id);
    // The whole point: the webhook compares against this, never against the body.
    expect(found!.amount).toBe(50000);
    expect(found!.status).toBe("pending");
    expect(found!.paidAt).toBeNull();
  });

  it("returns null for an unknown id rather than throwing", async () => {
    await seedPendingCheckout();
    expect(
      await repo.findTransactionByExternalId("00000000-0000-0000-0000-000000000000")
    ).toBeNull();
  });

  it("returns null for a value that is not a uuid at all", async () => {
    // `transaction.id` is a uuid column, so a forged webhook carrying
    // `external_id: "haxx"` would make Postgres raise `invalid input syntax for
    // type uuid` — a 500 plus a driver error on the unhandled-error path,
    // instead of the 404 an unknown external id deserves.
    await seedPendingCheckout();
    for (const notAUuid of ["haxx", "", "0000", "not-a-uuid-at-all", "1 OR 1=1"]) {
      expect(await repo.findTransactionByExternalId(notAUuid)).toBeNull();
    }
  });
});

describe("DrizzleSubscriptionRepository.markPaid", () => {
  it("marks the transaction success and activates its subscription", async () => {
    const { subscription, transaction } = await seedPendingCheckout();
    const paidAt = new Date("2026-08-09T10:00:00Z");

    const result = await repo.markPaid({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt,
    });

    expect(result.transaction.status).toBe("success");
    expect(result.transaction.gatewayReferenceId).toBe("inv_xendit_1");
    expect(result.transaction.paidAt?.toISOString()).toBe(paidAt.toISOString());
    expect(result.subscription.id).toBe(subscription.id);
    expect(result.subscription.status).toBe("active");
    expect(result.subscription.startedAt?.toISOString()).toBe(paidAt.toISOString());
  });

  it("returns the community id the activation belongs to, for the audit entry", async () => {
    const { community, transaction } = await seedPendingCheckout();

    const result = await repo.markPaid({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt: new Date(),
    });

    expect(result.communityId).toBe(community.id);
  });

  it("computes next_billing_date from the tier's billing cycle", async () => {
    const paidAt = new Date("2026-08-09T10:00:00Z");
    const expected = {
      monthly: "2026-09-09",
      quarterly: "2026-11-09",
      yearly: "2027-08-09",
    } as const;

    for (const cycle of ["monthly", "quarterly", "yearly"] as const) {
      await resetDatabase();
      const { transaction } = await seedPendingCheckout(cycle);

      const result = await repo.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt,
      });

      expect(result.subscription.nextBillingDate).toBe(expected[cycle]);
    }
  });

  it("moves updated_at past created_at on BOTH rows", async () => {
    // Neither column has a BEFORE UPDATE trigger behind it (drizzle-kit does not
    // generate triggers and the migration constraint forbids hand-written SQL),
    // so `updatedAt: new Date()` has to be passed explicitly or the column
    // freezes at creation time and looks like nothing ever happened.
    const { transaction } = await seedPendingCheckout();
    await Bun.sleep(25);

    const result = await repo.markPaid({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt: new Date(),
    });

    expect(result.transaction.updatedAt.getTime()).toBeGreaterThan(
      result.transaction.createdAt.getTime()
    );
    expect(result.subscription.updatedAt.getTime()).toBeGreaterThan(
      result.subscription.createdAt.getTime()
    );
  });

  it("keeps the ORIGINAL started_at when the subscription is already active", async () => {
    // A later renewal (or a second PAID event that got past the replay guard on
    // a different event id) must not rewrite the membership's start date —
    // churn timing in spec 8.3 is measured from it.
    const { transaction } = await seedPendingCheckout();
    const firstPaidAt = new Date("2026-08-09T10:00:00Z");
    const secondPaidAt = new Date("2026-09-09T10:00:00Z");

    await repo.markPaid({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt: firstPaidAt,
    });
    const second = await repo.markPaid({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt: secondPaidAt,
    });

    expect(second.subscription.startedAt?.toISOString()).toBe(firstPaidAt.toISOString());
    expect(second.subscription.nextBillingDate).toBe("2026-10-09");
  });

  it("throws for an unknown transaction id and changes nothing", async () => {
    const { subscription } = await seedPendingCheckout();

    await expect(
      repo.markPaid({
        transactionId: "00000000-0000-0000-0000-000000000000",
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date(),
      })
    ).rejects.toThrow(/not found/);

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id));
    expect(row.status).toBe("pending");
  });

  it("leaves the transaction untouched when the subscription's tier is unusable", async () => {
    // Both writes live in ONE database transaction, so a failure resolving the
    // tier's billing cycle must not leave money marked collected against a
    // subscription that never activated.
    const { transaction, tier } = await seedPendingCheckout();
    await db
      .update(membershipTiers)
      .set({ billingCycle: "weekly" })
      .where(eq(membershipTiers.id, tier.id));

    await expect(
      repo.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date(),
      })
    ).rejects.toThrow(/billing cycle/i);

    const [row] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, transaction.id));
    expect(row.status).toBe("pending");
    expect(row.paidAt).toBeNull();
  });
});
