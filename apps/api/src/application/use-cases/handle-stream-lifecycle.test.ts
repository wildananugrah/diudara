import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  communities,
  creators,
  events,
  members,
  membershipTiers,
  outbox,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleStreamLifecycleUnitOfWork } from "../../infrastructure/repositories/drizzle-stream-lifecycle.unit-of-work";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import type {
  StreamLifecycleRepositories,
  StreamLifecycleUnitOfWorkPort,
} from "../ports/stream-lifecycle-unit-of-work.port";
import { OUTBOX_NOTIFY_STREAM_LIVE, type OutboxRepositoryPort } from "../ports/outbox-repository.port";
import { HandleStreamLifecycle, STREAM_ENDED_EVENT, STREAM_LIVE_EVENT } from "./handle-stream-lifecycle";

beforeEach(resetDatabase);

const unitOfWork = new DrizzleStreamLifecycleUnitOfWork(db);
const useCase = new HandleStreamLifecycle(unitOfWork);

let seedCounter = 0;

/** A fresh community, owned by a fresh creator — the minimum an event needs. */
async function seedCommunity(name = "Rina") {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: `Kelas ${name}`,
      slug: `kelas-${name.toLowerCase()}-${seedCounter}`,
    })
    .returning();
  return community;
}

/**
 * One event in `communityId`, at the given `status`, with a fresh RAW stream key
 * (the value `event.stream_key` actually holds, e.g. `"key-3"`) — NOT the
 * `live/<key>` path shape MediaMTX's `$MTX_PATH` carries. Callers build that
 * shape themselves when calling `execute`, via `livePath(streamKey)` below, so
 * every test is explicit about which value plays which role.
 */
async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const key = `key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey: key,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${key}/index.m3u8`,
    })
    .returning();
  return { event: event!, streamKey: key };
}

/** An `active` subscription (and its own member) to a fresh tier of `communityId`. */
async function seedActiveSubscription(communityId: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62812${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status: "active" })
    .returning();
  return subscription!;
}

/** `$MTX_PATH`'s actual shape for this codebase's catch-all path config. */
function livePath(streamKey: string): string {
  return `live/${streamKey}`;
}

async function activityRowsFor(eventId: string) {
  const rows = await db.select().from(activityLogs);
  return rows.filter((row) => (row.metadata as { eventId?: string } | null)?.eventId === eventId);
}

async function outboxRowsFor(eventId: string) {
  const rows = await db.select().from(outbox).where(eq(outbox.eventType, OUTBOX_NOTIFY_STREAM_LIVE));
  return rows.filter((row) => (row.payload as { eventId?: string } | null)?.eventId === eventId);
}

describe("HandleStreamLifecycle — online", () => {
  it("moves a scheduled event to live, with one activity row and no outbox row when nobody is active", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(STREAM_LIVE_EVENT);
    expect(activity[0]!.communityId).toBe(community.id);

    // No active member in this community — nothing to enqueue.
    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });

  it("enqueues one outbox row PER active member — not one row for the whole community", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    const first = await seedActiveSubscription(community.id);
    const second = await seedActiveSubscription(community.id);

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(2);
    const subscriptionIds = enqueued
      .map((row) => (row.payload as { subscriptionId?: string }).subscriptionId)
      .sort();
    expect(subscriptionIds).toEqual([first.id, second.id].sort());
    // Ids only: no community id, no stream key, in any row's payload.
    for (const row of enqueued) {
      const payload = row.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["eventId", "subscriptionId"]);
    }
  });

  it("a second online for the same event still yields exactly the original outbox rows", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    await seedActiveSubscription(community.id);

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });
    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(1);
  });

  it("a member who joins AFTER go-live is not retroactively enqueued a row", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });
    // A member subscribes after the stream already went live.
    await seedActiveSubscription(community.id);
    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });

  it("an unknown stream key writes nothing and does not throw", async () => {
    await expect(
      useCase.execute({ hook: "online", streamKey: livePath("no-such-key") })
    ).resolves.toBeUndefined();

    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
    const enqueued = await db.select().from(outbox);
    expect(enqueued).toHaveLength(0);
  });

  it("a path that is not live/<key> shaped is treated the same as an unknown key", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    // The bare key, with no `live/` prefix — not a shape MediaMTX's own config
    // ever produces (see `streamKeyFromPath`'s docstring in authorise-stream.ts).
    await useCase.execute({ hook: "online", streamKey });

    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });

  /**
   * Critical review finding: the transition, its activity_log row, and every
   * notify_stream_live row must commit or roll back as ONE unit — never the
   * transition first and the notify intents afterwards. `markLive`'s status
   * predicate makes the transition happen AT MOST ONCE, so if the enqueue step
   * were a separate statement and it failed, the event would be stuck `live`
   * forever with no notify row and nothing able to create one.
   *
   * Proven here by swapping in a `StreamLifecycleUnitOfWorkPort` that opens the
   * SAME real transaction `DrizzleStreamLifecycleUnitOfWork` does, but whose
   * outbox repository throws once the second member's row would be enqueued.
   * If the transition and the enqueues were not atomic, the first member's row
   * (and the `live` status, and the activity_log row) would already be
   * committed by the time the throw happens. They must not be.
   */
  it("a failure partway through the per-member fan-out rolls back the ENTIRE transition — no partial commit", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    await seedActiveSubscription(community.id);
    await seedActiveSubscription(community.id);

    let enqueueCalls = 0;
    /** Delegates every method to a real `DrizzleOutboxRepository`, except `enqueue`
     * — which throws on the second call, simulating a crash partway through the
     * per-member fan-out. */
    class ExplodingOutboxRepository implements OutboxRepositoryPort {
      constructor(private readonly real: OutboxRepositoryPort) {}
      async enqueue(input: { eventType: string; payload: unknown }): Promise<{ id: string }> {
        enqueueCalls += 1;
        if (enqueueCalls === 2) {
          throw new Error("simulated failure enqueueing the second member's row");
        }
        return this.real.enqueue(input);
      }
      claimBatch = (...args: Parameters<OutboxRepositoryPort["claimBatch"]>) =>
        this.real.claimBatch(...args);
      touchProcessing = (...args: Parameters<OutboxRepositoryPort["touchProcessing"]>) =>
        this.real.touchProcessing(...args);
      releaseToPending = (...args: Parameters<OutboxRepositoryPort["releaseToPending"]>) =>
        this.real.releaseToPending(...args);
      markSent = (...args: Parameters<OutboxRepositoryPort["markSent"]>) =>
        this.real.markSent(...args);
      markFailed = (...args: Parameters<OutboxRepositoryPort["markFailed"]>) =>
        this.real.markFailed(...args);
      markPermanentlyFailed = (
        ...args: Parameters<OutboxRepositoryPort["markPermanentlyFailed"]>
      ) => this.real.markPermanentlyFailed(...args);
      reclaimStaleProcessing = (
        ...args: Parameters<OutboxRepositoryPort["reclaimStaleProcessing"]>
      ) => this.real.reclaimStaleProcessing(...args);
    }

    class ExplodingOnSecondEnqueueUnitOfWork implements StreamLifecycleUnitOfWorkPort {
      async run<T>(work: (repositories: StreamLifecycleRepositories) => Promise<T>): Promise<T> {
        return db.transaction(async (tx) =>
          work({
            events: new DrizzleEventRepository(tx),
            subscriptions: new DrizzleSubscriptionRepository(tx),
            activityLog: new DrizzleActivityLogRepository(tx),
            outbox: new ExplodingOutboxRepository(new DrizzleOutboxRepository(tx)),
          })
        );
      }
    }

    const explodingUseCase = new HandleStreamLifecycle(new ExplodingOnSecondEnqueueUnitOfWork());

    await expect(
      explodingUseCase.execute({ hook: "online", streamKey: livePath(streamKey) })
    ).rejects.toThrow();

    // The whole unit rolled back: the event is still `scheduled`, not `live`,
    // there is no activity_log row, and NOT EVEN the first member's outbox row
    // survived — proving the transition and the fan-out truly share one
    // transaction rather than the first enqueue call having already committed.
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("scheduled");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(0);

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });
});

describe("HandleStreamLifecycle — offline", () => {
  it("ends an event that was never live, without crashing", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await expect(
      useCase.execute({ hook: "offline", streamKey: livePath(streamKey) })
    ).resolves.toBeUndefined();

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("ended");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(STREAM_ENDED_EVENT);
  });

  it("offline then a late online leaves the event ended", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    await seedActiveSubscription(community.id);

    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey) });
    await useCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("ended");

    // The late `online` must not have enqueued a `notify_stream_live` row for
    // any member — it never transitioned anything, so there is nothing for it
    // to notify about.
    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });

  it("a repeated offline is idempotent — one activity row, no crash", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");

    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey) });
    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey) });

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
  });

  it("an unknown stream key writes nothing and does not throw", async () => {
    await expect(
      useCase.execute({ hook: "offline", streamKey: livePath("no-such-key") })
    ).resolves.toBeUndefined();

    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });
});
