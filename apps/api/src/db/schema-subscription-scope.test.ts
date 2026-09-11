import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { appUsers, communities, userSubscriptions, userTiers } from "./schema";
import { resetDatabase } from "./test-helpers";

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function constraintNameOf(error: unknown): unknown {
  return (error as { cause?: { constraint_name?: unknown } } | null)?.cause?.constraint_name;
}

let counter = 0;

async function seedUser(prefix: string) {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `${prefix}${counter}`,
      email: `${prefix}${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `${prefix} ${counter}`,
    })
    .returning();
  return user!;
}

/** An owner with a personal tier and two communities, each with its own tier. */
async function seedSeller() {
  const owner = await seedUser("seller");
  const [personalTier] = await db
    .insert(userTiers)
    .values({ ownerId: owner.id, name: "Pendukung", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();

  const makeCommunity = async () => {
    counter += 1;
    const [community] = await db
      .insert(communities)
      .values({
        ownerId: owner.id,
        name: `Kelas ${counter}`,
        slug: `kelas-${counter}`,
        category: "Bimbel & Ujian",
      })
      .returning();
    const [tier] = await db
      .insert(userTiers)
      .values({
        ownerId: owner.id,
        communityId: community!.id,
        name: "Premium",
        priceAmount: 99_000,
        billingCycle: "monthly",
      })
      .returning();
    return { communityId: community!.id, tier: tier! };
  };

  return { owner, personalTier: personalTier!, first: await makeCommunity(), second: await makeCommunity() };
}

describe("user_subscription_one_active, scoped by community", () => {
  beforeEach(resetDatabase);

  /**
   * **The case that blocked this phase.** A community tier's owner is a
   * person who may also sell personal tiers, so before `community_id` joined
   * the key this insert violated the unique index — a buyer doing something
   * entirely reasonable got a constraint error at checkout.
   */
  test("a buyer may hold a personal AND a community subscription to the same owner", async () => {
    const { owner, personalTier, first } = await seedSeller();
    const buyer = await seedUser("buyer");

    await db.insert(userSubscriptions).values({
      subscriberId: buyer.id,
      tierId: personalTier.id,
      ownerId: owner.id,
      status: "active",
    });

    const error = await captureError(() =>
      db.insert(userSubscriptions).values({
        subscriberId: buyer.id,
        tierId: first.tier.id,
        ownerId: owner.id,
        communityId: first.communityId,
        status: "active",
      })
    );

    expect(error).toBeNull();
  });

  test("and one in each of the owner's two communities", async () => {
    const { owner, first, second } = await seedSeller();
    const buyer = await seedUser("buyer");
    const base = { subscriberId: buyer.id, ownerId: owner.id, status: "active" as const };

    await db.insert(userSubscriptions).values({
      ...base,
      tierId: first.tier.id,
      communityId: first.communityId,
    });

    const error = await captureError(() =>
      db.insert(userSubscriptions).values({
        ...base,
        tierId: second.tier.id,
        communityId: second.communityId,
      })
    );

    expect(error).toBeNull();
  });

  /**
   * **The guarantee that must SURVIVE the change**, and the one a plain
   * nullable column in a unique index silently destroys: Postgres treats
   * NULLs as distinct by default, so two personal rows would both be allowed.
   * `NULLS NOT DISTINCT` is what keeps this red.
   */
  test("but still never two live PERSONAL memberships to the same person", async () => {
    const { owner, personalTier } = await seedSeller();
    const buyer = await seedUser("buyer");
    const row = {
      subscriberId: buyer.id,
      tierId: personalTier.id,
      ownerId: owner.id,
      status: "active" as const,
    };

    await db.insert(userSubscriptions).values(row);
    const error = await captureError(() => db.insert(userSubscriptions).values(row));

    expect(error).not.toBeNull();
    // The PERSONAL half of the pair. Postgres treats NULLs as distinct, so the
    // three-column index does not constrain personal rows at all — this partial
    // one is what holds them, and naming it is what would catch its removal.
    expect(constraintNameOf(error)).toBe("user_subscription_one_active_personal");
  });

  test("and never two live memberships of the SAME community", async () => {
    const { owner, first } = await seedSeller();
    const buyer = await seedUser("buyer");
    const row = {
      subscriberId: buyer.id,
      tierId: first.tier.id,
      ownerId: owner.id,
      communityId: first.communityId,
      status: "active" as const,
    };

    await db.insert(userSubscriptions).values(row);
    const error = await captureError(() => db.insert(userSubscriptions).values(row));

    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("user_subscription_one_active");
  });

  /** The pending index is the same shape one step earlier, so it gets the same scope. */
  test("the pending index is scoped the same way, in both directions", async () => {
    const { owner, personalTier, first } = await seedSeller();
    const buyer = await seedUser("buyer");

    await db.insert(userSubscriptions).values({
      subscriberId: buyer.id,
      tierId: personalTier.id,
      ownerId: owner.id,
      status: "pending",
    });
    // A community checkout alongside a pending personal one is allowed.
    expect(
      await captureError(() =>
        db.insert(userSubscriptions).values({
          subscriberId: buyer.id,
          tierId: first.tier.id,
          ownerId: owner.id,
          communityId: first.communityId,
          status: "pending",
        })
      )
    ).toBeNull();

    // A SECOND pending personal one is still refused.
    const error = await captureError(() =>
      db.insert(userSubscriptions).values({
        subscriberId: buyer.id,
        tierId: personalTier.id,
        ownerId: owner.id,
        status: "pending",
      })
    );
    expect(constraintNameOf(error)).toBe("user_subscription_one_pending_personal");
  });

  /**
   * The denormalised `community_id` must agree with its tier's, and a
   * composite foreign key is what makes disagreement impossible to insert —
   * the same trick `user_subscription_tier_owner_fk` already plays for
   * `owner_id`, rather than an invariant somebody has to remember.
   */
  test("a subscription cannot claim a community its tier does not belong to", async () => {
    const { owner, first, second } = await seedSeller();
    const buyer = await seedUser("buyer");

    const error = await captureError(() =>
      db.insert(userSubscriptions).values({
        subscriberId: buyer.id,
        tierId: first.tier.id,
        ownerId: owner.id,
        // The OTHER community.
        communityId: second.communityId,
        status: "active",
      })
    );

    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("user_subscription_tier_community_fk");
  });

  test("and a personal tier cannot be sold as a community membership", async () => {
    const { owner, personalTier, first } = await seedSeller();
    const buyer = await seedUser("buyer");

    const error = await captureError(() =>
      db.insert(userSubscriptions).values({
        subscriberId: buyer.id,
        tierId: personalTier.id,
        ownerId: owner.id,
        communityId: first.communityId,
        status: "active",
      })
    );

    expect(error).not.toBeNull();
  });
});
