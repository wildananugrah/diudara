import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators, joinRequests, members, membershipTiers, outbox } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleJoinRequestUnitOfWork } from "./drizzle-join-request-unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzleJoinRequestUnitOfWork(db);

/**
 * A creator → free community → tier → member chain, mirroring
 * `drizzle-join-request.repository.test.ts`'s own seed helper.
 */
async function seedFreeCommunity() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", email: "rina@example.com" })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: "kelas-rina", accessMode: "request" })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId: community.id, name: "Gratis", priceAmount: 0, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: "+628110001111", name: "Siti" })
    .returning();
  return { creator, community, tier, member };
}

/**
 * Pins the thing the request-to-join use-case test cannot prove with a fake unit
 * of work: that `joinRequests` and `outbox` handed to the work function are BOTH
 * bound to the same real Postgres transaction — mirrors
 * `DrizzlePaymentActivationUnitOfWork`'s own test file exactly.
 */
describe("DrizzleJoinRequestUnitOfWork", () => {
  it("discards the created request and the enqueued notification together on rollback", async () => {
    const { community, tier, member } = await seedFreeCommunity();

    await expect(
      unitOfWork().run(async (repositories) => {
        const request = await repositories.joinRequests.createPending({
          communityId: community.id,
          tierId: tier.id,
          memberId: member.id,
        });
        await repositories.outbox.enqueue({
          eventType: "notify_join_request",
          payload: { joinRequestId: request?.id },
        });
        // Anything that fails after the intent to notify was written: a commit
        // error, a deadlock, a bug. Neither row may survive it.
        throw new Error("boom, after the enqueue");
      })
    ).rejects.toThrow("boom, after the enqueue");

    expect(await db.select().from(joinRequests)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it("commits the request and its notification together when the work succeeds", async () => {
    const { community, tier, member } = await seedFreeCommunity();

    await unitOfWork().run(async (repositories) => {
      const request = await repositories.joinRequests.createPending({
        communityId: community.id,
        tierId: tier.id,
        memberId: member.id,
      });
      await repositories.outbox.enqueue({
        eventType: "notify_join_request",
        payload: { joinRequestId: request?.id },
      });
    });

    const requestRows = await db.select().from(joinRequests);
    expect(requestRows).toHaveLength(1);
    const outboxRows = await db.select().from(outbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe("pending");
    expect((outboxRows[0].payload as { joinRequestId: string }).joinRequestId).toBe(
      requestRows[0].id
    );
  });

  it("keeps the enqueued row invisible outside the transaction until it commits", async () => {
    const { community, tier, member } = await seedFreeCommunity();
    let visibleMidTransaction = -1;

    await unitOfWork().run(async (repositories) => {
      await repositories.joinRequests.createPending({
        communityId: community.id,
        tierId: tier.id,
        memberId: member.id,
      });
      await repositories.outbox.enqueue({
        eventType: "notify_join_request",
        payload: {},
      });
      visibleMidTransaction = (await db.select().from(outbox)).length;
    });

    expect(visibleMidTransaction).toBe(0);
    expect(await db.select().from(outbox)).toHaveLength(1);
  });

  /**
   * Fix round 1, Critical: a bare INSERT caught for `23505` returns a clean `null`
   * on its own, but Postgres has already ABORTED THE TRANSACTION by the time the
   * catch runs — every statement after it fails with "current transaction is
   * aborted, commands ignored until end of transaction block" until a ROLLBACK.
   * `RequestToJoin` calls `createPending` from inside exactly this unit of work and
   * then goes on to `outbox.enqueue` in the SAME transaction on success, so a caught
   * `23505` here would only ever look safe in a test that never performs a second
   * write afterwards. This test performs one, and would have failed against the
   * try/catch implementation.
   */
  it("keeps the transaction usable after createPending refuses a duplicate — the null must not abort it", async () => {
    const { community, tier, member } = await seedFreeCommunity();

    // A first pending request, committed in its own transaction.
    await unitOfWork().run(async (repositories) => {
      const created = await repositories.joinRequests.createPending({
        communityId: community.id,
        tierId: tier.id,
        memberId: member.id,
      });
      expect(created).not.toBeNull();
    });

    let secondWriteSucceeded = false;
    await unitOfWork().run(async (repositories) => {
      const duplicate = await repositories.joinRequests.createPending({
        communityId: community.id,
        tierId: tier.id,
        memberId: member.id,
      });
      expect(duplicate).toBeNull();

      // THE assertion this test exists for: a statement AFTER the refused
      // duplicate, in the SAME transaction, must still succeed.
      await repositories.outbox.enqueue({ eventType: "notify_join_request", payload: {} });
      secondWriteSucceeded = true;
    });

    expect(secondWriteSucceeded).toBe(true);
    // Exactly the ONE row from the first, successful request — the duplicate
    // attempt created nothing, but its refusal did not roll back or corrupt the
    // enqueue that followed it in the same transaction.
    expect(await db.select().from(joinRequests)).toHaveLength(1);
    expect(await db.select().from(outbox)).toHaveLength(1);
  });
});
