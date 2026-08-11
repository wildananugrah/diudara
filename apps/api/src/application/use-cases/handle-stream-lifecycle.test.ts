import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { activityLogs, communities, creators, events, outbox } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { OUTBOX_NOTIFY_STREAM_LIVE } from "../ports/outbox-repository.port";
import { HandleStreamLifecycle, STREAM_ENDED_EVENT, STREAM_LIVE_EVENT } from "./handle-stream-lifecycle";

beforeEach(resetDatabase);

const eventRepository = new DrizzleEventRepository(db);
const activityLogRepository = new DrizzleActivityLogRepository(db);
const outboxRepository = new DrizzleOutboxRepository(db);
const useCase = new HandleStreamLifecycle(eventRepository, activityLogRepository, outboxRepository);

const NOW = Date.parse("2026-08-11T10:00:00.000Z");

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
  it("moves a scheduled event to live, with one activity row and one outbox row", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey), now: NOW });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(STREAM_LIVE_EVENT);
    expect(activity[0]!.communityId).toBe(community.id);

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(1);
  });

  it("a second online for the same event still yields exactly one outbox row", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await useCase.execute({ hook: "online", streamKey: livePath(streamKey), now: NOW });
    await useCase.execute({ hook: "online", streamKey: livePath(streamKey), now: NOW + 1_000 });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);

    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(1);
  });

  it("an unknown stream key writes nothing and does not throw", async () => {
    await expect(
      useCase.execute({ hook: "online", streamKey: livePath("no-such-key"), now: NOW })
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
    await useCase.execute({ hook: "online", streamKey, now: NOW });

    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });
});

describe("HandleStreamLifecycle — offline", () => {
  it("ends an event that was never live, without crashing", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    await expect(
      useCase.execute({ hook: "offline", streamKey: livePath(streamKey), now: NOW })
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

    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey), now: NOW });
    await useCase.execute({ hook: "online", streamKey: livePath(streamKey), now: NOW + 1_000 });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("ended");

    // The late `online` must not have enqueued a second `notify_stream_live` row —
    // it never transitioned anything, so there is nothing for it to notify about.
    const enqueued = await outboxRowsFor(event.id);
    expect(enqueued).toHaveLength(0);
  });

  it("a repeated offline is idempotent — one activity row, no crash", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");

    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey), now: NOW });
    await useCase.execute({ hook: "offline", streamKey: livePath(streamKey), now: NOW + 1_000 });

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
  });

  it("an unknown stream key writes nothing and does not throw", async () => {
    await expect(
      useCase.execute({ hook: "offline", streamKey: livePath("no-such-key"), now: NOW })
    ).resolves.toBeUndefined();

    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });
});
