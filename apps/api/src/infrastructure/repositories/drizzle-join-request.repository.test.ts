import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  appUsers,
  communities,
  creators,
  joinRequests,
  members,
  membershipTiers,
} from "../../db/schema";
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

  /**
   * FOUR CONTENDERS, AND THE NUMBER IS MEASURED RATHER THAN INHERITED.
   *
   * `decide()` is `UPDATE … WHERE id = ? AND status = 'pending'` — a CONDITIONAL
   * UPDATE, not an insert arbitrated by a unique index. That is structurally the
   * same shape as `beginXenditAccountProvisioning`, where memberships-5a's review
   * round 1 (F1) measured a four-contender latch staying green across 5 runs
   * against the exact bug it existed to catch: check-then-act lets one winner
   * through in 1 contest out of 4, which reads as correct, but in 27 of 30. That
   * test was raised to 30.
   *
   * So this one was measured too, by the final whole-branch review, applying F1's
   * own mutant — the conditional UPDATE replaced by a SELECT followed by an
   * unconditional one, production code otherwise untouched. **This test failed
   * 5 runs out of 5 at four contenders**, and the mutant was reverted and
   * confirmed byte-identical.
   *
   * WHY IT HOLDS HERE AND NOT THERE: in this call path every contender's SELECT
   * issues before any UPDATE returns, so all four genuinely observe `pending`.
   * That is a property of the surrounding awaits, not of the number — do not read
   * "four is enough" as a general rule, and do not lower it here.
   */
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

describe("DrizzleJoinRequestRepository.findNotificationContext", () => {
  /**
   * Like `seedFreeCommunity`, but with a configurable `creator.whatsapp_number`
   * — this describe block is the one place that column's nullability matters.
   */
  async function seedWithCreatorWhatsapp(
    creatorWhatsappNumber: string | null,
    /**
     * `undefined` generates a unique address; pass `null` for the
     * WhatsApp-only creator `creator_email_unique`'s partial predicate allows,
     * who has no address to join an account on.
     */
    creatorEmail?: string | null
  ) {
    seedCounter += 1;
    const [creator] = await db
      .insert(creators)
      .values({
        name: "Rina",
        email: creatorEmail === undefined ? `rina-notify-${seedCounter}@example.com` : creatorEmail,
        whatsappNumber: creatorWhatsappNumber ?? undefined,
      })
      .returning();
    const [community] = await db
      .insert(communities)
      .values({
        creatorId: creator.id,
        name: "Kelas Rina",
        slug: `kelas-rina-notify-${seedCounter}`,
        accessMode: "request",
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
        name: "Siti",
      })
      .returning();
    const [request] = await db
      .insert(joinRequests)
      .values({ communityId: community.id, tierId: tier.id, memberId: member.id })
      .returning();
    return { creator, community, tier, member, request };
  }

  it("resolves the community, member, tier and creator names in one join", async () => {
    const { creator, community, tier, member, request } = await seedWithCreatorWhatsapp(
      "+628130001111"
    );

    const context = await repo.findNotificationContext(request.id);

    expect(context).toEqual({
      id: request.id,
      communityId: community.id,
      communityName: community.name,
      memberId: member.id,
      memberName: member.name,
      tierName: tier.name,
      creatorWhatsappNumber: creator.whatsappNumber,
    });
  });

  it("reports a NULL creator whatsapp_number as null, verbatim", async () => {
    const { request } = await seedWithCreatorWhatsapp(null);

    const context = await repo.findNotificationContext(request.id);

    expect(context).not.toBeNull();
    expect(context!.creatorWhatsappNumber).toBeNull();
  });

  it("reports a NULL member name as null, same rule as listPendingForCommunity", async () => {
    seedCounter += 1;
    const [creator] = await db
      .insert(creators)
      .values({ name: "Rina", email: `rina-notify-nullname-${seedCounter}@example.com` })
      .returning();
    const [community] = await db
      .insert(communities)
      .values({
        creatorId: creator.id,
        name: "Kelas Rina",
        slug: `kelas-rina-notify-nullname-${seedCounter}`,
        accessMode: "request",
      })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({ communityId: community.id, name: "Free", priceAmount: 0, billingCycle: "monthly" })
      .returning();
    const [member] = await db
      .insert(members)
      .values({ whatsappNumber: `+62812111${String(seedCounter).padStart(4, "0")}`, name: null })
      .returning();
    const [request] = await db
      .insert(joinRequests)
      .values({ communityId: community.id, tierId: tier.id, memberId: member.id })
      .returning();

    const context = await repo.findNotificationContext(request.id);

    expect(context).not.toBeNull();
    expect(context!.memberName).toBeNull();
  });

  it("returns null for an id with no join request", async () => {
    expect(
      await repo.findNotificationContext("3f1c9e0a-1111-4222-8333-444455556666")
    ).toBeNull();
  });

  it("reports a malformed id as a miss, not a driver error", async () => {
    expect(await repo.findNotificationContext("not-a-uuid")).toBeNull();
  });

  /**
   * Task 7. `creator.whatsapp_number` has no editor anywhere in the app, so it
   * is null for everybody and the skip path fires every time; the number the
   * owner can actually edit lives on `app_user`. There is NO foreign key
   * between `creator` and `app_user` — the only join available is
   * `creator.email` = `app_user.email`, nullable and unique-when-not-null on
   * one side, not-null and unique on the other, so it resolves to at most one
   * account wherever it resolves at all.
   *
   * Matched with `=`, case-sensitively, deliberately: `RegisterCreator` and
   * `RegisterUser` both lowercase through `normalizeEmail` before inserting,
   * and both `findByEmail`s compare with the same plain `=`, so this join
   * agrees exactly with the two logins it sits between.
   */
  async function seedAccountFor(email: string, whatsappNumber: string | null) {
    seedCounter += 1;
    const [user] = await db
      .insert(appUsers)
      .values({
        handle: `rina${seedCounter}`,
        email,
        whatsappNumber,
        passwordHash: "argon2id$placeholder",
        displayName: "Rina",
      })
      .returning();
    return user;
  }

  it("prefers the owner's app_user number over creator.whatsapp_number when both exist", async () => {
    const { creator, request } = await seedWithCreatorWhatsapp("+628130001111");
    await seedAccountFor(creator.email!, "+628999990001");

    const context = await repo.findNotificationContext(request.id);

    // The literal app_user number, not the constant and not the creator's:
    // app_user's is the one the owner can edit, so it is the fresher truth.
    expect(context!.creatorWhatsappNumber).toBe("+628999990001");
  });

  /**
   * THE ANTI-INNER-JOIN TEST. An INNER JOIN here would silently stop notifying
   * every creator who has no `app_user` account — a fix that removes working
   * notifications from anyone is not a fix. This test fails the moment the
   * `leftJoin` becomes an `innerJoin`.
   */
  it("still resolves a creator who has NO app_user account at all", async () => {
    const { request } = await seedWithCreatorWhatsapp("+628130002222");
    // An unrelated account exists, on a different address: the join must not
    // reach it, and must not require any account to exist to return a row.
    await seedAccountFor(`someone-else-${seedCounter}@example.com`, "+628999990002");

    const context = await repo.findNotificationContext(request.id);

    expect(context).not.toBeNull();
    expect(context!.creatorWhatsappNumber).toBe("+628130002222");
  });

  it("falls back to creator.whatsapp_number when the matching account has none", async () => {
    const { creator, request } = await seedWithCreatorWhatsapp("+628130003333");
    await seedAccountFor(creator.email!, null);

    const context = await repo.findNotificationContext(request.id);

    expect(context!.creatorWhatsappNumber).toBe("+628130003333");
  });

  it("a creator with a NULL email matches no account, rather than an arbitrary one", async () => {
    const { request } = await seedWithCreatorWhatsapp("+628130004444", null);
    await seedAccountFor(`unrelated-${seedCounter}@example.com`, "+628999990004");

    const context = await repo.findNotificationContext(request.id);

    expect(context).not.toBeNull();
    expect(context!.creatorWhatsappNumber).toBe("+628130004444");
  });

  it("reports null when neither the creator nor their account has a number", async () => {
    const { creator, request } = await seedWithCreatorWhatsapp(null);
    await seedAccountFor(creator.email!, null);

    const context = await repo.findNotificationContext(request.id);

    expect(context).not.toBeNull();
    expect(context!.creatorWhatsappNumber).toBeNull();
  });
});
