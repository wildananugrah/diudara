import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { communities, creators, joinRequests, members, membershipTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleJoinRequestRepository } from "./drizzle-join-request.repository";

beforeEach(resetDatabase);

const repo = new DrizzleJoinRequestRepository(db);

let seedCounter = 0;

/**
 * A creator → free community → tier → member chain, i.e. what a member sees
 * before asking to join. No subscription and no transaction — this is the
 * free path, which never creates either.
 *
 * `memberName` defaults to a real name; pass `null` for tests about the case
 * `PendingJoinRequestRow.memberName` exists to report honestly.
 */
async function seedFreeCommunity(memberName: string | null = "Siti") {
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
    .values({ whatsappNumber: `+62811000${String(seedCounter).padStart(4, "0")}`, name: memberName })
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

  it("succeeds again after the first request was REJECTED — re-requesting is allowed, there is no blocklist", async () => {
    // The index is partial (`WHERE status = 'pending'`) precisely so a decided row
    // never blocks a future request. Drop that clause and every test elsewhere in
    // this file still passes — this is the one test that would fail, which is the
    // whole reason the index is partial rather than total.
    const { community, tier, member } = await seedFreeCommunity();
    const first = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });
    expect(first).not.toBeNull();
    const decided = await repo.decide({
      id: first!.id,
      status: "rejected",
      decidedBy: (await seedFreeCommunity()).creator.id,
      decidedAt: new Date(),
    });
    expect(decided).toBe(true);

    const second = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });

    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.status).toBe("pending");
  });

  it("lets exactly ONE of several concurrent submits for the same (community, member) win", async () => {
    const { community, tier, member } = await seedFreeCommunity();
    const latch = new ArrivalLatch(4);

    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await latch.arriveAndWait();
        return repo.createPending({
          communityId: community.id,
          tierId: tier.id,
          memberId: member.id,
        });
      })
    );

    expect(results.filter((row) => row !== null)).toHaveLength(1);
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

  it("lets exactly ONE of several concurrent deciders win", async () => {
    // Two owners' browser tabs, or one owner double-clicking approve — the predicate
    // in the UPDATE, not a preceding read, is what has to decide this.
    const { community, tier, member } = await seedFreeCommunity();
    const { creator: owner } = await seedFreeCommunity();
    const request = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });
    const latch = new ArrivalLatch(4);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, async (_unused, index) => {
        await latch.arriveAndWait();
        return repo.decide({
          id: request!.id,
          status: index % 2 === 0 ? "approved" : "rejected",
          decidedBy: owner.id,
          decidedAt: new Date(Date.UTC(2026, 7, 13, index)),
        });
      })
    );

    expect(outcomes.filter((won) => won)).toHaveLength(1);
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
    expect(rows[0].memberName).toBe(member.name);
    expect(rows[0].memberWhatsappNumber).toBe(member.whatsappNumber);
    expect(rows[0].tierId).toBe(tier.id);
    expect(rows[0].tierName).toBe(tier.name);
  });

  it("reports a NULL member name as null, verbatim — a WhatsApp-only signup may have none", async () => {
    // The path the memberName: string -> string | null deviation was about. A
    // repository coalescing this to '' would make it untestable that the column is
    // actually reported honestly rather than papered over.
    const { community, tier, member } = await seedFreeCommunity(null);
    expect(member.name).toBeNull();
    const pending = await repo.createPending({
      communityId: community.id,
      tierId: tier.id,
      memberId: member.id,
    });

    const rows = await repo.listPendingForCommunity(community.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending!.id);
    expect(rows[0].memberName).toBeNull();
  });
});
