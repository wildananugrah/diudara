import { describe, expect, it, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const eventRepository = new DrizzleEventRepository(db);
const unitOfWork = new DrizzleStreamLifecycleUnitOfWork(db);
const useCase = new HandleStreamLifecycle(eventRepository, unitOfWork);

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
   * predicate makes the transition happen AT MOST ONCE, so if the fan-out's
   * write were a separate statement and it failed, the event would be stuck
   * `live` forever with no notify row and nothing able to create one.
   *
   * Proven here by swapping in a `StreamLifecycleUnitOfWorkPort` that opens the
   * SAME real transaction `DrizzleStreamLifecycleUnitOfWork` does, but whose
   * outbox repository's `enqueueMany` throws instead of writing. (Review round
   * 2 turned the per-member fan-out into one batched `enqueueMany` call rather
   * than N `enqueue` calls — see `HandleStreamLifecycle.handleOnline` — so
   * there is only one write to make fail, not a "second of N" to target.) If
   * the transition and the fan-out were not atomic, the `live` status and the
   * activity_log row would already be committed by the time the throw happens.
   * They must not be.
   *
   * This test proves the USE-CASE performs every write inside one `run()`
   * call. It does NOT by itself prove the shipped `DrizzleStreamLifecycleUnitOfWork`
   * adapter opens a real transaction — a `run` that silently stopped doing so
   * would still pass this test, since the fake unit of work below opens its
   * own `db.transaction` regardless of what the adapter does. That adapter
   * property is pinned separately, against the real adapter and the real
   * database, in `drizzle-stream-lifecycle.unit-of-work.test.ts`.
   */
  it("a failure partway through the per-member fan-out rolls back the ENTIRE transition — no partial commit", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    await seedActiveSubscription(community.id);
    await seedActiveSubscription(community.id);

    /** Delegates every method to a real `DrizzleOutboxRepository`, except
     * `enqueueMany` — which throws instead of writing, simulating a crash
     * during the batched per-member fan-out write. */
    class ExplodingOutboxRepository implements OutboxRepositoryPort {
      constructor(private readonly real: OutboxRepositoryPort) {}
      enqueue = (...args: Parameters<OutboxRepositoryPort["enqueue"]>) =>
        this.real.enqueue(...args);
      async enqueueMany(): Promise<{ id: string }[]> {
        throw new Error("simulated failure writing the per-member fan-out");
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

    class ExplodingOnFanOutUnitOfWork implements StreamLifecycleUnitOfWorkPort {
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

    const explodingUseCase = new HandleStreamLifecycle(
      eventRepository,
      new ExplodingOnFanOutUnitOfWork()
    );

    await expect(
      explodingUseCase.execute({ hook: "online", streamKey: livePath(streamKey) })
    ).rejects.toThrow();

    // The whole unit rolled back: the event is still `scheduled`, not `live`,
    // there is no activity_log row, and no outbox row survived — proving the
    // transition and the fan-out truly share one transaction rather than the
    // transition having already committed before the fan-out's write ran.
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("scheduled");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(0);

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });

  /**
   * Review round 2, important #3. `HandlePaymentWebhook`'s own lookup reads
   * stay outside its unit of work — "a body that fails them should not open a
   * transaction at all" — and `findByStreamKey` now follows the same rule.
   * Proven here with a `StreamLifecycleUnitOfWorkPort` spy that records
   * whether `run()` was ever called: an unknown key must never open one, and
   * a real event must.
   */
  it("never opens the unit of work for a stream key that resolves to no event", async () => {
    let runWasCalled = false;
    class SpyUnitOfWork implements StreamLifecycleUnitOfWorkPort {
      async run<T>(work: (repositories: StreamLifecycleRepositories) => Promise<T>): Promise<T> {
        runWasCalled = true;
        return unitOfWork.run(work);
      }
    }
    const spiedUseCase = new HandleStreamLifecycle(eventRepository, new SpyUnitOfWork());

    await spiedUseCase.execute({ hook: "online", streamKey: livePath("no-such-key") });

    expect(runWasCalled).toBe(false);
  });

  it("opens the unit of work once the key resolves to a real event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");
    let runWasCalled = false;
    class SpyUnitOfWork implements StreamLifecycleUnitOfWorkPort {
      async run<T>(work: (repositories: StreamLifecycleRepositories) => Promise<T>): Promise<T> {
        runWasCalled = true;
        return unitOfWork.run(work);
      }
    }
    const spiedUseCase = new HandleStreamLifecycle(eventRepository, new SpyUnitOfWork());

    await spiedUseCase.execute({ hook: "online", streamKey: livePath(streamKey) });

    expect(runWasCalled).toBe(true);
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

/**
 * A CONFIG GUARD, not a unit test of this class — and it lives here, in this
 * class's own test file, because this class is where the damage lands.
 *
 * TASK 4 (the browser-publishing phase gate) found, by running two real
 * publishers against one real MediaMTX, that `infra/mediamtx.yml` did not set
 * `overridePublisher`, and MediaMTX's own default for it is `yes`: a second
 * publisher to a path that already has one is not refused, it DISCONNECTS the
 * first and takes the path over. MediaMTX's captured log for that race:
 *
 *   INF [path live/<key>] closing existing publisher
 *   INF [path live/<key>] runOnOffline command launched
 *   INF [path live/<key>] runOnOnline command started
 *   INF [WebRTC] [session ...] closed: terminated
 *
 * Read that hook order against `handleOffline` and `handleOnline` above:
 * `offline` marks the event `ended`, and `handleOnline` then deliberately
 * REFUSES to resurrect an `ended` event (a late `online` must never revive a
 * finished session). So the takeover leaves the event permanently `ended`
 * while a publisher is still on the air — measured: eleven minutes of ffmpeg
 * publishing to a session the database called `ended`, no watch link
 * obtainable by any member, and no error raised anywhere.
 *
 * There is no way to assert this from inside the process — the setting lives
 * in a YAML file a container reads — so this reads that file. It is the same
 * shape as `bootstrap.test.ts`'s ".env.example" guard: pin the FILE, so a
 * reword or a deletion fails a test instead of silently re-opening the hole.
 */
describe("infra/mediamtx.yml's publisher-conflict policy", () => {
  const config = readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", "..", "infra", "mediamtx.yml"),
    "utf8"
  );

  it("refuses a second publisher rather than letting it take the path over", () => {
    const line = config
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("overridePublisher:"));

    expect(line).toBeDefined();
    // `false`, not `no`: whether YAML's `no` parses as a boolean or as the
    // truthy STRING "no" depends on the parser's YAML version, and a flag
    // that silently reads truthy is exactly the failure being guarded.
    expect(line).toBe("overridePublisher: false");
  });
});
