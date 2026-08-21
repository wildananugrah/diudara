import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, type DatabaseExecutor } from "../../db/client";
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

/**
 * A fresh (subscriber, owner) pair with one ACTIVE subscription whose
 * `current_period_end` is `periodEnd` — the starting shape `retireExpired`
 * and `listExpiredActive` act on.
 */
async function seedActiveSubscription({ periodEnd }: { periodEnd: Date }) {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const tier = await tiers.create({
    ownerId: alice.id,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
  await subs.activate(created.id, periodEnd);
  return { subscriberId: bob.id, ownerId: alice.id, tierId: tier.id };
}

/**
 * A fresh (subscriber, owner) pair whose subscription was activated with
 * `current_period_end = periodEnd` and then CANCELLED — a row that is no
 * longer active but whose period date is (or can be) in the past. Proves
 * `retireExpired`/`listExpiredActive` key off `status = 'active'` and not
 * merely off the date: a cancelled row with a lapsed period must never be
 * retired or listed, unlike an active one with the same date.
 */
async function seedCancelledSubscription({ periodEnd }: { periodEnd: Date }) {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const tier = await tiers.create({
    ownerId: alice.id,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
  await subs.activate(created.id, periodEnd);
  await subs.cancel(created.id);
  return { subscriberId: bob.id, ownerId: alice.id, id: created.id };
}

/**
 * A fresh (subscriber, owner) pair with one PENDING subscription — the starting
 * shape `listStalePending`/`expireStalePending` act on. Never activated, so
 * `status` stays at its `create` default.
 */
async function seedPendingSubscription() {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const tier = await tiers.create({
    ownerId: alice.id,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
  return { subscriberId: bob.id, ownerId: alice.id, tierId: tier.id, id: created.id };
}

/**
 * Updates `created_at` directly via drizzle — a row that "arrived" in the past,
 * for the stale-pending sweep's own tests. Mirrors `drizzle-media.repository.test.ts`'s
 * `backdate` exactly: `create()` always writes `defaultNow()`, so this is the only
 * way to place a row on either side of a cutoff without waiting for real time to pass.
 */
async function backdate(id: string, createdAt: Date) {
  await db.update(userSubscriptions).set({ createdAt }).where(eq(userSubscriptions.id, id));
}

// Literal, not derived from the implementation — PAST and FUTURE straddle NOW
// on either side of the `<=` boundary `retireExpired` and `listExpiredActive`
// both use.
const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-08-21T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

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
   * A FAILED CLAIM IS NOT A LOST ONE. `claimPending` arbitrates with `ON
   * CONFLICT DO NOTHING`, so there is no catch left to widen — but the shape
   * that catch existed to prevent is still worth pinning: a dead connection
   * must NOT be reported as `created: false` beside a pending row that
   * genuinely exists, because the buyer would then be told to wait for an
   * invoice nobody is opening.
   *
   * The failure is injected rather than provoked: the double-fault insert
   * cannot show this, because postgres raises the unique violation first
   * (probed — an insert that breaks both `user_subscription_one_pending` and
   * the tier foreign key reports `23505` on the index, never `23503`).
   */
  it("propagates an error that is NOT the pending-claim conflict, even when a pending row exists", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const stubbed = new DrizzleUserSubscriptionRepository({
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.reject(boom) }) }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  subscriberId: "22222222-2222-4222-8222-222222222222",
                  tierId: "33333333-3333-4333-8333-333333333333",
                  ownerId: "44444444-4444-4444-8444-444444444444",
                  status: "pending",
                  currentPeriodEnd: null,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      }),
    } as unknown as DatabaseExecutor);

    await expect(
      stubbed.claimPending({
        subscriberId: "22222222-2222-4222-8222-222222222222",
        tierId: "33333333-3333-4333-8333-333333333333",
        ownerId: "44444444-4444-4444-8444-444444444444",
      })
    ).rejects.toThrow("connection terminated unexpectedly");
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

  it("retires an ACTIVE subscription whose period has passed, and frees the active slot", async () => {
    const { subscriberId, ownerId, tierId } = await seedActiveSubscription({ periodEnd: PAST });

    expect(await subs.retireExpired(subscriberId, ownerId, NOW)).toBe(true);

    // The whole point: the partial unique index no longer holds the slot —
    // a brand new subscription for the same pair can be created AND activated.
    const fresh = await subs.create({ subscriberId, tierId, ownerId });
    await subs.activate(fresh.id, FUTURE);
    expect((await subs.findActiveFor(subscriberId, ownerId))?.id).toBe(fresh.id);
  });

  it("does NOT retire a subscription whose period is still running", async () => {
    const { subscriberId, ownerId } = await seedActiveSubscription({ periodEnd: FUTURE });

    expect(await subs.retireExpired(subscriberId, ownerId, NOW)).toBe(false);
    expect(await subs.findActiveFor(subscriberId, ownerId)).not.toBe(null);
  });

  it("lists expired active subscriptions for the sweep, and excludes live ones", async () => {
    const expired = await seedActiveSubscription({ periodEnd: PAST });
    await seedActiveSubscription({ periodEnd: FUTURE });
    const expiredRow = await subs.findActiveFor(expired.subscriberId, expired.ownerId);

    const result = await subs.listExpiredActive(NOW, 10);

    expect(result.map((row) => row.id)).toEqual([expiredRow!.id]);
  });

  // Fix round 1 — Important finding. The date predicate alone is not enough:
  // a cancelled row can carry a `current_period_end` that is just as lapsed
  // as an active one's. `status = 'active'` is what keeps `retireExpired` and
  // `listExpiredActive` from touching it, and neither test above reddens if
  // that predicate is deleted, because neither seeds a non-active row at all.
  it("does NOT retire a CANCELLED subscription whose period has passed", async () => {
    const { subscriberId, ownerId, id } = await seedCancelledSubscription({ periodEnd: PAST });

    expect(await subs.retireExpired(subscriberId, ownerId, NOW)).toBe(false);

    const row = await subs.findById(id);
    expect(row?.status).toBe("cancelled");
  });

  it("listExpiredActive excludes a CANCELLED subscription whose period has passed", async () => {
    await seedCancelledSubscription({ periodEnd: PAST });

    expect(await subs.listExpiredActive(NOW, 10)).toEqual([]);
  });
});

/**
 * Task 5 of Phase 5b (spec §7): the pending-checkout cleanup. The window's two ends
 * are tested in both directions here for the same reason `listExpiringActive`'s own
 * comment gives — a query with only clearly-stale rows passes against a cutoff of any
 * value — but this suite tests the SQL predicate against a `cutoff` it is simply
 * handed; the window's own reasoning (why it sits where it does between a person's
 * checkout and an invoice's life at the provider) belongs to
 * `apps/worker/src/scheduled-passes.ts`'s `STALE_PENDING_CHECKOUT_WINDOW_MS`, and that
 * suite is where its own boundary is pinned as a real duration.
 */
describe("DrizzleUserSubscriptionRepository.listStalePending / expireStalePending", () => {
  const CUTOFF = new Date("2026-08-21T12:00:00.000Z");

  it("lists a pending row whose created_at is exactly AT the cutoff — inclusive, like retireExpired's <=", async () => {
    const { id } = await seedPendingSubscription();
    await backdate(id, CUTOFF);

    const result = await subs.listStalePending(CUTOFF, 10);

    expect(result.map((row) => row.id)).toEqual([id]);
  });

  /**
   * THE BOUNDARY. One millisecond on the live side of the cutoff and the row must
   * not appear — a query with only clearly-stale rows in its test suite would pass
   * against a cutoff computed from a window of any length at all, including one
   * short enough to expire a buyer mid-checkout.
   */
  it("excludes a pending row created ONE MILLISECOND after the cutoff", async () => {
    const { id } = await seedPendingSubscription();
    await backdate(id, new Date(CUTOFF.getTime() + 1));

    expect(await subs.listStalePending(CUTOFF, 10)).toEqual([]);
  });

  it("includes a pending row created ONE MILLISECOND before the cutoff", async () => {
    const { id } = await seedPendingSubscription();
    await backdate(id, new Date(CUTOFF.getTime() - 1));

    const result = await subs.listStalePending(CUTOFF, 10);

    expect(result.map((row) => row.id)).toEqual([id]);
  });

  it("excludes an ACTIVE subscription even when its created_at is far older than the cutoff", async () => {
    // The date predicate alone is not enough — mirrors the CANCELLED test above for
    // `listExpiredActive`. An active row has already cleared checkout; expiring it
    // by age would be the exact mistake this task exists not to make.
    const { subscriberId } = await seedActiveSubscription({ periodEnd: FUTURE });
    const [active] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.subscriberId, subscriberId));
    await backdate(active!.id, PAST);

    expect(await subs.listStalePending(CUTOFF, 10)).toEqual([]);
  });

  it("expires a stale pending row, freeing user_subscription_one_pending's slot for a fresh claim", async () => {
    const { id, subscriberId, ownerId, tierId } = await seedPendingSubscription();
    await backdate(id, PAST);

    expect(await subs.expireStalePending(id)).toBe(true);
    expect((await subs.findById(id))?.status).toBe("expired");

    // THE WHOLE POINT: the partial unique index no longer holds the slot — a
    // fresh claim for the same pair succeeds. Mirrors `retireExpired`'s own
    // "frees the active slot" test.
    const claim = await subs.claimPending({ subscriberId, tierId, ownerId });
    expect(claim.created).toBe(true);
    expect(claim.subscription.id).not.toBe(id);
  });

  it("returns false, and leaves the row untouched, when the row is no longer pending", async () => {
    const { id } = await seedPendingSubscription();
    await subs.activate(id, FUTURE);

    expect(await subs.expireStalePending(id)).toBe(false);
    expect((await subs.findById(id))?.status).toBe("active");
  });

  it("returns false for an unknown id, rather than throwing", async () => {
    expect(await subs.expireStalePending("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

/**
 * Task 4 of Phase 5b: whom to warn BEFORE their membership ends. The window's two
 * ends are tested in both directions, because a query with only clearly-inside rows
 * passes against a window of any length — the same rule §11 of the spec sets for the
 * pending-checkout cleanup.
 */
describe("DrizzleUserSubscriptionRepository.listExpiringActive", () => {
  const WINDOW_END = new Date("2026-08-24T00:00:00.000Z");

  it("returns an ACTIVE membership ending inside the window", async () => {
    const { subscriberId } = await seedActiveSubscription({
      periodEnd: new Date("2026-08-23T00:00:00.000Z"),
    });
    const rows = await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].subscriberId).toBe(subscriberId);
  });

  it("EXCLUDES a membership whose period has already lapsed", async () => {
    // `from` is exclusive: an already-lapsed membership belongs to the retirement
    // sweep, and warning somebody about something that has already happened is not a
    // warning. Placed exactly ON the boundary, so an inclusive `>=` would fail here.
    await seedActiveSubscription({ periodEnd: NOW });
    expect(
      (await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 10 })).length
    ).toBe(0);
  });

  it("INCLUDES a membership ending exactly at the far edge of the window", async () => {
    await seedActiveSubscription({ periodEnd: WINDOW_END });
    expect(
      (await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 10 })).length
    ).toBe(1);
  });

  it("EXCLUDES a membership ending one millisecond past the far edge", async () => {
    await seedActiveSubscription({ periodEnd: new Date(WINDOW_END.getTime() + 1) });
    expect(
      (await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 10 })).length
    ).toBe(0);
  });

  it("EXCLUDES a cancelled membership whose period ends inside the window", async () => {
    // The predicate is `status = 'active'`, not merely the date — the same property
    // `listExpiredActive` is pinned on.
    await seedCancelledSubscription({ periodEnd: new Date("2026-08-23T00:00:00.000Z") });
    expect(
      (await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 10 })).length
    ).toBe(0);
  });

  it("pages by keyset, so a reminded membership cannot starve the one behind it", async () => {
    await seedActiveSubscription({ periodEnd: new Date("2026-08-22T00:00:00.000Z") });
    await seedActiveSubscription({ periodEnd: new Date("2026-08-23T00:00:00.000Z") });

    const first = await subs.listExpiringActive({ from: NOW, to: WINDOW_END, limit: 1 });
    expect(first.length).toBe(1);
    expect(first[0].currentPeriodEnd).toEqual(new Date("2026-08-22T00:00:00.000Z"));

    const second = await subs.listExpiringActive({
      from: NOW,
      to: WINDOW_END,
      limit: 1,
      after: { currentPeriodEnd: first[0].currentPeriodEnd!, id: first[0].id },
    });
    expect(second.length).toBe(1);
    expect(second[0].currentPeriodEnd).toEqual(new Date("2026-08-23T00:00:00.000Z"));

    const third = await subs.listExpiringActive({
      from: NOW,
      to: WINDOW_END,
      limit: 1,
      after: { currentPeriodEnd: second[0].currentPeriodEnd!, id: second[0].id },
    });
    expect(third.length).toBe(0);
  });
});

/**
 * Task 6 of Phase 5b (spec §8) — a creator's own subscriber list.
 *
 * "Currently subscribed" mirrors `IsMemberOf`'s own definition exactly:
 * `status = 'active'` AND `current_period_end > now`, strict. Every boundary
 * this suite exercises is the SAME boundary `is-member-of.test.ts` pins for
 * that use case — a status-only filter would list a member the sweep has
 * not yet retired (§9's honest limitation) as though nothing had lapsed.
 */
describe("listActiveSubscribers (Task 6 of Phase 5b)", () => {
  const PAST_PERIOD_END = new Date("2026-01-01T00:00:00.000Z"); // before NOW
  const FUTURE_PERIOD_END = new Date("2027-01-01T00:00:00.000Z"); // after NOW

  it("lists a currently active subscriber with the CLOSED projection: handle, displayName, since — nothing else", async () => {
    const alice = await createUser("alice"); // owner
    const bob = await createUser("bob"); // subscriber
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(created.id, FUTURE_PERIOD_END);

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(1);
    // Object.keys, not a spot-check — a spot-check passes against an extra
    // field, which is the entire failure mode this projection exists to
    // close off. See the port's own `SubscriberRow` docstring.
    expect(Object.keys(rows[0]!).sort()).toEqual(["displayName", "handle", "since"]);
    expect(rows[0]!.handle).toBe(bob.handle);
    expect(rows[0]!.displayName).toBe(bob.displayName);
    expect(rows[0]!.since).toEqual(created.createdAt);
  });

  it("EXCLUDES a subscription whose current_period_end has already passed, even though status is still 'active'", async () => {
    // THE case this whole method exists to get right — identical reasoning to
    // `is-member-of.test.ts`'s own "THE case" test. 5b's sweep is what
    // eventually flips this row's status, and it may not have run yet.
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(created.id, PAST_PERIOD_END);

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("EXCLUDES a subscription whose current_period_end equals now exactly (strict >, not >=)", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(created.id, NOW);

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("EXCLUDES a pending subscription — never activated", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("EXCLUDES a cancelled subscription, even with a future period end", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(created.id, FUTURE_PERIOD_END);
    await subs.cancel(created.id);

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("EXCLUDES an expired subscription, even with a (stale) future-looking period end left on the row", async () => {
    // Direct column write, not `retireExpired` — that method only ever flips a
    // row whose period has already lapsed, which would exclude this row on
    // the date alone. Writing `status = 'expired'` directly against a FUTURE
    // period end isolates the STATUS predicate exactly the way
    // `listExpiredActive`'s own cancelled-row test isolates it.
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(created.id, FUTURE_PERIOD_END);
    await db.update(userSubscriptions).set({ status: "expired" }).where(eq(userSubscriptions.id, created.id));

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("never lists another owner's subscriber", async () => {
    const alice = await createUser("alice");
    const rina = await createUser("rina");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: rina.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: rina.id });
    await subs.activate(created.id, FUTURE_PERIOD_END);

    // bob subscribes to rina, not alice — alice's list must stay empty.
    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.length).toBe(0);
  });

  it("lists multiple current subscribers, newest first", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const rina = await createUser("rina");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    const bobSub = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(bobSub.id, FUTURE_PERIOD_END);
    await db
      .update(userSubscriptions)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(userSubscriptions.id, bobSub.id));

    const rinaSub = await subs.create({ subscriberId: rina.id, tierId: tier.id, ownerId: alice.id });
    await subs.activate(rinaSub.id, FUTURE_PERIOD_END);
    await db
      .update(userSubscriptions)
      .set({ createdAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(userSubscriptions.id, rinaSub.id));

    const rows = await subs.listActiveSubscribers(alice.id, NOW);

    expect(rows.map((r) => r.handle)).toEqual([rina.handle, bob.handle]);
  });
});
