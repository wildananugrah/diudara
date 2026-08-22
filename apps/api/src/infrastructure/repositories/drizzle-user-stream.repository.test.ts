import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, userStreams } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserStreamRepository } from "./drizzle-user-stream.repository";
import { UniqueViolationError } from "../../application/errors";

beforeEach(resetDatabase);

const repo = new DrizzleUserStreamRepository(db);

const ENDED_AT = new Date("2026-08-22T10:15:00.000Z");

let seedCounter = 0;

/** Follows `drizzle-user-tier.repository.test.ts`'s `createUser` shape exactly. */
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

describe("DrizzleUserStreamRepository", () => {
  it("starts a live stream and returns the row, owner name joined in", async () => {
    const rina = await createUser("rina");

    const started = await repo.startLive({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "members",
      streamKey: "aaa",
    });

    expect(started.ownerId).toBe(rina.id);
    expect(started.ownerHandle).toBe(rina.handle);
    expect(started.ownerDisplayName).toBe(rina.displayName);
    expect(started.title).toBe("Tanya jawab");
    expect(started.visibility).toBe("members");
    expect(started.streamKey).toBe("aaa");
    expect(started.status).toBe("live");
    expect(started.endedAt).toBe(null);
  });

  /**
   * The partial unique index's whole reason for existing. A `WHERE` clause
   * covering every row, not only `live` ones, would still pass this test —
   * see the next test, which is the one a missing `WHERE` fails.
   */
  it("one person cannot hold two live streams at once", async () => {
    const rina = await createUser("rina");

    await repo.startLive({
      ownerId: rina.id,
      title: "Tanya jawab",
      visibility: "members",
      streamKey: "aaa",
    });

    await expect(
      repo.startLive({ ownerId: rina.id, title: "Lagi", visibility: "public", streamKey: "bbb" })
    ).rejects.toThrow(UniqueViolationError);
  });

  /**
   * The test that actually pins the `WHERE` clause down. A partial index
   * that covered EVERY row — not only `live` ones — would pass the test
   * above and fail this one, and the failure would look like "a creator can
   * never stream twice". See the Task 1 report for the mutant that proves
   * this.
   */
  it("a stream that ENDED frees the slot — the same person can go live again", async () => {
    const rina = await createUser("rina");
    const first = await repo.startLive({
      ownerId: rina.id,
      title: "Satu",
      visibility: "public",
      streamKey: "aaa",
    });

    await repo.endById(first.id, ENDED_AT);
    const second = await repo.startLive({
      ownerId: rina.id,
      title: "Dua",
      visibility: "public",
      streamKey: "bbb",
    });

    expect(second.status).toBe("live");
  });

  it("two different people can each hold a live stream of their own", async () => {
    const rina = await createUser("rina");
    const dedi = await createUser("dedi");

    const rinaLive = await repo.startLive({
      ownerId: rina.id,
      title: "Punya Rina",
      visibility: "public",
      streamKey: "aaa",
    });
    const dediLive = await repo.startLive({
      ownerId: dedi.id,
      title: "Punya Dedi",
      visibility: "public",
      streamKey: "bbb",
    });

    expect(rinaLive.status).toBe("live");
    expect(dediLive.status).toBe("live");
  });

  it("returns null from findById for an unknown id", async () => {
    expect(await repo.findById("00000000-0000-4000-8000-000000000000")).toBe(null);
  });

  /**
   * Task 4 made this reachable from RAW CLIENT INPUT: nginx's `^~ /u/`
   * location captures the id straight out of the public request URI and
   * hands it to `AuthoriseStream.authoriseUserReadByStreamId`, which calls
   * this method. Without the guard, `GET /u/anything/index.m3u8` becomes a
   * Postgres `invalid input syntax for type uuid` — a 500 on apps/api for
   * every mistyped or probed URL, where the honest answer is "no such
   * stream". Same rule, same wording, as `EventRepositoryPort.findById`.
   */
  it("answers a MISS, not a driver error, for an id that is not a uuid at all", async () => {
    expect(await repo.findById("../../etc/passwd")).toBe(null);
    expect(await repo.findById("")).toBe(null);
  });

  it("finds a stream by id", async () => {
    const rina = await createUser("rina");
    const started = await repo.startLive({
      ownerId: rina.id,
      title: "Satu",
      visibility: "public",
      streamKey: "aaa",
    });

    expect(await repo.findById(started.id)).toEqual(started);
  });

  it("returns null from findByStreamKey for an unknown key", async () => {
    expect(await repo.findByStreamKey("does-not-exist")).toBe(null);
  });

  it("finds a stream by its stream key", async () => {
    const rina = await createUser("rina");
    const started = await repo.startLive({
      ownerId: rina.id,
      title: "Satu",
      visibility: "public",
      streamKey: "unique-key-xyz",
    });

    expect(await repo.findByStreamKey("unique-key-xyz")).toEqual(started);
  });

  /**
   * Seeds a SECOND owner with an ended stream, and a first owner with an
   * older live one — a single-row fixture cannot prove `listLive` excludes
   * anything, and a single-owner fixture cannot prove ordering does
   * anything either.
   */
  it("lists only live streams, newest first", async () => {
    const rina = await createUser("rina");
    const dedi = await createUser("dedi");

    const older = await repo.startLive({
      ownerId: rina.id,
      title: "Lebih dulu",
      visibility: "public",
      streamKey: "aaa",
    });
    const ended = await repo.startLive({
      ownerId: dedi.id,
      title: "Sudah selesai",
      visibility: "public",
      streamKey: "bbb",
    });
    await repo.endById(ended.id, ENDED_AT);
    const newer = await repo.startLive({
      ownerId: dedi.id,
      title: "Belakangan",
      visibility: "public",
      streamKey: "ccc",
    });

    const rows = await repo.listLive();

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("ends a live stream, setting status and endedAt", async () => {
    const rina = await createUser("rina");
    const started = await repo.startLive({
      ownerId: rina.id,
      title: "Satu",
      visibility: "public",
      streamKey: "aaa",
    });

    const ended = await repo.endById(started.id, ENDED_AT);

    expect(ended?.status).toBe("ended");
    expect(ended?.endedAt).toEqual(ENDED_AT);
  });

  it("returns null from endById for an unknown id", async () => {
    expect(await repo.endById("00000000-0000-4000-8000-000000000000", ENDED_AT)).toBe(null);
  });

  /** A repeated `offline` from a flapping webhook must be a no-op, not a second write. */
  it("returns null from endById for a stream that is already ended", async () => {
    const rina = await createUser("rina");
    const started = await repo.startLive({
      ownerId: rina.id,
      title: "Satu",
      visibility: "public",
      streamKey: "aaa",
    });
    await repo.endById(started.id, ENDED_AT);

    expect(await repo.endById(started.id, new Date("2026-08-22T11:00:00.000Z"))).toBe(null);
  });

  it("lists only live streams started at or before the cutoff, for the hourly sweep", async () => {
    const rina = await createUser("rina");
    const dedi = await createUser("dedi");

    const stale = await repo.startLive({
      ownerId: rina.id,
      title: "Sudah lama",
      visibility: "public",
      streamKey: "aaa",
    });
    const fresh = await repo.startLive({
      ownerId: dedi.id,
      title: "Baru saja",
      visibility: "public",
      streamKey: "bbb",
    });
    // Backdate the "stale" row's startedAt directly — the repository always
    // writes `now()`, so the only way to get an old `started_at` in a test
    // is to move it after the fact.
    await db
      .update(userStreams)
      .set({ startedAt: new Date("2026-08-01T00:00:00.000Z") })
      .where(eq(userStreams.id, stale.id));

    const rows = await repo.listStaleLive(new Date("2026-08-15T00:00:00.000Z"));

    expect(rows.map((r) => r.id)).toEqual([stale.id]);
    expect(rows.map((r) => r.id)).not.toContain(fresh.id);
  });
});
