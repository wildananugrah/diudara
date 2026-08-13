import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { communities, creators, joinRequests, members, membershipTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleJoinRequestRepository } from "./drizzle-join-request.repository";

beforeEach(resetDatabase);

const repo = new DrizzleJoinRequestRepository(db);

let seedCounter = 0;

/**
 * A creator → free community → tier → member chain, i.e. what a member sees
 * before asking to join. No subscription and no transaction — this is the
 * free path, which never creates either.
 */
async function seedFreeCommunity() {
  seedCounter += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", email: `rina-${seedCounter}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-rina-${seedCounter}`,
      accessMode: "free",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId: community.id, name: "Free", priceAmount: 0, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62811000${String(seedCounter).padStart(4, "0")}`, name: "Siti" })
    .returning();
  return { creator, community, tier, member };
}

describe("DrizzleJoinRequestRepository.createPending", () => {
  it("creates a pending join request", async () => {
    const { community, tier, member } = await seedFreeCommunity();

    const request = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });

    expect(request).not.toBeNull();
    expect(request?.status).toBe("pending");
    expect(request?.communityId).toBe(community.id);
    expect(request?.tierId).toBe(tier.id);
    expect(request?.memberId).toBe(member.id);
    expect(request?.decidedAt).toBeNull();
    expect(request?.decidedBy).toBeNull();
  });

  it("returns null for a second pending request from the same member in the same community, and the first still exists", async () => {
    const { community, tier, member } = await seedFreeCommunity();
    const first = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });
    expect(first).not.toBeNull();

    const second = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });

    expect(second).toBeNull();
    // The unique index rejected the second insert — it did not overwrite the first.
    const rows = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.communityId, community.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first!.id);
  });

  it("succeeds for the same member asking to join a DIFFERENT community", async () => {
    const { community: communityA, tier: tierA, member } = await seedFreeCommunity();
    // A second community, sharing nothing but the member.
    const { community: communityB, tier: tierB } = await seedFreeCommunity();

    const requestA = await repo.createPending({
      communityId: communityA.id,
      tierId: tierA.id,
      memberId: member.id,
    });
    const requestB = await repo.createPending({
      communityId: communityB.id,
      tierId: tierB.id,
      memberId: member.id,
    });

    expect(requestA).not.toBeNull();
    expect(requestB).not.toBeNull();
  });
});

describe("DrizzleJoinRequestRepository.decide", () => {
  it("returns true once, and false on a second call for the same id", async () => {
    const { community, tier, member } = await seedFreeCommunity();
    const { creator: owner } = await seedFreeCommunity();
    const request = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });
    const decidedAt = new Date("2026-08-13T00:00:00Z");

    const first = await repo.decide({
      id: request!.id,
      status: "approved",
      decidedBy: owner.id,
      decidedAt,
    });
    const second = await repo.decide({
      id: request!.id,
      status: "approved",
      decidedBy: owner.id,
      decidedAt,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const decided = await repo.findById(request!.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toBe(owner.id);
    expect(decided?.decidedAt?.toISOString()).toBe(decidedAt.toISOString());
  });
});

describe("DrizzleJoinRequestRepository.listPendingForCommunity", () => {
  it("returns only pending rows, joined with the member's name, WhatsApp number, and the tier name", async () => {
    const { community, tier, member } = await seedFreeCommunity();
    const pending = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });

    const other = await seedFreeCommunity();
    const decided = await repo.createPending({
      communityId: community.id,
      tierId: other.tier.id,
      memberId: other.member.id,
    });
    await repo.decide({
      id: decided!.id,
      status: "rejected",
      decidedBy: (await seedFreeCommunity()).creator.id,
      decidedAt: new Date(),
    });

    const rows = await repo.listPendingForCommunity(community.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending!.id);
    expect(rows[0].memberId).toBe(member.id);
    expect(rows[0].memberName).toBe(member.name ?? "");
    expect(rows[0].memberWhatsappNumber).toBe(member.whatsappNumber);
    expect(rows[0].tierId).toBe(tier.id);
    expect(rows[0].tierName).toBe(tier.name);
  });
});
