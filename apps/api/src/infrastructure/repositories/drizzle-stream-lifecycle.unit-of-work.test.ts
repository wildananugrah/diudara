import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { activityLogs, communities, creators, events, outbox } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleStreamLifecycleUnitOfWork } from "./drizzle-stream-lifecycle.unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzleStreamLifecycleUnitOfWork(db);

let seedCounter = 0;

/** A scheduled event, and the community it belongs to — the minimum `run()` needs. */
async function seedScheduledEvent() {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-rina-${seedCounter}`,
    })
    .returning();
  const [event] = await db
    .insert(events)
    .values({
      communityId: community.id,
      title: "Live Q&A",
      streamKey: `key-${seedCounter}`,
      status: "scheduled",
    })
    .returning();
  return event!;
}

/**
 * Pins the thing `handle-stream-lifecycle.test.ts` cannot: that this real Drizzle
 * adapter — not a hand-built fake standing in for it — genuinely opens a Postgres
 * transaction, and that a throw inside `run()` rolls back EVERYTHING it did:
 * the `event.status` transition, the `activity_log` row, and every enqueued
 * outbox row, all together.
 *
 * `handle-stream-lifecycle.test.ts`'s own atomicity test swaps in a fake unit of
 * work whose outbox repository is engineered to fail — a good test of
 * `HandleStreamLifecycle` (it proves the USE-CASE puts every write inside one
 * `run()` call), but it opens its OWN `db.transaction` regardless of what this
 * adapter does, so it would keep passing even if this file's `run()` stopped
 * opening a transaction at all. Review round 2 asked for a test that exercises
 * THIS adapter directly, against the real database, and this is it — mirroring
 * `drizzle-payment-activation.unit-of-work.test.ts` exactly, for the same reason.
 */
describe("DrizzleStreamLifecycleUnitOfWork", () => {
  it("rolls back the transition, the activity_log row, and every enqueued outbox row when the work throws", async () => {
    const event = await seedScheduledEvent();

    await expect(
      unitOfWork().run(async (repositories) => {
        const updated = await repositories.events.markLive(event.id);
        if (!updated) {
          throw new Error("expected markLive to transition a scheduled event");
        }
        await repositories.activityLog.record({
          memberId: null,
          communityId: updated.communityId,
          eventType: "stream_live",
          metadata: { eventId: updated.id },
        });
        await repositories.outbox.enqueueMany([
          { eventType: "notify_stream_live", payload: { eventId: updated.id, subscriptionId: "sub-1" } },
          { eventType: "notify_stream_live", payload: { eventId: updated.id, subscriptionId: "sub-2" } },
        ]);
        // Anything that fails after every write: a commit error, a deadlock, a
        // bug. None of the above must survive it.
        throw new Error("boom, after every write");
      })
    ).rejects.toThrow("boom, after every write");

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("scheduled");
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it("commits the transition with the activity_log row and every outbox row when the work succeeds", async () => {
    const event = await seedScheduledEvent();

    await unitOfWork().run(async (repositories) => {
      const updated = await repositories.events.markLive(event.id);
      await repositories.activityLog.record({
        memberId: null,
        communityId: updated!.communityId,
        eventType: "stream_live",
        metadata: { eventId: updated!.id },
      });
      await repositories.outbox.enqueueMany([
        { eventType: "notify_stream_live", payload: { eventId: updated!.id, subscriptionId: "sub-1" } },
        { eventType: "notify_stream_live", payload: { eventId: updated!.id, subscriptionId: "sub-2" } },
      ]);
    });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");
    expect(await db.select().from(activityLogs)).toHaveLength(1);
    expect(await db.select().from(outbox)).toHaveLength(2);
  });

  it("keeps the transition invisible to a pooled reader until it commits", async () => {
    // The other half of "inside the transaction": a pooled reader must not see
    // the status flip while the unit of work is still open. If any of the four
    // repositories `run()` hands out were bound to the pool instead of `tx`,
    // this read would find `live` already — the UPDATE would have committed on
    // its own connection.
    const event = await seedScheduledEvent();
    let statusMidTransaction: string | undefined;

    await unitOfWork().run(async (repositories) => {
      await repositories.events.markLive(event.id);
      const [row] = await db.select().from(events).where(eq(events.id, event.id));
      statusMidTransaction = row!.status;
    });

    expect(statusMidTransaction).toBe("scheduled");
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");
  });
});
