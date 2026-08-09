import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./client";
import {
  communities,
  creators,
  members,
  membershipTiers,
  renewalReminders,
  subscriptions,
} from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

/**
 * Drizzle's query builder is a thenable rather than a real Promise, so
 * `expect(builder).rejects.toThrow()` does not drive it to completion and the
 * assertion passes vacuously. Awaiting inside a real async function does.
 * (Same helper, same reason, as `schema-constraints.test.ts`.)
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Flattens an Error's `cause` chain. Drizzle wraps driver failures in a
 * DrizzleQueryError whose own message is just the failed SQL; the Postgres
 * constraint name lives on the wrapped cause — which is exactly what proves the
 * rejection came from the DATABASE and not from anything in TypeScript.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

// creator.email, community.slug and member.whatsapp_number are all unique, and one
// test seeds twice in the same millisecond, so the suffix is a counter rather than
// Date.now().
let seedCounter = 0;

async function seedSubscription() {
  const n = (seedCounter += 1);
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", email: `r-${n}-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-${n}-${Date.now()}` })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Bulanan",
      priceAmount: 50_000,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${n}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId: tier.id, status: "active" })
    .returning();
  return { community, member, tier, subscription };
}

describe("subscription.grace_ends_at", () => {
  it("is null on a fresh subscription", async () => {
    const { subscription } = await seedSubscription();
    // The grace deadline is STORED when a subscription enters past_due, never
    // recomputed, so that a later timezone or config change cannot retroactively
    // move somebody's deadline. Until then there is no deadline, and null is how
    // the column says so — a default of now() would put every new subscriber
    // one week from eviction.
    expect(subscription.graceEndsAt).toBeNull();
  });

  it("round-trips an instant with its timezone", async () => {
    const { subscription } = await seedSubscription();
    const deadline = new Date("2026-03-17T17:00:00.000Z");
    const [updated] = await db
      .update(subscriptions)
      .set({ graceEndsAt: deadline, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id))
      .returning();
    expect(updated.graceEndsAt?.toISOString()).toBe(deadline.toISOString());
  });
});

/**
 * `past_due` and `churned` are NEW status values in Phase 5. `subscription.status`
 * is a free-text varchar(16), not a Postgres enum, so they need no migration — this
 * test is the record that they physically fit and are accepted, so that a later
 * reader does not go looking for a missing enum value.
 */
describe("the new subscription statuses", () => {
  it("accepts past_due and churned in the existing varchar column", async () => {
    const { subscription } = await seedSubscription();
    for (const status of ["past_due", "churned"]) {
      const [updated] = await db
        .update(subscriptions)
        .set({ status, updatedAt: new Date() })
        .where(eq(subscriptions.id, subscription.id))
        .returning();
      expect(updated.status).toBe(status);
    }
  });
});

describe("renewal_reminder", () => {
  it("records a stage against a subscription and stamps sent_at", async () => {
    const { subscription } = await seedSubscription();
    const [row] = await db
      .insert(renewalReminders)
      .values({ subscriptionId: subscription.id, stage: "pre_3d" })
      .returning();
    expect(row.subscriptionId).toBe(subscription.id);
    expect(row.stage).toBe("pre_3d");
    expect(row.sentAt).toBeInstanceOf(Date);
  });

  /**
   * THE REMINDER-ONCE MECHANISM. A reminder pass that runs twice — two workers, a
   * restart mid-pass, a retried outbox row — must not message the member twice for
   * the same stage. Nothing in TypeScript arbitrates that; the unique index does,
   * and it has to be IN POSTGRES rather than only in schema.ts.
   *
   * The assertion is therefore on the Postgres error and its constraint NAME, not
   * merely on "something threw": Phase 4 had a mutant survive its whole suite
   * because a test checked the wrong layer.
   */
  it("rejects a second reminder for the same subscription and stage", async () => {
    const { subscription } = await seedSubscription();
    await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });

    const error = await captureError(() =>
      db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" })
    );

    expect(error).not.toBeNull();
    const chain = messageChain(error);
    expect(chain).toContain("renewal_reminder_subscription_stage_unique");
    expect(chain.toLowerCase()).toContain("duplicate key");
    expect((await db.select().from(renewalReminders)).length).toBe(1);
  });

  it("allows the same subscription at a different stage", async () => {
    const { subscription } = await seedSubscription();
    await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "pre_3d" });
    await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });
    expect((await db.select().from(renewalReminders)).length).toBe(2);
  });

  it("allows the same stage for a different subscription", async () => {
    const first = await seedSubscription();
    const second = await seedSubscription();
    await db
      .insert(renewalReminders)
      .values({ subscriptionId: first.subscription.id, stage: "due" });
    await db
      .insert(renewalReminders)
      .values({ subscriptionId: second.subscription.id, stage: "due" });
    expect((await db.select().from(renewalReminders)).length).toBe(2);
  });

  it("refuses a reminder for a subscription that does not exist", async () => {
    // The FK is what keeps the reminder log meaningful: a row pointing at nothing
    // is a reminder nobody can be shown to have received.
    const error = await captureError(() =>
      db
        .insert(renewalReminders)
        .values({ subscriptionId: "00000000-0000-4000-8000-000000000000", stage: "due" })
    );
    expect(messageChain(error).toLowerCase()).toContain("foreign key");
  });
});

/**
 * `resetDatabase()` must clear renewal_reminder BEFORE subscriptions, or every
 * later test file dies on an FK violation the moment one reminder row exists.
 */
describe("resetDatabase", () => {
  it("clears renewal_reminder", async () => {
    const { subscription } = await seedSubscription();
    await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });
    await resetDatabase();
    expect((await db.select().from(renewalReminders)).length).toBe(0);
    expect((await db.select().from(subscriptions)).length).toBe(0);
  });
});
