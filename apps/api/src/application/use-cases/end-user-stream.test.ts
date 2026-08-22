import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { DrizzleUserStreamRepository } from "../../infrastructure/repositories/drizzle-user-stream.repository";
import type {
  UserStreamRepositoryPort,
  UserStreamRow,
} from "../ports/user-stream-repository.port";
import { EndUserStream } from "./end-user-stream";

beforeEach(resetDatabase);

const NOW = new Date("2026-08-22T10:00:00.000Z");

let seedCounter = 0;

async function createUser(handle: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

/**
 * Passes every call straight through to a real `DrizzleUserStreamRepository`, except
 * `findByStreamKey`, whose call count it records. This exists for exactly one test —
 * "a late ONLINE hook does not resurrect an ended stream" — and the reason a plain
 * before/after status check cannot stand in for it: `endById`'s own atomic predicate
 * (`WHERE status = 'live'`) ALSO protects an already-`ended` row from being touched by
 * a stray call, so a status assertion alone would pass whether or not `EndUserStream`
 * ever short-circuits the "online" hook at all — the exact "guard fires for the wrong
 * reason" shape this phase has now found six times. The call-count assertion is the
 * one that actually depends on `EndUserStream`'s own early return.
 */
class CountingUserStreamRepository implements UserStreamRepositoryPort {
  findByStreamKeyCalls = 0;

  constructor(private readonly inner: UserStreamRepositoryPort) {}

  startLive(input: {
    ownerId: string;
    title: string;
    visibility: string;
    streamKey: string;
  }): Promise<UserStreamRow> {
    return this.inner.startLive(input);
  }

  findByStreamKey(streamKey: string): Promise<UserStreamRow | null> {
    this.findByStreamKeyCalls += 1;
    return this.inner.findByStreamKey(streamKey);
  }

  findById(id: string): Promise<UserStreamRow | null> {
    return this.inner.findById(id);
  }

  listLive(): Promise<UserStreamRow[]> {
    return this.inner.listLive();
  }

  endById(id: string, endedAt: Date): Promise<UserStreamRow | null> {
    return this.inner.endById(id, endedAt);
  }

  listStaleLive(olderThan: Date): Promise<UserStreamRow[]> {
    return this.inner.listStaleLive(olderThan);
  }
}

describe("EndUserStream", () => {
  it("the offline hook ends the stream", async () => {
    const rina = await createUser("rina");
    const streams = new DrizzleUserStreamRepository(db);
    const started = await streams.startLive({
      ownerId: rina.id,
      title: "Ngobrol santai",
      visibility: "public",
      streamKey: "key-offline-1",
    });

    await new EndUserStream(streams, new FixedClock(NOW)).execute({
      hook: "offline",
      streamKey: "key-offline-1",
    });

    const reloaded = await streams.findById(started.id);
    expect(reloaded!.status).toBe("ended");
    expect(reloaded!.endedAt).toEqual(NOW);
  });

  it("a late ONLINE hook does not resurrect an ended stream", async () => {
    const rina = await createUser("rina");
    const streams = new CountingUserStreamRepository(new DrizzleUserStreamRepository(db));
    const started = await streams.startLive({
      ownerId: rina.id,
      title: "Ngobrol santai",
      visibility: "public",
      streamKey: "key-online-1",
    });
    await new EndUserStream(streams, new FixedClock(NOW)).execute({
      hook: "offline",
      streamKey: "key-online-1",
    });
    // The one legitimate lookup above (the offline hook resolving the row) does not
    // count against the guard this test names — reset before the call under test.
    streams.findByStreamKeyCalls = 0;

    const later = new Date(NOW.getTime() + 60_000);
    await new EndUserStream(streams, new FixedClock(later)).execute({
      hook: "online",
      streamKey: "key-online-1",
    });

    const reloaded = await streams.findById(started.id);
    expect(reloaded!.status).toBe("ended");
    expect(reloaded!.endedAt).toEqual(NOW);
    // THE GUARD ITSELF: an "online" hook must never even ask about the row. Delete
    // `EndUserStream`'s early return on "online" and this line — not the two above —
    // is what reddens.
    expect(streams.findByStreamKeyCalls).toBe(0);
  });

  it("an unknown stream key is a silent no-op, not a throw", async () => {
    const streams = new DrizzleUserStreamRepository(db);

    await expect(
      new EndUserStream(streams, new FixedClock(NOW)).execute({
        hook: "offline",
        streamKey: "no-such-key",
      })
    ).resolves.toBeUndefined();
  });

  it("a repeated offline is idempotent", async () => {
    const rina = await createUser("rina");
    const streams = new DrizzleUserStreamRepository(db);
    const started = await streams.startLive({
      ownerId: rina.id,
      title: "Ngobrol santai",
      visibility: "public",
      streamKey: "key-offline-2",
    });

    await new EndUserStream(streams, new FixedClock(NOW)).execute({
      hook: "offline",
      streamKey: "key-offline-2",
    });
    const later = new Date(NOW.getTime() + 60_000);
    await new EndUserStream(streams, new FixedClock(later)).execute({
      hook: "offline",
      streamKey: "key-offline-2",
    });

    const reloaded = await streams.findById(started.id);
    expect(reloaded!.status).toBe("ended");
    // The SECOND offline's `endedAt` must not have overwritten the first — `endById`'s
    // own atomic predicate is what stops it (it only transitions FROM `live`), and this
    // pins that endById is actually called with the fresh clock reading each time
    // rather than the first `now` being reused some other way.
    expect(reloaded!.endedAt).toEqual(NOW);
  });
});
