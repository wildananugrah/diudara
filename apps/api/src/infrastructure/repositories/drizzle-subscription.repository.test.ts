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
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";

beforeEach(resetDatabase);

const repo = new DrizzleSubscriptionRepository(db);

/**
 * `markPaid`, asserting it actually settled. It reports a non-`activated` outcome
 * for a transaction that is no longer `pending` (see `MarkPaidOutcome`), so the
 * tests that are about a SUCCESSFUL activation go through here and the ones about
 * the no-op call `repo.markPaid` directly and inspect the outcome.
 */
async function settle(input: {
  transactionId: string;
  gatewayReferenceId: string;
  paidAt: Date;
}): Promise<MarkPaidResult> {
  const result = await repo.markPaid(input);
  if (result.outcome !== "activated") {
    throw new Error(
      `settle: markPaid reported "${result.outcome}" for transaction ${input.transactionId}`
    );
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

/**
 * I1, final whole-branch review, widened by Phase 5. What `StartCheckout` reads to decide
 * between a first purchase, a RENEWAL and a purchase it could never deliver — see the
 * port docstring for the money-in-nothing-out sequence the refusal closes, and for why a
 * boolean could not express the middle case.
 */
describe("DrizzleSubscriptionRepository.findCurrentSubscriptionForTier", () => {
  it("is null while the subscription is only pending", async () => {
    // The state StartCheckout itself leaves behind. If a pending row counted, a
    // member whose first payment never completed could never retry.
    const { member, tier } = await seedPendingCheckout();

    expect(await repo.findCurrentSubscriptionForTier(member.id, tier.id)).toBeNull();
  });

  it("returns the subscription once it is active", async () => {
    const { member, tier, subscription, transaction } = await seedPendingCheckout();
    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv-active",
      paidAt: new Date(),
    });

    const current = await repo.findCurrentSubscriptionForTier(member.id, tier.id);
    expect(current?.id).toBe(subscription.id);
    expect(current?.status).toBe("active");
    // The whole row, because the caller needs `next_billing_date` to decide whether the
    // renewal window has opened — the reason this replaced a boolean.
    expect(current?.nextBillingDate).not.toBeNull();
  });

  it("returns a PAST_DUE subscription, because that is the renewable case", async () => {
    const { member, tier, subscription, transaction } = await seedPendingCheckout();
    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv-past-due",
      paidAt: new Date(),
    });
    await db
      .update(subscriptions)
      .set({ status: "past_due", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));

    const current = await repo.findCurrentSubscriptionForTier(member.id, tier.id);
    expect(current?.id).toBe(subscription.id);
    expect(current?.status).toBe("past_due");
  });

  it("is null again after the subscription is cancelled, so a churned member can re-pay", async () => {
    // `cancelled` and `churned` are NOT renewable: a member whose access was taken away
    // buys a new subscription, which is what makes their re-grant an honest new grant.
    const { member, tier, subscription, transaction } = await seedPendingCheckout();
    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv-churn",
      paidAt: new Date(),
    });
    for (const status of ["cancelled", "churned"]) {
      await db
        .update(subscriptions)
        .set({ status, updatedAt: new Date() })
        .where(eq(subscriptions.id, subscription.id));
      expect(await repo.findCurrentSubscriptionForTier(member.id, tier.id)).toBeNull();
    }
  });

  it("does not confuse a different member or a different tier", async () => {
    const { member, tier, transaction } = await seedPendingCheckout();
    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv-scope",
      paidAt: new Date(),
    });
    const other = await seedPendingCheckout();

    expect(await repo.findCurrentSubscriptionForTier(other.member.id, tier.id)).toBeNull();
    expect(await repo.findCurrentSubscriptionForTier(member.id, other.tier.id)).toBeNull();
  });

  it("prefers the ACTIVE row when a member somehow has an active and a past_due one", async () => {
    // The partial unique index only covers `active`, so history can contain the pair.
    // The active row is the one granting access, so it is the one being renewed.
    const { member, tier, subscription, transaction } = await seedPendingCheckout();
    await settle({
      transactionId: transaction.id,
      gatewayReferenceId: "inv-both",
      paidAt: new Date(),
    });
    const [stale] = await db
      .insert(subscriptions)
      .values({
        memberId: member.id,
        tierId: tier.id,
        status: "past_due",
        nextBillingDate: "2030-01-01",
      })
      .returning();

    const current = await repo.findCurrentSubscriptionForTier(member.id, tier.id);
    // Even though the stale row's due date sorts first.
    expect(current?.id).toBe(subscription.id);
    expect(current?.id).not.toBe(stale.id);
  });

  it("reports a malformed id as a miss rather than raising a driver error", async () => {
    // `tierId` arrives from a request body, and `uuid = 'nope'` is SQLSTATE 22P02 —
    // which on the checkout path would be a 500 instead of the 404 the unknown tier
    // gets a moment later.
    expect(await repo.findCurrentSubscriptionForTier("nope", "also-nope")).toBeNull();
  });
});

describe("DrizzleSubscriptionRepository.findByIdWithCommunity", () => {
  it("resolves the subscription and its community through the tier", async () => {
    const { community, subscription } = await seedPendingCheckout();

    const found = await repo.findByIdWithCommunity(subscription.id);

    // This is how the outbox worker gets from a subscription id to the channels
    // it must grant: `MembershipTierRepositoryPort` is community-scoped, so
    // there is no unscoped tier-by-id lookup to walk instead.
    expect(found?.communityId).toBe(community.id);
    expect(found?.subscription.id).toBe(subscription.id);
    expect(found?.subscription.memberId).toBe(subscription.memberId);
  });

  it("reports an unknown or malformed id as a miss, not an error", async () => {
    expect(await repo.findByIdWithCommunity("3f1c9e0a-1111-4222-8333-444455556666")).toBeNull();
    // `uuid = 'not-a-uuid'` is SQLSTATE 22P02, and the worker would record a
    // driver error (which carries the statement's bound parameters) as the row's
    // last_error instead of a plain "not found".
    expect(await repo.findByIdWithCommunity("not-a-uuid")).toBeNull();
  });
});

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
    it("reports already_settled, not a second activation", async () => {
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
      ).toEqual({ outcome: "already_settled", status: "success" });
    });

    /**
     * Task 7 item 2. Both of these affect zero rows, so both used to come back as
     * a bare `null` and the caller called both "already settled". For `success`
     * that is a replay; for `failed` it is a real payment being thrown away, and
     * the caller cannot tell them apart from the outside.
     *
     * This is the DETERMINISTIC pin for the distinction — the webhook route test
     * pins what the API does with it.
     */
    it("reports conflicting_status, with the status, for a FAILED transaction", async () => {
      const { transaction } = await seedPendingCheckout();
      await db
        .update(transactions)
        .set({ status: "failed" })
        .where(eq(transactions.id, transaction.id));

      const outcome = await repo.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });

      expect(outcome).toEqual({ outcome: "conflicting_status", status: "failed" });
    });

    it("leaves a FAILED transaction and its subscription completely untouched", async () => {
      const { subscription, transaction } = await seedPendingCheckout();
      await db
        .update(transactions)
        .set({ status: "failed" })
        .where(eq(transactions.id, transaction.id));

      await repo.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
      expect(tx.status).toBe("failed");
      expect(tx.paidAt).toBeNull();
      expect(tx.gatewayReferenceId).toBeNull();
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscription.id));
      expect(sub.status).toBe("pending");
    });

    it("reports conflicting_status for any status that is neither pending nor success", async () => {
      // `transaction.status` is a varchar, not an enum, so a status a later phase
      // introduces must fail closed rather than be absorbed as a duplicate.
      for (const status of ["refunded", "expired", "chargeback"]) {
        const { transaction } = await seedPendingCheckout();
        await db.update(transactions).set({ status }).where(eq(transactions.id, transaction.id));

        expect(
          await repo.markPaid({
            transactionId: transaction.id,
            gatewayReferenceId: "inv_xendit_1",
            paidAt: new Date("2026-08-09T10:00:00Z"),
          })
        ).toEqual({ outcome: "conflicting_status", status });
      }
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

      expect(results.filter((r) => r.outcome === "activated")).toHaveLength(1);
      // And every loser is a plain replay, not something a person has to look at.
      expect(
        results.filter((r) => r.outcome === "already_settled")
      ).toHaveLength(4);
    });
  });

  /**
   * Task 7 item 3, at the level the decision is made. The route test proves the
   * API behaviour; this proves the mechanism, including the one thing an HTTP test
   * cannot reach — that the DATABASE, not the predicate, is the arbiter.
   */
  describe("a second subscription to a tier the member already holds", () => {
    /** A second PENDING subscription for the same member and tier, plus its transaction. */
    async function duplicatePendingSubscription(seed: {
      member: { id: string };
      tier: { id: string };
    }) {
      const subscription = await repo.createPending({
        memberId: seed.member.id,
        tierId: seed.tier.id,
      });
      const transaction = await repo.createTransaction({
        subscriptionId: subscription.id,
        amount: 50000,
        paymentMethod: "invoice",
      });
      return { subscription, transaction };
    }

    it("reports superseded and cancels the duplicate rather than activating it", async () => {
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const duplicate = await duplicatePendingSubscription(seed);

      const outcome = await repo.markPaid({
        transactionId: duplicate.transaction.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt: new Date("2026-08-09T10:00:05Z"),
      });

      expect(outcome.outcome).toBe("superseded");
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, duplicate.subscription.id));
      expect(row.status).toBe("cancelled");
      // Never activated, so it never gets a billing date either — a cancelled row
      // with next_billing_date set would look like a live membership to Phase 5.
      expect(row.nextBillingDate).toBeNull();
      expect(row.startedAt).toBeNull();
    });

    it("leaves the FIRST subscription exactly as it was", async () => {
      const seed = await seedPendingCheckout();
      const first = await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const duplicate = await duplicatePendingSubscription(seed);

      await repo.markPaid({
        transactionId: duplicate.transaction.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt: new Date("2026-09-09T10:00:00Z"),
      });

      const [row] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, seed.subscription.id));
      expect(row.status).toBe("active");
      // The duplicate must not buy a free extra month on the real membership.
      expect(row.nextBillingDate).toBe(first.subscription.nextBillingDate);
    });

    it("still settles the money, so the refund owed is on the record", async () => {
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const duplicate = await duplicatePendingSubscription(seed);
      const paidAt = new Date("2026-08-09T10:00:05Z");

      await repo.markPaid({
        transactionId: duplicate.transaction.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt,
      });

      const [tx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, duplicate.transaction.id));
      expect(tx.status).toBe("success");
      expect(tx.paidAt?.toISOString()).toBe(paidAt.toISOString());
      expect(tx.gatewayReferenceId).toBe("inv_xendit_2");
    });

    it("does not supersede a duplicate for a DIFFERENT tier", async () => {
      // Two tiers in the same community is a normal configuration, and a member may
      // hold both. The rule is per (member, tier), not per member.
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const [otherTier] = await db
        .insert(membershipTiers)
        .values({
          communityId: seed.community.id,
          name: "Premium",
          priceAmount: 150000,
          billingCycle: "monthly",
        })
        .returning();
      const second = await duplicatePendingSubscription({
        member: seed.member,
        tier: otherTier,
      });

      const outcome = await repo.markPaid({
        transactionId: second.transaction.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt: new Date("2026-08-09T10:00:05Z"),
      });

      expect(outcome.outcome).toBe("activated");
    });

    it("does not supersede a duplicate for a DIFFERENT member", async () => {
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const [otherMember] = await db
        .insert(members)
        .values({ whatsappNumber: `+628999${Date.now()}`.slice(0, 15), name: "Agus" })
        .returning();
      const second = await duplicatePendingSubscription({
        member: otherMember,
        tier: seed.tier,
      });

      const outcome = await repo.markPaid({
        transactionId: second.transaction.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt: new Date("2026-08-09T10:00:05Z"),
      });

      expect(outcome.outcome).toBe("activated");
    });

    /**
     * The predicate is not the guarantee — under READ COMMITTED two concurrent
     * activations cannot see each other's uncommitted row, so both would pass it.
     * `subscription_member_tier_active_unique` is what actually arbitrates, and
     * this asserts it exists IN THE DATABASE rather than only in schema.ts.
     */
    it("is arbitrated by the database: two active rows for one (member, tier) are refused", async () => {
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const duplicate = await duplicatePendingSubscription(seed);

      // Straight past markPaid, the way a lost race would land. The constraint name
      // is on the driver error drizzle wraps, not on the wrapper's message, so this
      // reads `cause` — asserting the name and not merely "something failed" is what
      // makes this test about THIS index.
      let violation: { constraint_name?: string } | undefined;
      try {
        await db
          .update(subscriptions)
          .set({ status: "active" })
          .where(eq(subscriptions.id, duplicate.subscription.id));
      } catch (err) {
        violation = (err as { cause?: { constraint_name?: string } }).cause;
      }
      expect(violation?.constraint_name).toBe("subscription_member_tier_active_unique");
    });

    it("permits many CANCELLED and PENDING duplicates — only `active` is unique", async () => {
      // The index is partial on purpose: duplicate history is legitimate, and a
      // total unique index would break re-subscribing after a churn.
      const seed = await seedPendingCheckout();
      const first = await duplicatePendingSubscription(seed);
      const second = await duplicatePendingSubscription(seed);
      await db
        .update(subscriptions)
        .set({ status: "cancelled" })
        .where(eq(subscriptions.id, first.subscription.id));
      await db
        .update(subscriptions)
        .set({ status: "cancelled" })
        .where(eq(subscriptions.id, second.subscription.id));

      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.memberId, seed.member.id));
      expect(rows).toHaveLength(3);
    });

    it("still activates a RENEWAL against the same subscription", async () => {
      // A renewal settles a NEW transaction against a subscription that is already
      // active, which is why the predicate excludes the row itself.
      const seed = await seedPendingCheckout();
      await settle({
        transactionId: seed.transaction.id,
        gatewayReferenceId: "inv_xendit_1",
        paidAt: new Date("2026-08-09T10:00:00Z"),
      });
      const renewal = await repo.createTransaction({
        subscriptionId: seed.subscription.id,
        amount: 50000,
        paymentMethod: "invoice",
      });

      const outcome = await repo.markPaid({
        transactionId: renewal.id,
        gatewayReferenceId: "inv_xendit_2",
        paidAt: new Date("2026-09-09T10:00:00Z"),
      });

      expect(outcome.outcome).toBe("activated");
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

/**
 * The two reads and one write Phase 5's reminder pass needs. Both are SQL-level
 * claims — a status filter and a conditional UPDATE — so they are asserted here
 * rather than only through `ProcessRenewals`.
 */
describe("DrizzleSubscriptionRepository.findDueForRenewal", () => {
  /** Puts an existing subscription into a given status with a given due date. */
  async function put(
    subscriptionId: string,
    values: { status?: string; nextBillingDate?: string | null }
  ) {
    await db
      .update(subscriptions)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));
  }

  it("returns an active subscription due on or before the cut-off, with its community", async () => {
    const { subscription, community } = await seedPendingCheckout();
    await put(subscription.id, { status: "active", nextBillingDate: "2026-03-10" });

    const due = await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 });

    expect(due).toHaveLength(1);
    expect(due[0].subscription.id).toBe(subscription.id);
    expect(due[0].communityId).toBe(community.id);
    expect(due[0].communityStatus).toBe("active");
    // The pass compares WIB calendar days, so it needs the stored date verbatim.
    expect(due[0].subscription.nextBillingDate).toBe("2026-03-10");
  });

  it("returns a past_due subscription too — the escalating stages are still owed", async () => {
    const { subscription } = await seedPendingCheckout();
    await put(subscription.id, { status: "past_due", nextBillingDate: "2026-03-10" });

    const due = await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 });

    expect(due).toHaveLength(1);
    expect(due[0].subscription.status).toBe("past_due");
  });

  it("EXCLUDES every other status", async () => {
    // Without the filter, a churned subscription from a year ago is read on every
    // pass for ever: `dueStageFor` saturates at overdue_7d rather than returning
    // null, so the pass would keep attempting inserts the unique index rejects —
    // safe, but noisy — and a `pending` row that never activated would be dunned.
    for (const status of ["pending", "cancelled", "superseded", "churned"]) {
      const { subscription } = await seedPendingCheckout();
      await put(subscription.id, { status, nextBillingDate: "2026-01-10" });
    }

    expect(await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 })).toHaveLength(
      0
    );
  });

  it("excludes a subscription due after the cut-off, and includes one due exactly on it", async () => {
    const later = await seedPendingCheckout();
    await put(later.subscription.id, { status: "active", nextBillingDate: "2026-03-14" });
    const exactly = await seedPendingCheckout();
    await put(exactly.subscription.id, { status: "active", nextBillingDate: "2026-03-13" });

    const due = await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 });

    expect(due.map((row) => row.subscription.id)).toEqual([exactly.subscription.id]);
  });

  it("excludes a subscription with no next_billing_date", async () => {
    const { subscription } = await seedPendingCheckout();
    await put(subscription.id, { status: "active", nextBillingDate: null });

    expect(await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 })).toHaveLength(
      0
    );
  });

  it("bounds the batch and takes the longest-overdue first", async () => {
    const oldest = await seedPendingCheckout();
    await put(oldest.subscription.id, { status: "active", nextBillingDate: "2026-03-01" });
    const newest = await seedPendingCheckout();
    await put(newest.subscription.id, { status: "active", nextBillingDate: "2026-03-10" });

    const due = await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 1 });

    expect(due.map((row) => row.subscription.id)).toEqual([oldest.subscription.id]);
  });

  it("walks past a keyset cursor without skipping or repeating a row", async () => {
    // Every one of these ties on `next_billing_date` — it is a DAY, so a whole cohort
    // does. The cursor therefore has to carry the id as well, or a paged pass either
    // loops for ever on the same page or jumps the rest of the cohort. Both failures
    // end with a member who is never reminded.
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      const { subscription } = await seedPendingCheckout();
      await put(subscription.id, { status: "active", nextBillingDate: "2026-03-10" });
      created.push(subscription.id);
    }

    const seen: string[] = [];
    let after: { nextBillingDate: string; id: string } | undefined;
    for (let page = 0; page < 10; page += 1) {
      const rows = await repo.findDueForRenewal({
        dueOnOrBefore: "2026-03-13",
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      if (rows.length === 0) break;
      seen.push(rows[0].subscription.id);
      after = { nextBillingDate: "2026-03-10", id: rows[0].subscription.id };
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen.slice().sort()).toEqual(created.slice().sort());
  });

  it("carries grace_ends_at back with the row", async () => {
    const deadline = new Date("2026-03-17T00:00:00.000Z");
    const { subscription } = await seedPendingCheckout();
    await db
      .update(subscriptions)
      .set({
        status: "past_due",
        nextBillingDate: "2026-03-10",
        graceEndsAt: deadline,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));

    const due = await repo.findDueForRenewal({ dueOnOrBefore: "2026-03-13", limit: 10 });

    expect(due[0].subscription.graceEndsAt?.toISOString()).toBe(deadline.toISOString());
  });
});

describe("DrizzleSubscriptionRepository.markPastDue", () => {
  it("moves an active subscription to past_due and stores the deadline", async () => {
    const deadline = new Date("2026-03-17T00:00:00.000Z");
    const { subscription } = await seedPendingCheckout();
    await db
      .update(subscriptions)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));

    expect(await repo.markPastDue(subscription.id, deadline)).toBe(true);

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id));
    expect(row.status).toBe("past_due");
    expect(row.graceEndsAt?.toISOString()).toBe(deadline.toISOString());
    // No BEFORE UPDATE trigger backs updated_at, so the method must set it.
    expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  });

  it("REFUSES to touch a subscription that is no longer active, deadline included", async () => {
    // `status = 'active'` is IN the UPDATE predicate, which is what makes
    // `grace_ends_at` write-once: the second pass cannot move a deadline the member
    // has already been given, because it never reaches the row at all.
    const alreadyPromised = new Date("2026-03-20T05:00:00.000Z");
    const { subscription } = await seedPendingCheckout();
    await db
      .update(subscriptions)
      .set({ status: "past_due", graceEndsAt: alreadyPromised, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));

    expect(await repo.markPastDue(subscription.id, new Date("2026-04-01T00:00:00.000Z"))).toBe(
      false
    );

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id));
    expect(row.graceEndsAt?.toISOString()).toBe(alreadyPromised.toISOString());
  });

  it("reports a malformed id as a miss rather than raising a driver error", async () => {
    expect(await repo.markPastDue("not-a-uuid", new Date())).toBe(false);
  });

  it("lets exactly ONE of several concurrent passes make the transition", async () => {
    // Two overlapping passes both see an `active` row. The predicate is what decides,
    // so only one of them may report the transition — and only one may write a
    // deadline.
    const { subscription } = await seedPendingCheckout();
    await db
      .update(subscriptions)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    const latch = new ArrivalLatch(4);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, async (_unused, index) => {
        await latch.arriveAndWait();
        return repo.markPastDue(
          subscription.id,
          new Date(Date.UTC(2026, 2, 17, index))
        );
      })
    );

    expect(outcomes.filter((moved) => moved)).toHaveLength(1);
  });
});
