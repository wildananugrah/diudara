import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, userSubscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";
import { DrizzleUserPurchaseUnitOfWork } from "./drizzle-user-purchase.unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzleUserPurchaseUnitOfWork(db);
const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

let seedCounter = 0;

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

/** A pair whose ACTIVE membership lapsed in the past — 5b's starting shape. */
async function seedLapsedMembership() {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const tier = await tiers.create({
    ownerId: alice.id,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
  await subs.activate(created.id, PAST);
  return { subscriberId: bob.id, ownerId: alice.id, tierId: tier.id, id: created.id };
}

const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-08-21T00:00:00.000Z");

/**
 * Mirrors `drizzle-password-reset-unit-of-work.test.ts` exactly: proves
 * `subscriptions` is bound to the SAME transaction the unit of work opens,
 * not to the pool — the entire mechanism `UserPurchaseUnitOfWorkPort`'s
 * docstring claims.
 */
describe("DrizzleUserPurchaseUnitOfWork", () => {
  it("rolls the retirement back when the claim after it throws", async () => {
    const seeded = await seedLapsedMembership();

    await expect(
      unitOfWork().run(async (repositories) => {
        expect(
          await repositories.subscriptions.retireExpired(seeded.subscriberId, seeded.ownerId, NOW)
        ).toBe(true);
        throw new Error("boom, after the retirement");
      })
    ).rejects.toThrow("boom, after the retirement");

    // THE POINT: a retirement that committed alone would leave this person with
    // neither an active membership nor a pending checkout.
    const [row] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.currentPeriodEnd?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("commits the retirement and the claim together when the work succeeds", async () => {
    const seeded = await seedLapsedMembership();

    const claim = await unitOfWork().run(async (repositories) => {
      await repositories.subscriptions.retireExpired(seeded.subscriberId, seeded.ownerId, NOW);
      return repositories.subscriptions.claimPending({
        subscriberId: seeded.subscriberId,
        tierId: seeded.tierId,
        ownerId: seeded.ownerId,
      });
    });

    expect(claim.created).toBe(true);
    const rows = await db.select().from(userSubscriptions);
    expect(rows.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
  });

  it("keeps the retirement invisible to a pooled reader until the transaction commits", async () => {
    const seeded = await seedLapsedMembership();

    let statusMidTransaction = "";
    await unitOfWork().run(async (repositories) => {
      await repositories.subscriptions.retireExpired(seeded.subscriberId, seeded.ownerId, NOW);
      const [row] = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.id, seeded.id));
      statusMidTransaction = row!.status;
    });

    expect(statusMidTransaction).toBe("active");
    const [after] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, seeded.id));
    expect(after!.status).toBe("expired");
  });

  /**
   * **THE REASON `claimPending` HAD TO STOP CATCHING `23505`.** Inside a
   * transaction a caught unique violation is not clean: Postgres has already
   * aborted the transaction, so the read the catch performs — and every
   * statement after it — fails with "current transaction is aborted, commands
   * ignored until end of transaction block". This test runs the loser's path
   * INSIDE the unit of work and then keeps using the transaction, which is
   * exactly what `StartUserSubscription` does.
   *
   * `ON CONFLICT ... DO NOTHING` never raises the error in the first place, so
   * the loser's `created: false` is genuinely clean and the transaction is
   * still usable. The same conclusion, and the same fix,
   * `JoinRequestRepositoryPort.createPending` records.
   */
  it("a LOSING claim inside the unit of work leaves the transaction usable", async () => {
    const seeded = await seedLapsedMembership();
    // Somebody else already holds this pair's pending slot, committed.
    const winner = await subs.claimPending({
      subscriberId: seeded.subscriberId,
      tierId: seeded.tierId,
      ownerId: seeded.ownerId,
    });
    expect(winner.created).toBe(true);

    const seen = await unitOfWork().run(async (repositories) => {
      const claim = await repositories.subscriptions.claimPending({
        subscriberId: seeded.subscriberId,
        tierId: seeded.tierId,
        ownerId: seeded.ownerId,
      });
      expect(claim.created).toBe(false);
      // The statement AFTER the losing claim. With a caught 23505 this throws
      // 25P02 instead of answering.
      return repositories.subscriptions.findActiveFor(seeded.subscriberId, seeded.ownerId);
    });

    expect(seen?.id).toBe(seeded.id);
  });
});
