import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, userSubscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
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

  it("attaches the gateway reference ONCE — a second attempt is refused, not an overwrite", async () => {
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
    expect(transaction.gatewayReferenceId).toBe(null);
    expect(transaction.gatewayInvoiceUrl).toBe(null);

    expect(
      await subs.attachGatewayReference(transaction.id, "inv-123", "https://pay.test/inv-123")
    ).toBe(true);
    const attached = await subs.findTransactionById(transaction.id);
    expect(attached?.gatewayReferenceId).toBe("inv-123");
    expect(attached?.gatewayInvoiceUrl).toBe("https://pay.test/inv-123");

    // The reference is the webhook's anchor for `body.id`. Overwriting it would
    // destroy that, so a second write is refused and the FIRST values stand —
    // the url with it, since a buyer must keep being handed the invoice that
    // actually exists at the provider.
    expect(
      await subs.attachGatewayReference(transaction.id, "inv-456", "https://pay.test/inv-456")
    ).toBe(false);
    const unchanged = await subs.findTransactionById(transaction.id);
    expect(unchanged?.gatewayReferenceId).toBe("inv-123");
    expect(unchanged?.gatewayInvoiceUrl).toBe("https://pay.test/inv-123");
  });

  it("returns false when attaching a gateway reference to a transaction that does not exist", async () => {
    expect(
      await subs.attachGatewayReference(
        "00000000-0000-4000-8000-000000000000",
        "inv-123",
        "https://pay.test/inv-123"
      )
    ).toBe(false);
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

  /*
   * Phase 5a fix round 1, F3. `userTransactionIdFromExternalId` (domain/user-payment.ts)
   * returns whatever follows the prefix, and an attacker chooses that: `usub_`
   * yields `""` and `usub_x` yields `"x"`. Task 7's webhook is a PUBLIC endpoint
   * that will feed exactly this value straight into these reads, and postgres
   * raises on a malformed uuid — a 500 anyone can trigger at will. Shape-checked
   * here, exactly as `DrizzleSubscriptionRepository` already shape-checks the
   * community handler's own `external_id`.
   */
  it("answers null — never throws — for an id that cannot be a uuid at all", async () => {
    for (const junk of ["", "x", "usub_", "not-a-uuid", "00000000-0000-4000-8000-00000000000"]) {
      expect(await subs.findTransactionById(junk)).toBe(null);
      expect(await subs.findById(junk)).toBe(null);
      expect(await subs.attachGatewayReference(junk, "inv-1", "https://x/inv-1")).toBe(false);
      expect(await subs.findActiveFor(junk, junk)).toBe(null);
    }
  });

  it("findPendingCheckout returns the invoice already waiting for this (subscriber, owner) pair", async () => {
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

    // No invoice yet — nothing is waiting to be paid, so nothing is returned.
    expect(await subs.findPendingCheckout(bob.id, alice.id)).toBe(null);

    await subs.attachGatewayReference(transaction.id, "inv-1", "https://pay.test/inv-1");

    expect(await subs.findPendingCheckout(bob.id, alice.id)).toEqual({
      subscriptionId: subscription.id,
      tierId: tier.id,
      transactionId: transaction.id,
      invoiceUrl: "https://pay.test/inv-1",
    });
    // Scoped to the pair: neither the other direction nor a third party sees it.
    expect(await subs.findPendingCheckout(alice.id, bob.id)).toBe(null);
  });

  it("findPendingCheckout returns the LIVE invoice even when a NEWER transaction never got one", async () => {
    // The invoice-url predicate, made observable: with two pending
    // transactions on one subscription — an older one carrying the live invoice
    // and a newer one whose provider call left nothing — "most recent" alone
    // would answer `null` and let a second invoice be minted while the first is
    // still payable.
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
    const invoiced = await subs.createTransaction({
      userSubscriptionId: subscription.id,
      amount: 50_000,
    });
    await subs.attachGatewayReference(invoiced.id, "inv-1", "https://pay.test/inv-1");
    await subs.createTransaction({ userSubscriptionId: subscription.id, amount: 50_000 });

    expect(await subs.findPendingCheckout(bob.id, alice.id)).toEqual({
      subscriptionId: subscription.id,
      tierId: tier.id,
      transactionId: invoiced.id,
      invoiceUrl: "https://pay.test/inv-1",
    });
  });

  it("findPendingCheckout ignores a subscription that is no longer pending", async () => {
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
    await subs.attachGatewayReference(transaction.id, "inv-1", "https://pay.test/inv-1");

    await subs.markTransactionPaid(transaction.id, new Date("2026-08-20T00:00:00Z"));
    await subs.activate(subscription.id, new Date("2099-01-01T00:00:00Z"));

    // Paid and active: `findActiveFor` is what refuses a second purchase now,
    // and a settled invoice must never be handed back to anybody.
    expect(await subs.findPendingCheckout(bob.id, alice.id)).toBe(null);
  });

  it("REFUSES a second PENDING subscription for the same pair at the DATABASE level", async () => {
    // `user_subscription_one_pending`, the fix-round-2 index. Two pending
    // subscriptions for one pair are two payable invoices for one membership.
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });

    await expect(
      subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id })
    ).rejects.toThrow();
  });

  it("claimPending inserts the pair's pending subscription and reports it created one", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });

    const claim = await subs.claimPending({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    expect(claim.created).toBe(true);
    expect(claim.subscription.status).toBe("pending");
    expect(claim.subscription.subscriberId).toBe(bob.id);
    expect(claim.subscription.ownerId).toBe(alice.id);
  });

  it("claimPending hands back the EXISTING pending row rather than inserting a second one", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const first = await subs.claimPending({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    const second = await subs.claimPending({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    expect(second.created).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);
  });

  it("claimPending claims again once the previous pending subscription was cancelled", async () => {
    // PARTIAL, so a released claim frees the slot — this is what keeps a failed
    // provider call from wedging a buyer forever.
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const first = await subs.claimPending({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });
    await subs.cancel(first.subscription.id);

    const second = await subs.claimPending({
      subscriberId: bob.id,
      tierId: tier.id,
      ownerId: alice.id,
    });

    expect(second.created).toBe(true);
    expect(second.subscription.id).not.toBe(first.subscription.id);
  });

  /**
   * THE ARBITRATION ITSELF, against a real database — the same instrument and
   * the same reasoning as `drizzle-user-payout.repository.test.ts`'s thirty-way
   * claim race. The latch holds every caller until all of them have arrived, so
   * they genuinely contend rather than hoping for an interleaving.
   *
   * THIRTY CONTENDERS, and the number is load-bearing for the reason Task 3
   * recorded: a read-then-write serialises often enough at small N to look
   * correct. This endpoint's own re-review measured TWO concurrent requests
   * producing the defect in 1 run out of 5 — so at two contenders a broken
   * implementation passes 80% of the time. Thirty is what the payout race
   * settled on against this same database, and matching it keeps one number in
   * the phase rather than two.
   */
  it("lets exactly ONE of thirty concurrent claims create the row", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const contenders = 30;
    const latch = new ArrivalLatch(contenders);

    const claims = await Promise.all(
      Array.from({ length: contenders }, async () => {
        await latch.arriveAndWait();
        return subs.claimPending({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
      })
    );

    expect(claims.filter((c) => c.created)).toHaveLength(1);
    expect(latch.arrived).toBe(contenders);
    // And every loser was handed the winner's row, not a null and not a throw.
    const ids = new Set(claims.map((c) => c.subscription.id));
    expect(ids.size).toBe(1);
    expect(await db.select().from(userSubscriptions)).toHaveLength(1);
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
