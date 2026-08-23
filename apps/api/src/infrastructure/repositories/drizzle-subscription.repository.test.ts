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
import { UniqueRule, UniqueViolationError } from "../../application/errors";
import { ArrivalLatch } from "../../test-support/arrival-latch";
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

/**
 * Puts a seeded subscription into the state a settled payment used to leave it in:
 * `active`, with a `next_billing_date`.
 *
 * These tests used to reach that state by calling `markPaid`, which retire-telegram
 * Task 5 deleted with its last caller. What they are ABOUT is
 * `findCurrentSubscriptionForTier`'s status filter, not how the status got there, so
 * the setup is now a direct write — the same shape `webhooks.test.ts` adopted in Task
 * 4 when the checkout route it seeded through was deleted. Written by hand rather
 * than derived, so the filter is never compared against the code that fills it.
 */
async function activateSeeded(subscriptionId: string, nextBillingDate = "2026-09-09") {
  await db
    .update(subscriptions)
    .set({
      status: "active",
      nextBillingDate,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscriptionId));
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
    const { member, tier, subscription } = await seedPendingCheckout();
    await activateSeeded(subscription.id);

    const current = await repo.findCurrentSubscriptionForTier(member.id, tier.id);
    expect(current?.id).toBe(subscription.id);
    expect(current?.status).toBe("active");
    // The whole row, because the caller needs `next_billing_date` to decide whether the
    // renewal window has opened — the reason this replaced a boolean.
    expect(current?.nextBillingDate).not.toBeNull();
  });

  it("returns a PAST_DUE subscription, because that is the renewable case", async () => {
    const { member, tier, subscription } = await seedPendingCheckout();
    await activateSeeded(subscription.id);
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
    const { member, tier, subscription } = await seedPendingCheckout();
    await activateSeeded(subscription.id);
    for (const status of ["cancelled", "churned"]) {
      await db
        .update(subscriptions)
        .set({ status, updatedAt: new Date() })
        .where(eq(subscriptions.id, subscription.id));
      expect(await repo.findCurrentSubscriptionForTier(member.id, tier.id)).toBeNull();
    }
  });

  it("does not confuse a different member or a different tier", async () => {
    const { member, tier, subscription } = await seedPendingCheckout();
    await activateSeeded(subscription.id);
    const other = await seedPendingCheckout();

    expect(await repo.findCurrentSubscriptionForTier(other.member.id, tier.id)).toBeNull();
    expect(await repo.findCurrentSubscriptionForTier(member.id, other.tier.id)).toBeNull();
  });

  it("prefers the ACTIVE row when a member somehow has an active and a past_due one", async () => {
    // The partial unique index only covers `active`, so history can contain the pair.
    // The active row is the one granting access, so it is the one being renewed.
    const { member, tier, subscription } = await seedPendingCheckout();
    await activateSeeded(subscription.id);
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

/**
 * The provider's own invoice id, recorded at checkout so the webhook has
 * something of OURS to check `body.id` against.
 *
 * Its caller went with `StartCheckout` (retire-telegram Task 4) and its reader
 * went with the webhook's community branch (Task 5), so this method has none
 * left. It is tested here for the reason the port docstring gives: the remaining
 * thirteen methods die as a SET at Task 6, and until then they are working code
 * with real coverage. Lifted out of the `markPaid` block it used to sit inside
 * when that block was deleted.
 */
describe("DrizzleSubscriptionRepository.attachGatewayReference", () => {
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

/**
 * The two reads and one write Phase 5's reminder pass needed. Both are SQL-level
 * claims — a status filter and a conditional UPDATE — so they are asserted here
 * rather than only through `ProcessRenewals`, which retire-telegram Task 4
 * deleted.
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

  /**
   * FOUR CONTENDERS, AND THE NUMBER IS MEASURED RATHER THAN INHERITED.
   *
   * `markPastDue` is a CONDITIONAL UPDATE, not an insert arbitrated by a unique
   * index — the same shape as `beginXenditAccountProvisioning`, where
   * memberships-5a's review round 1 (F1) measured a four-contender latch staying
   * green across 5 runs against the exact bug it existed to catch (check-then-act
   * wins 1 contest of 4, but 27 of 30). That test was raised to 30. **And this
   * one sits on the live renewal money path**, which is why the final
   * whole-branch review would not leave it on an assumption.
   *
   * Measured, applying F1's own mutant — the conditional UPDATE replaced by a
   * SELECT followed by an unconditional one, production code otherwise
   * untouched: **this test failed 3 runs out of 3 at four contenders**, and the
   * mutant was reverted and confirmed byte-identical.
   *
   * WHY IT HOLDS HERE AND NOT THERE: in this call path every contender's SELECT
   * issues before any UPDATE returns, so all four genuinely observe `active`.
   * That is a property of the surrounding awaits, not of the number — do not read
   * "four is enough" as a general rule, and do not lower it here.
   */
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

describe("DrizzleSubscriptionRepository.createActiveWithoutBilling", () => {
  /** A member and a tier, with no pending subscription or transaction — the free path never creates either. */
  async function seedMemberAndTier() {
    seedCounter += 1;
    const [creator] = await db.insert(creators).values({ name: "Nadia" }).returning();
    const [community] = await db
      .insert(communities)
      .values({
        creatorId: creator.id,
        name: "Komunitas Nadia",
        slug: `komunitas-nadia-${seedCounter}`,
        accessMode: "free",
      })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({ communityId: community.id, name: "Free", priceAmount: 0, billingCycle: "monthly" })
      .returning();
    const [member] = await db
      .insert(members)
      .values({
        whatsappNumber: `+62812000${String(seedCounter).padStart(4, "0")}`,
        name: "Dewi",
      })
      .returning();
    return { creator, community, tier, member };
  }

  it("creates an ACTIVE subscription with no next_billing_date", async () => {
    const { member, tier } = await seedMemberAndTier();

    const subscription = await repo.createActiveWithoutBilling({
      memberId: member.id,
      tierId: tier.id,
    });

    expect(subscription.status).toBe("active");
    expect(subscription.nextBillingDate).toBeNull();
    expect(subscription.memberId).toBe(member.id);
    expect(subscription.tierId).toBe(tier.id);
    expect(subscription.startedAt).not.toBeNull();
  });

  /**
   * Task 4 (free communities): `DecideJoinRequest` approving a member for a tier
   * they already hold actively lands exactly here — a bare INSERT has no status
   * to predicate on the way an UPDATE would, so
   * `subscription_member_tier_active_unique` is the ONLY thing that can catch
   * it. Seeding the conflicting `active` row directly, bypassing every
   * application-level guard, proves the DATABASE is what refuses this and not a
   * predicate this method could have gotten wrong.
   */
  it("maps the unique-constraint violation to UniqueViolationError rather than a raw driver error", async () => {
    const { member, tier } = await seedMemberAndTier();
    await repo.createActiveWithoutBilling({ memberId: member.id, tierId: tier.id });

    const error = (await repo
      .createActiveWithoutBilling({ memberId: member.id, tierId: tier.id })
      .catch((e) => e)) as UniqueViolationError;

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error.rule).toBe(UniqueRule.subscriptionMemberTierActive);

    // Exactly the one row from the first, successful call — the refused
    // second INSERT created nothing.
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.memberId, member.id));
    expect(rows).toHaveLength(1);
  });

  it("permits a second ACTIVE subscription for a DIFFERENT tier — the constraint is per (member, tier)", async () => {
    const { member, tier, community } = await seedMemberAndTier();
    const [otherTier] = await db
      .insert(membershipTiers)
      .values({ communityId: community.id, name: "VIP", priceAmount: 0, billingCycle: "monthly" })
      .returning();

    await repo.createActiveWithoutBilling({ memberId: member.id, tierId: tier.id });
    const second = await repo.createActiveWithoutBilling({
      memberId: member.id,
      tierId: otherTier.id,
    });

    expect(second.status).toBe("active");
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.memberId, member.id));
    expect(rows).toHaveLength(2);
  });

  it("a free subscription is invisible to findDueForRenewal, so the renewal pass never touches it", async () => {
    const { member, tier } = await seedMemberAndTier();
    const free = await repo.createActiveWithoutBilling({ memberId: member.id, tierId: tier.id });
    expect(free.status).toBe("active");
    expect(free.nextBillingDate).toBeNull();

    // `findDueForRenewal` returns `DueRenewalRecord[]`, which NESTS the row as
    // `subscription: SubscriptionRecord` — there is no flat `subscriptionId` on it.
    //
    // A far-future date is used deliberately: it proves the row is excluded because
    // its due date is NULL, not because the date has not arrived. If a later change
    // ever gave free subscriptions a due date, this test would start failing.
    const due = await repo.findDueForRenewal({
      dueOnOrBefore: "2099-01-01",
      limit: 100,
    });
    expect(due.some((r) => r.subscription.id === free.id)).toBe(false);

    // THE SECOND LINK IS NO LONGER OBSERVABLE FROM HERE, and saying so is more
    // useful than replacing it with an assertion that cannot fail.
    //
    // This test used to run the REAL `ProcessRenewals` over the row and assert it
    // was left alone — the transitive proof that `markPastDue`, whose only
    // production caller was that pass, could never reach a free membership.
    // Retire-telegram Task 4 deleted `ProcessRenewals` with the community
    // subscriptions it dunned, so `markPastDue` now has NO production caller at
    // all and there is no pass to run.
    //
    // Asserting `findPastGraceDeadline` excludes this row instead would be
    // structurally unfailable: `createActiveWithoutBilling` never writes
    // `past_due` in the first place, so that query's own `status = 'past_due'`
    // predicate has nothing to match here and the assertion would pass even with
    // an arbitrary `graceEndsAt` on the row. What remains provable — that the row
    // is invisible to `findDueForRenewal`, the only feed the deleted pass ever
    // had — is asserted above.
  });
});
