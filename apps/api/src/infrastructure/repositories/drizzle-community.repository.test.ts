import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../db/client";
import { appUsers, communityMembers, streamViewerHeartbeats, userStreams, userTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityRepository } from "./drizzle-community.repository";

beforeEach(resetDatabase);

async function seedUser(handle: string): Promise<string> {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle,
      email: `${handle}@example.com`,
      passwordHash: "hash",
      displayName: handle,
    })
    .returning({ id: appUsers.id });
  return row!.id;
}

function repo() {
  return new DrizzleCommunityRepository(db);
}

async function create(
  ownerId: string,
  overrides: { slug: string; name: string; tags?: string[] }
) {
  return repo().create({
    ownerId,
    slug: overrides.slug,
    name: overrides.name,
    category: "Skill Digital",
    description: null,
    tags: overrides.tags ?? [],
  });
}

/** Joins a community at a caller-chosen instant, bypassing `repo().join()`'s `defaultNow()`. */
async function joinAt(communityId: string, userId: string, joinedAt: Date) {
  await db.insert(communityMembers).values({ communityId, userId, joinedAt });
}

async function backdateOwnerJoin(communityId: string, ownerId: string, joinedAt: Date) {
  await db
    .update(communityMembers)
    .set({ joinedAt })
    .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, ownerId)));
}

async function addTier(
  communityId: string,
  ownerId: string,
  input: { priceAmount: number; isActive?: boolean }
) {
  await db.insert(userTiers).values({
    ownerId,
    communityId,
    name: "Tier",
    priceAmount: input.priceAmount,
    billingCycle: "monthly",
    isActive: input.isActive ?? true,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

let streamKeyCounter = 0;

async function goLive(ownerId: string, visibility: "public" | "members" = "public") {
  streamKeyCounter += 1;
  const [stream] = await db
    .insert(userStreams)
    .values({
      ownerId,
      title: "Siaran",
      visibility,
      streamKey: streamKeyCounter.toString(16).padStart(32, "e"),
      status: "live",
    })
    .returning();
  return stream!;
}

async function heartbeat(streamId: string, identity: string, lastSeenAt: Date) {
  await db.insert(streamViewerHeartbeats).values({ streamId, identity, lastSeenAt });
}

describe("DrizzleCommunityRepository", () => {
  it("creating a community also makes the owner a member, in one transaction", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(created.slug).toBe("kelas-desain");
    expect(await repo().memberCountFor(created.id)).toBe(1);
    expect(await repo().isMember(created.id, ownerId)).toBe(true);
  });

  it("the owner's membership row carries the owner role", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    const members = await repo().listMembers(created.id, 50);
    expect(members.map((m) => `${m.handle}:${m.role}`).join(",")).toBe("wildan:owner");
  });

  it("findById returns the record for a live id and null for an unknown one", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    const found = await repo().findById(created.id);
    expect(found?.slug).toBe("kelas-desain");
    expect(found?.ownerId).toBe(ownerId);

    expect(await repo().findById("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("joining twice writes one row and reports the second as already present", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(await repo().join(created.id, joinerId)).toBe(true);
    expect(await repo().join(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(2);
  });

  it("leaving is idempotent and reports whether anything was removed", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });
    await repo().join(created.id, joinerId);

    expect(await repo().leave(created.id, joinerId)).toBe(true);
    expect(await repo().leave(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(1);
  });

  it("browse filters by category and by a case-insensitive name match", async () => {
    const ownerId = await seedUser("wildan");
    await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().create({ ownerId, slug: "bimbel-sbmptn", name: "Bimbel SBMPTN", category: "Bimbel & Ujian", description: null });

    const byCategory = await repo().browse({ search: "", category: "Skill Digital", limit: 24 });
    expect(byCategory.map((c) => c.slug).join(",")).toBe("kelas-desain");

    const bySearch = await repo().browse({ search: "bimbel", category: "", limit: 24 });
    expect(bySearch.map((c) => c.slug).join(",")).toBe("bimbel-sbmptn");

    const all = await repo().browse({ search: "", category: "", limit: 24 });
    expect(all.length).toBe(2);
  });

  it("browse reports a member count per row, so the grid needs no second query", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().join(created.id, joinerId);

    const rows = await repo().browse({ search: "", category: "", limit: 24 });
    expect(rows.map((r) => `${r.slug}:${r.memberCount}`).join(",")).toBe("kelas-desain:2");
  });

  it("browse returns each community's tags, and setTags replaces the list", async () => {
    const ownerId = await seedUser("wildan");
    const created = await create(ownerId, {
      slug: "kelas-desain",
      name: "Kelas Desain",
      tags: ["desain", "ui"],
    });

    const before = await repo().browse({ search: "", category: "", limit: 24 });
    expect(before[0]!.tags).toEqual(["desain", "ui"]);

    await repo().setTags(created.id, ["baru"]);

    const after = await repo().browse({ search: "", category: "", limit: 24 });
    expect(after[0]!.tags).toEqual(["baru"]);
  });

  it("popularTags ranks tags by how many communities carry them, most-used first", async () => {
    const ownerId = await seedUser("wildan");
    await create(ownerId, { slug: "a", name: "A", tags: ["a", "b", "c"] });
    await create(ownerId, { slug: "b", name: "B", tags: ["a", "b"] });
    await create(ownerId, { slug: "c", name: "C", tags: ["a"] });

    expect(await repo().popularTags(3)).toEqual(["a", "b", "c"]);
    expect(await repo().popularTags(2)).toEqual(["a", "b"]);
  });

  it("browse's price is the cheapest ACTIVE tier, ignoring a cheaper inactive one; null with no active tier", async () => {
    const ownerId = await seedUser("wildan");
    const withTiers = await create(ownerId, { slug: "with-tiers", name: "With Tiers" });
    await addTier(withTiers.id, ownerId, { priceAmount: 100_000 });
    await addTier(withTiers.id, ownerId, { priceAmount: 50_000 });
    await addTier(withTiers.id, ownerId, { priceAmount: 10_000, isActive: false });

    const withoutTiers = await create(ownerId, { slug: "without-tiers", name: "Without Tiers" });

    const rows = await repo().browse({ search: "", category: "", limit: 24 });
    const byId = new Map(rows.map((r) => [r.slug, r]));
    expect(byId.get("with-tiers")!.price).toEqual({ amount: 50_000, billingCycle: "monthly" });
    expect(byId.get("without-tiers")!.price).toBeNull();
  });

  describe("trending", () => {
    it("needs at least 5 joins in the last 7 days, and is false below that floor", async () => {
      const ownerId = await seedUser("wildan");
      const fewJoins = await create(ownerId, { slug: "few-joins", name: "Few Joins" });
      // The owner's own creation-time join is one of the five.
      for (let i = 0; i < 3; i += 1) {
        await repo().join(fewJoins.id, await seedUser(`joiner-few-${i}`));
      }

      const manyJoins = await create(ownerId, { slug: "many-joins", name: "Many Joins" });
      for (let i = 0; i < 4; i += 1) {
        await repo().join(manyJoins.id, await seedUser(`joiner-many-${i}`));
      }

      const rows = await repo().browse({ search: "", category: "", limit: 24 });
      const byId = new Map(rows.map((r) => [r.slug, r]));
      expect(byId.get("few-joins")!.trending).toBe(false);
      expect(byId.get("many-joins")!.trending).toBe(true);
    });

    it("only counts joins from the last 7 days", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "old-crowd", name: "Old Crowd" });
      await backdateOwnerJoin(created.id, ownerId, new Date(Date.now() - 8 * DAY_MS));
      for (let i = 0; i < 4; i += 1) {
        await joinAt(created.id, await seedUser(`old-${i}`), new Date(Date.now() - 8 * DAY_MS));
      }

      // All 5 members joined 8 days ago — none within the window, so it must not be trending
      // even though its total membership clears the floor.
      const stale = await repo().browse({ search: "", category: "", limit: 24 });
      expect(stale.find((r) => r.slug === "old-crowd")!.trending).toBe(false);

      // Backdate one fewer join and add 5 fresh ones instead: now exactly 5 recent joins.
      for (let i = 0; i < 5; i += 1) {
        await joinAt(created.id, await seedUser(`fresh-${i}`), new Date());
      }
      const fresh = await repo().browse({ search: "", category: "", limit: 24 });
      expect(fresh.find((r) => r.slug === "old-crowd")!.trending).toBe(true);
    });

    it("caps at the top 3 communities by recent-join count", async () => {
      const ownerId = await seedUser("wildan");
      const counts = [5, 6, 7, 8];
      for (const n of counts) {
        const created = await create(ownerId, { slug: `c${n}`, name: `C${n}` });
        for (let i = 0; i < n - 1; i += 1) {
          await repo().join(created.id, await seedUser(`joiner-${n}-${i}`));
        }
      }

      const rows = await repo().browse({ search: "", category: "", limit: 24 });
      const trendingSlugs = rows.filter((r) => r.trending).map((r) => r.slug).sort();
      expect(trendingSlugs).toEqual(["c6", "c7", "c8"]);
    });
  });

  describe("live", () => {
    it("reports the owner's live stream id and recent viewer count", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "kelas-desain", name: "Kelas Desain" });
      const stream = await goLive(ownerId, "public");
      await heartbeat(stream.id, "viewer-1", new Date());
      await heartbeat(stream.id, "viewer-2", new Date());

      const rows = await repo().browse({ search: "", category: "", limit: 24 });

      expect(rows.find((r) => r.slug === created.slug)!.live).toEqual({
        streamId: stream.id,
        viewerCount: 2,
      });
    });

    it("is live regardless of the stream's visibility — a discovery signal even when gated", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "kelas-desain", name: "Kelas Desain" });
      const stream = await goLive(ownerId, "members");

      const rows = await repo().browse({ search: "", category: "", limit: 24 });

      expect(rows.find((r) => r.slug === created.slug)!.live?.streamId).toBe(stream.id);
    });

    it("is null when the owner has no live stream", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "kelas-desain", name: "Kelas Desain" });

      const rows = await repo().browse({ search: "", category: "", limit: 24 });

      expect(rows.find((r) => r.slug === created.slug)!.live).toBeNull();
    });

    it("is null once the owner's stream has ended", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "kelas-desain", name: "Kelas Desain" });
      const stream = await goLive(ownerId);
      await db.update(userStreams).set({ status: "ended" }).where(eq(userStreams.id, stream.id));

      const rows = await repo().browse({ search: "", category: "", limit: 24 });

      expect(rows.find((r) => r.slug === created.slug)!.live).toBeNull();
    });

    it("a viewer count only counts heartbeats within the window", async () => {
      const ownerId = await seedUser("wildan");
      const created = await create(ownerId, { slug: "kelas-desain", name: "Kelas Desain" });
      const stream = await goLive(ownerId);
      await heartbeat(stream.id, "fresh", new Date());
      await heartbeat(stream.id, "stale", new Date(Date.now() - 60_000));

      const rows = await repo().browse({ search: "", category: "", limit: 24 });

      expect(rows.find((r) => r.slug === created.slug)!.live?.viewerCount).toBe(1);
    });
  });
});
