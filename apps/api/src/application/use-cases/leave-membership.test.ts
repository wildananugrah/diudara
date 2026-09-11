import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, userSubscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { NotFoundError } from "../errors";
import { DrizzleUserRepository } from "../../infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserTierRepository } from "../../infrastructure/repositories/drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { LeaveMembership } from "./leave-membership";

beforeEach(resetDatabase);

/**
 * DATABASE-BACKED. Leaving writes under `user_subscription_one_active`, a
 * partial unique index that exists only in Postgres — and the test that
 * matters most here ("can join again afterwards") is meaningless against a
 * fake, because what it really asserts is that the index slot was released.
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

/** `periodEnd` in the PAST makes a LAPSED paid row — spec §9's trap, exactly. */
async function memberOf(
  ownerId: string,
  subscriberId: string,
  kind: "free" | "paid",
  periodEnd: Date | null = new Date("2099-01-01T00:00:00.000Z")
) {
  const tier = await tiers.create({
    ownerId,
    name: kind === "free" ? "Gratis" : "Anggota",
    priceAmount: kind === "free" ? 0 : 50_000,
    billingCycle: "monthly",
  });
  const claim = await subs.claimPending({ subscriberId, tierId: tier.id, ownerId, kind });
  await subs.activate(claim.subscription.id, new Date("2099-01-01T00:00:00.000Z"));
  await db
    .update(userSubscriptions)
    .set({ currentPeriodEnd: kind === "free" ? null : periodEnd })
    .where(eq(userSubscriptions.id, claim.subscription.id));
  return claim.subscription.id;
}

describe("LeaveMembership", () => {
  it("lets a FREE member leave", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "free");

    await new LeaveMembership(users, subs).execute({
      subscriberId: budi.id,
      ownerHandle: rina.handle,
    });

    expect(await subs.findActiveFor(budi.id, rina.id, null /* personal membership — Phase 5 scope */)).toBeNull();
  });

  /**
   * The asymmetry with revocation, pinned. An OWNER may not end a paid
   * membership — that would be taking money and cutting the service, with no
   * refund path. The MEMBER may, because it is their own money.
   */
  it("lets a PAYING member leave while still inside their paid period", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "paid", new Date("2099-01-01T00:00:00.000Z"));

    await new LeaveMembership(users, subs).execute({
      subscriberId: budi.id,
      ownerHandle: rina.handle,
    });

    expect(await subs.findActiveFor(budi.id, rina.id, null /* personal membership — Phase 5 scope */)).toBeNull();
  });

  /**
   * SPEC §9's TRAP, AND ITS EXIT — the reason this use case matters more than
   * convenience. There is no renewal pass, so every paying member eventually
   * sits `active` with a `current_period_end` in the past, and
   * `StartUserSubscription`'s deliberately status-only guard then refuses them
   * BOTH a new purchase and a free request, for ever. Retiring the row is the
   * only way out, and until now nothing could.
   */
  it("retires a LAPSED paid row, which is the only way its holder can ever rejoin", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    await memberOf(rina.id, budi.id, "paid", new Date("2026-01-01T00:00:00.000Z"));
    // The trap: the row is lapsed, so it grants nothing — and it still holds
    // the one-active slot, so nothing new can be created for this pair.
    expect((await subs.findActiveFor(budi.id, rina.id, null /* personal membership — Phase 5 scope */))?.status).toBe("active");

    await new LeaveMembership(users, subs).execute({
      subscriberId: budi.id,
      ownerHandle: rina.handle,
    });

    // The slot is free, so they can be a member again. Proven by doing it.
    const second = await memberOf(rina.id, budi.id, "free");
    expect((await subs.findActiveFor(budi.id, rina.id, null /* personal membership — Phase 5 scope */))?.id).toBe(second);
  });

  it("cannot end somebody else's membership", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    const sinta = await createUser("sinta");
    await memberOf(rina.id, budi.id, "free");

    await expect(
      new LeaveMembership(users, subs).execute({
        subscriberId: sinta.id,
        ownerHandle: rina.handle,
      })
    ).rejects.toThrow(NotFoundError);

    expect((await subs.findActiveFor(budi.id, rina.id, null /* personal membership — Phase 5 scope */))?.status).toBe("active");
  });

  it("answers the same NotFoundError for an unknown creator as for a non-membership", async () => {
    const budi = await createUser("budi");

    await expect(
      new LeaveMembership(users, subs).execute({
        subscriberId: budi.id,
        ownerHandle: "tidak-ada-kreator-ini",
      })
    ).rejects.toThrow(NotFoundError);
  });
});
