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
import type { MarkPaidResult } from "../../application/ports/subscription-repository.port";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";

beforeEach(resetDatabase);

const repo = new DrizzleSubscriptionRepository(db);

/**
 * `markPaid`, asserting it actually settled. It returns null for a transaction
 * that is no longer `pending` (see the port's contract), so the tests that are
 * about a SUCCESSFUL activation go through here and the ones that are about the
 * no-op call `repo.markPaid` directly.
 */
async function settle(input: {
  transactionId: string;
  gatewayReferenceId: string;
  paidAt: Date;
}): Promise<MarkPaidResult> {
  const result = await repo.markPaid(input);
  if (result === null) {
    throw new Error(`settle: markPaid returned null for transaction ${input.transactionId}`);
  }
  return result;
}

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

    const result = await settle({
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

    const result = await settle({
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

      const result = await settle({
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

    const result = await settle({
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
    // A later renewal must not rewrite the membership's start date — churn
    // timing in spec 8.3 is measured from it. A renewal is a NEW transaction row
    // against the same subscription, which is why this no longer settles the same
    // transaction twice: that path is now a no-op by design (see below).
    const { subscription, transaction } = await seedPendingCheckout();
    const firstPaidAt = new Date("2026-08-09T10:00:00Z");
    const secondPaidAt = new Date("2026-09-09T10:00:00Z");

    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv_xendit_1",
      paidAt: firstPaidAt,
    });

    const renewal = await repo.createTransaction({
      subscriptionId: subscription.id,
      amount: 50000,
      paymentMethod: "invoice",
    });
    const second = await settle({
      transactionId: renewal.id,
      gatewayReferenceId: "inv_xendit_2",
      paidAt: secondPaidAt,
    });

    expect(second.subscription.startedAt?.toISOString()).toBe(firstPaidAt.toISOString());
    expect(second.subscription.nextBillingDate).toBe("2026-10-09");
  });

  /**
   * I2(b), final whole-branch review. `provider_event_id` is the first line of
   * replay defence and it derives from the provider's `body.id`, so two
   * deliveries that differ in that field walk straight past it. Probed before
   * this predicate existed: 12 concurrent PAID deliveries with 12 distinct
   * `body.id` values produced 12 `activity_log` "joined" rows — 12 WhatsApp
   * invites in Phase 4.
   */
  describe("settling a transaction that is no longer pending", () => {
    it("is a no-op that returns null, not a second activation", async () => {
      const { transaction } = await seedPendingCheckout();
      const firstPaidAt = new Date("2026-08-09T10:00:00Z");

      await settle({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: firstPaidAt,
      });

      expect(
        await repo.markPaid({
          transactionId: transaction.id,
          gatewayReferenceId: "inv_xendit_ATTACKER",
          paidAt: new Date("2026-09-09T10:00:00Z"),
        })
      ).toBeNull();
    });

    it("leaves paid_at and the gateway reference exactly as the first settlement left them", async () => {
      const { subscription, transaction } = await seedPendingCheckout();
      const firstPaidAt = new Date("2026-08-09T10:00:00Z");

      await settle({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: firstPaidAt,
      });
      await repo.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_ATTACKER",
        paidAt: new Date("2026-09-09T10:00:00Z"),
      });

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
      expect(tx.gatewayReferenceId).toBe("inv_xendit_1");
      expect(tx.paidAt?.toISOString()).toBe(firstPaidAt.toISOString());

      // And the subscription's next_billing_date was not pushed a month out by a
      // replay, which is a month of free access.
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscription.id));
      expect(sub.nextBillingDate).toBe("2026-09-09");
    });

    it("lets exactly ONE of several concurrent settlements win", async () => {
      const { transaction } = await seedPendingCheckout();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo.markPaid({
            transactionId: transaction.id,
            gatewayReferenceId: `inv_xendit_${i}`,
            paidAt: new Date("2026-08-09T10:00:00Z"),
          })
        )
      );

      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });
  });

  describe("attachGatewayReference", () => {
    it("records the provider's invoice id and bumps updated_at", async () => {
      const { transaction } = await seedPendingCheckout();
      expect(transaction.gatewayReferenceId).toBeNull();
      await Bun.sleep(25);

      expect(await repo.attachGatewayReference(transaction.id, "inv_xendit_1")).toBe(true);

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
      expect(tx.gatewayReferenceId).toBe("inv_xendit_1");
      expect(tx.updatedAt.getTime()).toBeGreaterThan(tx.createdAt.getTime());
    });

    it("refuses to overwrite a reference that is already recorded", async () => {
      // This column is the anchor the whole replay defence hangs from. Letting a
      // second write move it would let a forged invoice id become "our record".
      const { transaction } = await seedPendingCheckout();
      expect(await repo.attachGatewayReference(transaction.id, "inv_xendit_1")).toBe(true);

      expect(await repo.attachGatewayReference(transaction.id, "inv_ATTACKER")).toBe(false);

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
      expect(tx.gatewayReferenceId).toBe("inv_xendit_1");
    });

    it("reports a miss for an unknown id, and for one that is not a uuid at all", async () => {
      await seedPendingCheckout();
      expect(
        await repo.attachGatewayReference("00000000-0000-0000-0000-000000000000", "inv_1")
      ).toBe(false);
      for (const notAUuid of ["haxx", "", "1 OR 1=1"]) {
        expect(await repo.attachGatewayReference(notAUuid, "inv_1")).toBe(false);
      }
    });
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
