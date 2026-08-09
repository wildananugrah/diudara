import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import {
  channels,
  channelMemberships,
  communities,
  creators,
  members,
  membershipTiers,
  outbox,
  subscriptions,
} from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

async function seed() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${Date.now()}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({ communityId: community.id, platform: "telegram", externalGroupId: "-100123" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  return { community, channel, member };
}

describe("phase 4 schema", () => {
  it("defaults an outbox row to pending with no attempts", async () => {
    const [row] = await db
      .insert(outbox)
      .values({ eventType: "grant_access", payload: { subscriptionId: "s1" } })
      .returning();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("rejects a second membership for the same member and channel", async () => {
    const { channel, member } = await seed();
    await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id });

    let failed = false;
    try {
      await db
        .insert(channelMemberships)
        .values({ memberId: member.id, channelId: channel.id });
    } catch {
      failed = true;
    }

    // This constraint IS the grant-idempotency mechanism. If it is not in the
    // database, a retried outbox row issues a second invite link.
    expect(failed).toBe(true);
    expect((await db.select().from(channelMemberships)).length).toBe(1);
  });

  /**
   * Task 7 item 3. A double-submit at checkout creates two PENDING subscriptions
   * for one (member, tier); Phase 4 is the first phase to act on one, and two
   * activations mean two single-use invite links for the same member.
   *
   * `markPaid`'s `not exists` predicate handles the ordinary case, but under READ
   * COMMITTED two concurrent activations cannot see each other's uncommitted row,
   * so the predicate alone is a TOCTOU. THIS INDEX is the arbiter — the test lives
   * here, beside the membership constraint, because both are "the database decides"
   * mechanisms and both must exist in the database rather than only in schema.ts.
   */
  describe("subscription_member_tier_active_unique", () => {
    async function seedTierAndMember() {
      const { community, member } = await seed();
      const [tier] = await db
        .insert(membershipTiers)
        .values({
          communityId: community.id,
          name: "Basic",
          priceAmount: 50000,
          billingCycle: "monthly",
        })
        .returning();
      return { tier, member };
    }

    it("refuses a second ACTIVE subscription for the same member and tier", async () => {
      const { tier, member } = await seedTierAndMember();
      await db
        .insert(subscriptions)
        .values({ memberId: member.id, tierId: tier.id, status: "active" });

      let violation: { constraint_name?: string } | undefined;
      try {
        await db
          .insert(subscriptions)
          .values({ memberId: member.id, tierId: tier.id, status: "active" });
      } catch (err) {
        violation = (err as { cause?: { constraint_name?: string } }).cause;
      }

      expect(violation?.constraint_name).toBe("subscription_member_tier_active_unique");
      expect(await db.select().from(subscriptions)).toHaveLength(1);
    });

    it("PERMITS duplicates in any other status — it is partial on purpose", async () => {
      // Two pending subscriptions is exactly the double-submit this phase resolves,
      // and cancelled/expired history must accumulate freely. A total unique index
      // would break re-subscribing after a churn.
      const { tier, member } = await seedTierAndMember();

      for (const status of ["pending", "pending", "cancelled", "cancelled", "expired"]) {
        await db.insert(subscriptions).values({ memberId: member.id, tierId: tier.id, status });
      }
      // Plus exactly one active alongside them.
      await db
        .insert(subscriptions)
        .values({ memberId: member.id, tierId: tier.id, status: "active" });

      expect(await db.select().from(subscriptions)).toHaveLength(6);
    });
  });

  it("defaults a membership to active", async () => {
    const { channel, member } = await seed();
    const [row] = await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id })
      .returning();
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
  });
});
