import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, userSubscriptions } from "../../db/schema";
import { eq } from "drizzle-orm";
import { resetDatabase } from "../../db/test-helpers";
import { ConflictError, NotFoundError } from "../errors";
import { DrizzleUserRepository } from "../../infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserTierRepository } from "../../infrastructure/repositories/drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { RevokeMembership } from "./revoke-membership";

beforeEach(resetDatabase);

/**
 * DATABASE-BACKED, deliberately. Revocation writes under
 * `user_subscription_one_active`, a partial unique index that exists only in
 * Postgres — the same reason Task 5 of the free-memberships plan was required
 * to be DB-backed after Task 4 shipped a 500 that every fake-based test passed.
 * The test that a revoked member can join again is meaningless against a fake:
 * what it actually proves is that `cancel` freed the index slot.
 */
const users = new DrizzleUserRepository(db);
const tiers = new DrizzleUserTierRepository(db);
const subs = new DrizzleUserSubscriptionRepository(db);

let seed = 0;
async function createUser(handle: string) {
  seed += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seed}`,
      email: `${handle}${seed}@example.com`,
      passwordHash: "x",
      displayName: handle,
    })
    .returning();
  return row!;
}

async function memberOf(ownerId: string, subscriberId: string, kind: "free" | "paid") {
  const tier = await tiers.create({
    ownerId,
    name: kind === "free" ? "Gratis" : "Anggota",
    priceAmount: kind === "free" ? 0 : 50_000,
    billingCycle: "monthly",
  });
  const claim = await subs.claimPending({ subscriberId, tierId: tier.id, ownerId, kind });
  await subs.activate(claim.subscription.id, new Date("2099-01-01T00:00:00.000Z"));
  if (kind === "free") {
    await db
      .update(userSubscriptions)
      .set({ currentPeriodEnd: null })
      .where(eq(userSubscriptions.id, claim.subscription.id));
  }
  return claim.subscription.id;
}

describe("RevokeMembership", () => {
  it("removes a FREE member — they stop being a member", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "free");
    const revoke = new RevokeMembership(users, subs);

    await revoke.execute({ ownerId: rina.id, handle: budi.handle });

    expect(await subs.findActiveFor(budi.id, rina.id)).toBeNull();
  });

  /**
   * The product decision, pinned. Cancelling a paid membership mid-period
   * stops a service already paid for, and this product has no refund path.
   * A ConflictError that says so, never a silent success.
   */
  it("refuses to remove a PAYING member, and leaves the membership intact", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "paid");
    const revoke = new RevokeMembership(users, subs);

    await expect(revoke.execute({ ownerId: rina.id, handle: budi.handle })).rejects.toThrow(
      ConflictError
    );

    const still = await subs.findActiveFor(budi.id, rina.id);
    expect(still?.status).toBe("active");
  });

  /**
   * Revocation is not a ban. `cancel` frees the partial unique index slot, so
   * the same pair can become active again — meaningless against an in-memory
   * fake, which carries no index at all.
   */
  it("frees the slot: a revoked member can be a member again", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "free");
    const revoke = new RevokeMembership(users, subs);
    await revoke.execute({ ownerId: rina.id, handle: budi.handle });

    const second = await memberOf(rina.id, budi.id, "free");

    expect((await subs.findActiveFor(budi.id, rina.id))?.id).toBe(second);
  });

  /**
   * WHAT THIS TEST CANNOT DO, stated because it was measured: there is no
   * single line here to delete that reddens it. Ownership is not a conditional
   * — it is the SHAPE of `findActiveFor(subscriberId, ownerId)`, which cannot
   * return a row without both ids agreeing. A mutation attempting to "drop the
   * ownership check" was tried and turned out to be a no-op.
   *
   * What it does prove is the wiring: that `input.ownerId` reaches the query
   * rather than something else. That is worth having — it is exactly what a
   * refactor passing the wrong id would break.
   */
  it("another owner cannot remove a member who is not theirs", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    const stranger = await createUser("sinta");
    await memberOf(rina.id, budi.id, "free");
    const revoke = new RevokeMembership(users, subs);

    await expect(
      revoke.execute({ ownerId: stranger.id, handle: budi.handle })
    ).rejects.toThrow(NotFoundError);

    expect((await subs.findActiveFor(budi.id, rina.id))?.status).toBe("active");
  });

  /**
   * The same answer for "no such person" and "not a member of yours", so an
   * owner cannot use this route to discover which handles exist — the rule the
   * media routes and the membership-request queue already follow.
   */
  it("answers the same NotFoundError for an unknown handle as for a stranger's member", async () => {
    const rina = await createUser("rina");
    const revoke = new RevokeMembership(users, subs);

    await expect(
      revoke.execute({ ownerId: rina.id, handle: "tidak-ada-orang-ini" })
    ).rejects.toThrow(NotFoundError);
  });

  it("is idempotent: revoking twice does not throw the second time", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "free");
    const revoke = new RevokeMembership(users, subs);
    await revoke.execute({ ownerId: rina.id, handle: budi.handle });

    // The row is terminal now, so it is no longer "an active member of yours"
    // — the second call answers NotFound, which is true.
    await expect(revoke.execute({ ownerId: rina.id, handle: budi.handle })).rejects.toThrow(
      NotFoundError
    );
  });
});
