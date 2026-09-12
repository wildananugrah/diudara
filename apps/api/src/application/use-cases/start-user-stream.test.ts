import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sql } from "../../db/client";
import { appUsers, userStreams, userSubscriptions, userTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { FakeStreamingAdapter } from "../../infrastructure/streaming/fake-streaming.adapter";
import { DrizzleUserStreamRepository } from "../../infrastructure/repositories/drizzle-user-stream.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { DrizzleStreamViewerRepository } from "../../infrastructure/repositories/drizzle-stream-viewer.repository";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { EndOwnUserStream, ListLiveStreams, StartUserStream } from "./start-user-stream";

beforeEach(resetDatabase);

const NOW = new Date("2026-08-22T10:00:00.000Z");
const IN_A_MONTH = new Date("2026-09-22T10:00:00.000Z");
const YESTERDAY = new Date("2026-08-21T10:00:00.000Z");

const streams = new DrizzleUserStreamRepository(db);
const subscriptions = new DrizzleUserSubscriptionRepository(db);
const streamViewers = new DrizzleStreamViewerRepository(db);

function startUserStream() {
  return new StartUserStream(streams, new FakeStreamingAdapter());
}

function listLiveStreams(clock = new FixedClock(NOW)) {
  return new ListLiveStreams(streams, subscriptions, streamViewers, clock);
}

let seedCounter = 0;

async function createUser(handle: string, displayName = handle) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName,
      bio: null,
    })
    .returning();
  return row!;
}

/** An `active` subscription from `subscriberId` to `ownerId`, paid until `periodEnd`. */
async function subscribe(subscriberId: string, ownerId: string, periodEnd: Date) {
  const [tier] = await db
    .insert(userTiers)
    .values({ ownerId, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  await db.insert(userSubscriptions).values({
    subscriberId,
    tierId: tier!.id,
    ownerId,
    status: "active",
    currentPeriodEnd: periodEnd,
  });
}

async function countLive(ownerId: string): Promise<number> {
  const rows = await db.select().from(userStreams).where(eq(userStreams.ownerId, ownerId));
  return rows.filter((row) => row.status === "live").length;
}

describe("StartUserStream", () => {
  it("returns both publish URLs and the key", async () => {
    const rina = await createUser("rina");

    const started = await startUserStream().execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "members",
    });

    // Key-for-key, against a literal array — a spot-check passes against a
    // leaked field, which is the entire failure mode this projection exists
    // to close.
    expect(Object.keys(started).sort()).toEqual([
      "hlsPlaybackPath",
      "id",
      "rtmpUrl",
      "streamKey",
      "title",
      "visibility",
      "whipUrl",
    ]);
    expect(started.title).toBe("Tanya jawab");
    expect(started.visibility).toBe("members");
    expect(started.streamKey).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * THE DEFECT TASK 4 EXISTS TO FIX, pinned. Before it, this use case called
   * `createSession({ streamKey })` and got `live/<key>` back — so a creator
   * publishing to the url in this very response reached `AuthoriseStream`
   * parsed as the COMMUNITY world and was looked up in the `event` table.
   * Nothing caught that, because no test here ever asserted the URLs' shape:
   * the key-for-key test above only checks that the two keys EXIST.
   *
   * Literal strings, matching `FakeStreamingAdapter`'s own construction —
   * which in turn matches `MediaMtxAdapter`'s, including the deliberate
   * asymmetry in WHIP's extra `u/` segment (see `whipSuffix`).
   */
  it("asks the provider for the USER namespace — the publish URLs name u/<key>, never live/<key>", async () => {
    const rina = await createUser("rina");
    const provider = new FakeStreamingAdapter();

    const started = await new StartUserStream(streams, provider).execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "public",
    });

    expect(provider.sessions).toEqual([{ streamKey: started.streamKey, namespace: "u" }]);
    expect(started.rtmpUrl).toBe(`rtmp://fake-mediamtx.local:1935/u/${started.streamKey}`);
    expect(started.whipUrl).toBe(`https://fake-mediamtx.local/whip/u/${started.streamKey}`);
  });

  it("persists exactly one LIVE row, carrying the key it handed back", async () => {
    const rina = await createUser("rina");

    const started = await startUserStream().execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "public",
    });

    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, started.id));
    expect(row!.status).toBe("live");
    expect(row!.ownerId).toBe(rina.id);
    expect(row!.streamKey).toBe(started.streamKey);
    expect(row!.endedAt).toBe(null);
  });

  /**
   * The creator's OWN response is the one place a stream key belongs — but
   * the playback path inside it is the string a viewer is handed by
   * `GET /streams`, so it must not carry the key either. The old community
   * world shipped exactly this defect and had to fix it as a CRITICAL — its
   * watch-link resolver built the member-facing HLS URL from `event.stream_key`
   * — and an HLS URL built from a stream key hands every watcher the publish
   * credential. See `userStreamPlaybackPath` in `stream-views.ts`, which is
   * where that fix lives for this world.
   */
  it("builds the playback path from the stream ID, never from the publish key", async () => {
    const rina = await createUser("rina");

    const started = await startUserStream().execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "public",
    });

    expect(started.hlsPlaybackPath).toBe(`/u/${started.id}/index.m3u8`);
    expect(started.hlsPlaybackPath).not.toContain(started.streamKey);
  });

  it("refuses a second live stream, and mints no second row for it", async () => {
    const rina = await createUser("rina");
    const start = startUserStream();
    await start.execute({ ownerId: rina.id, title: "Satu", visibility: "public" });

    await expect(
      start.execute({ ownerId: rina.id, title: "Dua", visibility: "public" })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await countLive(rina.id)).toBe(1);
  });

  it("lets a creator go live again once the first stream ENDED", async () => {
    const rina = await createUser("rina");
    const start = startUserStream();
    const first = await start.execute({ ownerId: rina.id, title: "Satu", visibility: "public" });
    await streams.endById(first.id, NOW);

    const second = await start.execute({ ownerId: rina.id, title: "Dua", visibility: "public" });

    expect(second.id).not.toBe(first.id);
    expect(await countLive(rina.id)).toBe(1);
  });

  it("does not stop a DIFFERENT person going live at the same time", async () => {
    const rina = await createUser("rina");
    const budi = await createUser("budi");
    const start = startUserStream();

    await start.execute({ ownerId: rina.id, title: "Satu", visibility: "public" });
    await start.execute({ ownerId: budi.id, title: "Dua", visibility: "public" });

    expect(await countLive(rina.id)).toBe(1);
    expect(await countLive(budi.id)).toBe(1);
  });

  /**
   * THE ARBITRATION ITSELF, against a real database and the real partial
   * unique index — the one test a check-then-insert implementation cannot
   * pass, and the reason `StartUserStream` performs no pre-read at all.
   *
   * THIRTY CONTENDERS, and the count was MEASURED rather than copied.
   * Against a deliberately broken read-then-write (`select` this owner's
   * rows, refuse if any is `live`, otherwise insert) with
   * `user_stream_one_live` dropped, five runs at each count on this database:
   *
   *   |  N | live rows written, per run | runs showing the defect |
   *   |---:|----------------------------|------------------------|
   *   |  2 | 2, 2, 2, 2, 2              | 5/5                    |
   *   |  4 | 4, 4, 4, 4, 2              | 5/5                    |
   *   | 10 | 7, 10, 10, 10, 10          | 5/5                    |
   *   | 30 | 30, 30, 30, 30, 30         | 5/5                    |
   *
   * SO THE HONEST FINDING IS THAT THE COUNT IS NOT WHAT DISCRIMINATES HERE,
   * unlike Phase 5a's conditional UPDATE where four contenders proved far
   * too few. A bare INSERT racing a read-then-write is caught at two, warmed,
   * every time — because the pre-read commits nothing and every contender
   * reads the same empty table. Thirty is kept anyway, for two reasons worth
   * more than a shorter test: it is what the payout race and the pending-claim
   * race in this codebase already settled on against this same database (one
   * number for the phase, not three), and it puts real scheduler and
   * connection-pool pressure behind the claim rather than the minimum that
   * happened to reproduce once.
   *
   * WHAT THIS TEST CAN AND CANNOT SEE: with the index in place, a
   * check-then-insert would ALSO pass here, because the database would still
   * refuse the losers. The index is the mechanism, and the mutant that proves
   * it is dropping `user_stream_one_live` from the migration — recorded in
   * this task's report, and it turns this test's `countLive` from 1 into 30.
   *
   * WARMING THE POOL IS PART OF THE TEST, NOT SETUP NOISE. `ArrivalLatch`
   * guarantees thirty callers reach the same LINE, and that is all it can
   * guarantee: `postgres.js` connects lazily, so on a cold pool the callers'
   * first statements queue behind the one live connection, the requests
   * serialise inside the driver, and each caller reads the previous caller's
   * committed row. Phase 5b confirmed an unwarmed race test measures
   * connection serialisation rather than the arbitration it names.
   */
  it("THIRTY simultaneous taps of Mulai siaran produce exactly ONE live stream", async () => {
    const rina = await createUser("rina");
    const start = startUserStream();
    const contenders = 30;

    await Promise.all(Array.from({ length: contenders }, () => sql`select 1`));
    const latch = new ArrivalLatch(contenders);

    const outcomes = await Promise.all(
      Array.from({ length: contenders }, async (_unused, index) => {
        await latch.arriveAndWait();
        try {
          await start.execute({
            ownerId: rina.id,
            title: `Tap ${index}`,
            visibility: "public",
          });
          return "started" as const;
        } catch (err) {
          return err instanceof ConflictError ? ("refused" as const) : ("threw" as const);
        }
      })
    );

    expect(latch.arrived).toBe(30);
    expect(await countLive(rina.id)).toBe(1);
    // One winner and twenty-nine losers, and every loser got the CONFLICT —
    // not a raw driver error, which is what an unmapped 23505 would surface
    // as, and not a success.
    expect(outcomes.filter((outcome) => outcome === "started")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(29);
    expect(outcomes.filter((outcome) => outcome === "threw")).toHaveLength(0);
  });

  it("says so in Bahasa when a second stream is refused", async () => {
    const rina = await createUser("rina");
    const start = startUserStream();
    await start.execute({ ownerId: rina.id, title: "Satu", visibility: "public" });

    await expect(
      start.execute({ ownerId: rina.id, title: "Dua", visibility: "public" })
    ).rejects.toThrow("sudah ada siaran yang sedang berlangsung");
  });
});

describe("ListLiveStreams", () => {
  /** Rina, live and gated. Returns her id and the stream's. */
  async function rinaLiveAndGated() {
    const rina = await createUser("rina", "Rina");
    const started = await startUserStream().execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "members",
    });
    return { rina, streamId: started.id, streamKey: started.streamKey };
  }

  it("the listing's projection is CLOSED, and a locked row carries no playback path", async () => {
    await rinaLiveAndGated();

    const [gated] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(Object.keys(gated!).sort()).toEqual([
      "id",
      "locked",
      "owner",
      "title",
      "viewerCount",
      "visibility",
    ]);
    expect(gated!.locked).toBe(true);
    expect(Object.keys(gated!.owner).sort()).toEqual(["displayName", "handle"]);
  });

  it("an unlocked row carries the path", async () => {
    const { rina, streamId } = await rinaLiveAndGated();
    const budi = await createUser("budi");
    await subscribe(budi.id, rina.id, IN_A_MONTH);

    const [open] = (await listLiveStreams().execute({ viewerId: budi.id })).streams;

    expect(Object.keys(open!).sort()).toEqual([
      "hlsPlaybackPath",
      "id",
      "locked",
      "owner",
      "title",
      "viewerCount",
      "visibility",
    ]);
    expect(open!.locked).toBe(false);
    expect(open!.hlsPlaybackPath).toBe(`/u/${streamId}/index.m3u8`);
  });

  /**
   * THE LEAK THIS WHOLE PROJECTION EXISTS TO CLOSE. `UserStreamRow.streamKey`
   * comes back from `listLive` — correctly, at the repository layer — and a
   * stream key is a PUBLISH secret: anybody who reads it off a public listing
   * can broadcast as that creator. Asserted over the serialised body rather
   * than over a key name, so a key smuggled INSIDE a value (an HLS URL, most
   * plausibly) fails this too.
   */
  it("NEVER lets a stream key reach the listing, locked or unlocked", async () => {
    const { rina, streamKey } = await rinaLiveAndGated();
    const budi = await createUser("budi");
    await subscribe(budi.id, rina.id, IN_A_MONTH);

    const anonymous = await listLiveStreams().execute({ viewerId: null });
    const member = await listLiveStreams().execute({ viewerId: budi.id });
    const owner = await listLiveStreams().execute({ viewerId: rina.id });

    expect(JSON.stringify(anonymous)).not.toContain(streamKey);
    expect(JSON.stringify(member)).not.toContain(streamKey);
    expect(JSON.stringify(owner)).not.toContain(streamKey);
  });

  it("locks a gated stream for a signed-out viewer", async () => {
    await rinaLiveAndGated();

    const [row] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(row!.locked).toBe(true);
    expect(row!.hlsPlaybackPath).toBe(undefined);
  });

  it("locks a gated stream for a signed-in NON-member", async () => {
    await rinaLiveAndGated();
    const stranger = await createUser("stranger");

    const [row] = (await listLiveStreams().execute({ viewerId: stranger.id })).streams;

    expect(row!.locked).toBe(true);
  });

  /**
   * A LAPSED membership — `status` still `active`, its paid period already
   * over — is not a member. `is-member-of.ts` answers this with
   * `current_period_end > now`, and `listActiveOwnersAmong` mirrors that
   * definition exactly; a status-only gate would keep the stream open for
   * somebody who stopped paying.
   */
  it("locks a gated stream for a LAPSED member", async () => {
    const { rina } = await rinaLiveAndGated();
    const budi = await createUser("budi");
    await subscribe(budi.id, rina.id, YESTERDAY);

    const [row] = (await listLiveStreams().execute({ viewerId: budi.id })).streams;

    expect(row!.locked).toBe(true);
  });

  it("never locks the OWNER out of their own gated stream", async () => {
    const { rina } = await rinaLiveAndGated();

    const [row] = (await listLiveStreams().execute({ viewerId: rina.id })).streams;

    expect(row!.locked).toBe(false);
  });

  it("leaves a PUBLIC stream unlocked for a signed-out viewer", async () => {
    const rina = await createUser("rina");
    await startUserStream().execute({
      ownerId: rina.id,
      title: "Ngobrol santai",
      visibility: "public",
    });

    const [row] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(row!.locked).toBe(false);
    expect(row!.visibility).toBe("public");
  });

  /**
   * A MIXED page: one gated stream and one public one, live at the same
   * moment, and only the gated one locks. Across two owners rather than one,
   * because `user_stream_one_live` makes "one person, two live streams" — the
   * shape `toFeedPage` guards against for posts — impossible here by
   * construction; see `ListLiveStreams`'s own comment on why that guard is
   * therefore absent rather than merely untested.
   */
  it("locks the gated stream on a page and leaves the public one open", async () => {
    const rina = await createUser("rina", "Rina");
    const budi = await createUser("budi", "Budi");
    const gated = await startUserStream().execute({
      ownerId: rina.id,
      title: "Khusus anggota",
      visibility: "members",
    });
    await startUserStream().execute({
      ownerId: budi.id,
      title: "Terbuka",
      visibility: "public",
    });
    // Rina's gated stream keeps her in the locked set for a stranger.
    const stranger = await createUser("stranger");

    const { streams: rows } = await listLiveStreams().execute({ viewerId: stranger.id });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(gated.id)!.locked).toBe(true);
    expect(rows.filter((row) => row.title === "Terbuka")[0]!.locked).toBe(false);
  });

  it("shows only LIVE streams, newest first", async () => {
    const rina = await createUser("rina", "Rina");
    const budi = await createUser("budi", "Budi");
    const ended = await startUserStream().execute({
      ownerId: rina.id,
      title: "Sudah selesai",
      visibility: "public",
    });
    await streams.endById(ended.id, NOW);
    await startUserStream().execute({ ownerId: rina.id, title: "Pertama", visibility: "public" });
    // An unambiguously EARLIER `started_at`, so "newest first" is decided by
    // the column rather than by insertion luck — and a fixed instant in the
    // past rather than one near the wall clock, which `defaultNow()` sets for
    // the row inserted next and which this test once lost a race against.
    await db
      .update(userStreams)
      .set({ startedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(userStreams.ownerId, rina.id));
    await startUserStream().execute({ ownerId: budi.id, title: "Kedua", visibility: "public" });

    const { streams: rows } = await listLiveStreams().execute({ viewerId: null });

    expect(rows.map((row) => row.title)).toEqual(["Kedua", "Pertama"]);
  });

  it("carries the owner's handle and display name for every row", async () => {
    const rina = await createUser("rina", "Rina Wijaya");
    await startUserStream().execute({
      ownerId: rina.id,
      title: "Ngobrol",
      visibility: "public",
    });

    const [row] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(row!.owner.displayName).toBe("Rina Wijaya");
    expect(row!.owner.handle).toBe(rina.handle);
  });

  it("answers an empty listing when nobody is live", async () => {
    expect(await listLiveStreams().execute({ viewerId: null })).toEqual({ streams: [] });
  });

  it("defaults viewerCount to 0 for a stream nothing has recorded a heartbeat for", async () => {
    const rina = await createUser("rina");
    await startUserStream().execute({ ownerId: rina.id, title: "Baru mulai", visibility: "public" });

    const [row] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(row!.viewerCount).toBe(0);
  });

  it("counts distinct heartbeats within the window, on a locked row too", async () => {
    const { streamId } = await rinaLiveAndGated();
    await streamViewers.heartbeat(streamId, "viewer-a", NOW);
    await streamViewers.heartbeat(streamId, "viewer-b", NOW);
    // Outside the window — must not be counted.
    await streamViewers.heartbeat(
      streamId,
      "viewer-stale",
      new Date(NOW.getTime() - 60_000)
    );

    const [row] = (await listLiveStreams().execute({ viewerId: null })).streams;

    expect(row!.locked).toBe(true);
    expect(row!.viewerCount).toBe(2);
  });
});

describe("EndOwnUserStream", () => {
  async function rinaLive() {
    const rina = await createUser("rina");
    const started = await startUserStream().execute({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "public",
    });
    return { rina, streamId: started.id };
  }

  it("ends your own stream, stamping the injected clock", async () => {
    const { rina, streamId } = await rinaLive();
    const clock = new FixedClock(NOW);

    await new EndOwnUserStream(streams, clock).execute({ ownerId: rina.id, streamId });

    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, streamId));
    expect(row!.status).toBe("ended");
    expect(row!.endedAt!.toISOString()).toBe("2026-08-22T10:00:00.000Z");
    expect(await countLive(rina.id)).toBe(0);
  });

  it("REFUSES to end somebody else's stream, and leaves it live", async () => {
    const { streamId } = await rinaLive();
    const budi = await createUser("budi");

    await expect(
      new EndOwnUserStream(streams, new FixedClock(NOW)).execute({
        ownerId: budi.id,
        streamId,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);

    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, streamId));
    expect(row!.status).toBe("live");
  });

  it("404s an id that does not exist", async () => {
    const rina = await createUser("rina");

    await expect(
      new EndOwnUserStream(streams, new FixedClock(NOW)).execute({
        ownerId: rina.id,
        streamId: "00000000-0000-4000-8000-000000000000",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("is IDEMPOTENT — ending an already-ended stream answers normally", async () => {
    const { rina, streamId } = await rinaLive();
    const end = new EndOwnUserStream(streams, new FixedClock(NOW));
    await end.execute({ ownerId: rina.id, streamId });

    await end.execute({ ownerId: rina.id, streamId });

    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, streamId));
    expect(row!.status).toBe("ended");
  });
});
