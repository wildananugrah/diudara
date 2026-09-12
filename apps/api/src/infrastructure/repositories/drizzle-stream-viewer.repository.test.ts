import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserStreamRepository } from "./drizzle-user-stream.repository";
import { DrizzleStreamViewerRepository } from "./drizzle-stream-viewer.repository";

beforeEach(resetDatabase);

const streams = new DrizzleUserStreamRepository(db);
const repo = new DrizzleStreamViewerRepository(db);

const NOW = new Date("2026-09-12T10:00:00.000Z");

let seedCounter = 0;

async function seedStream() {
  seedCounter += 1;
  const [owner] = await db
    .insert(appUsers)
    .values({
      handle: `rina${seedCounter}`,
      email: `rina${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: "Rina",
      bio: null,
    })
    .returning();
  return streams.startLive({
    ownerId: owner!.id,
    title: "Tanya jawab",
    visibility: "public",
    streamKey: seedCounter.toString(16).padStart(32, "c"),
  });
}

describe("DrizzleStreamViewerRepository", () => {
  it("a repeated heartbeat for the same identity updates one row, not a second", async () => {
    const stream = await seedStream();

    await repo.heartbeat(stream.id, "viewer-1", NOW);
    await repo.heartbeat(stream.id, "viewer-1", new Date(NOW.getTime() + 5_000));

    const counts = await repo.countRecentViewers([stream.id], new Date(NOW.getTime() - 1_000));
    expect(counts.get(stream.id)).toBe(1);
  });

  it("counts distinct identities within the window, per stream", async () => {
    const a = await seedStream();
    const b = await seedStream();

    await repo.heartbeat(a.id, "viewer-1", NOW);
    await repo.heartbeat(a.id, "viewer-2", NOW);
    await repo.heartbeat(b.id, "viewer-3", NOW);

    const counts = await repo.countRecentViewers([a.id, b.id], new Date(NOW.getTime() - 1_000));
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBe(1);
  });

  it("excludes a heartbeat older than the window", async () => {
    const stream = await seedStream();

    await repo.heartbeat(stream.id, "viewer-1", new Date(NOW.getTime() - 30_000));

    const counts = await repo.countRecentViewers([stream.id], new Date(NOW.getTime() - 20_000));
    expect(counts.get(stream.id)).toBeUndefined();
  });

  it("deleteOlderThan removes only rows at or before the cutoff", async () => {
    const stream = await seedStream();
    await repo.heartbeat(stream.id, "old", new Date(NOW.getTime() - 3_600_000));
    await repo.heartbeat(stream.id, "fresh", NOW);

    const deleted = await repo.deleteOlderThan(new Date(NOW.getTime() - 1_800_000));

    expect(deleted).toBe(1);
    const counts = await repo.countRecentViewers([stream.id], new Date(NOW.getTime() - 3_700_000));
    expect(counts.get(stream.id)).toBe(1);
  });
});
