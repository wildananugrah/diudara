import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, postMedia, posts } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMediaRepository } from "./drizzle-media.repository";

beforeEach(resetDatabase);

const repo = new DrizzleMediaRepository(db);

let seedCounter = 0;

/** Follows `drizzle-post.repository.test.ts`'s `seedUser` shape exactly. */
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

async function createPost(authorId: string) {
  const [row] = await db.insert(posts).values({ authorId, body: "irrelevant body" }).returning();
  return row!;
}

/** Updates `created_at` directly via drizzle — bytes that "arrived" in the past, for the sweep test. */
async function backdate(id: string, createdAt: Date) {
  await db.update(postMedia).set({ createdAt }).where(eq(postMedia.id, id));
}

describe("DrizzleMediaRepository", () => {
  it("creates an unclaimed row and finds it by id", async () => {
    const owner = await createUser("wildan");

    const created = await repo.create({
      ownerId: owner.id,
      width: 1600,
      height: 900,
      byteSize: 240_000,
    });

    expect(created.postId).toBe(null);
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("claims rows onto a post, in the order given", async () => {
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const a = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    const b = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    await repo.claim(post.id, [b.id, a.id]);

    const rows = await repo.listForPost(post.id);
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it("unclaims rows that a post no longer holds, without deleting them", async () => {
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const kept = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    const dropped = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    await repo.claim(post.id, [kept.id, dropped.id]);

    await repo.claim(post.id, [kept.id]);

    expect((await repo.listForPost(post.id)).map((r) => r.id)).toEqual([kept.id]);
    // The row SURVIVES, unclaimed — spec §8. Asserting only its absence from the
    // post would pass equally well against an implementation that deleted it.
    const orphan = await repo.findById(dropped.id);
    expect(orphan?.postId).toBe(null);
  });

  /**
   * **The sweep must not be able to delete a post's live photo.** Final
   * whole-branch review, Important 4: `listUnclaimedBefore` returns a row, a
   * composer left open overnight claims it a moment later, and the sweep then
   * deleted it anyway — `deleteById` carried no guard at all, so the post
   * silently ended up with fewer images than its author sent and nothing
   * noticed.
   */
  it("refuses to delete a row that has been claimed since it was listed", async () => {
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const row = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    await repo.claim(post.id, [row.id]);

    const deleted = await repo.deleteIfUnclaimed(row.id);

    expect(deleted).toBe(false);
    expect(await repo.findById(row.id)).not.toBe(null);
  });

  it("deletes a row that is still unclaimed, and says so", async () => {
    const owner = await createUser("wildan");
    const row = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    const deleted = await repo.deleteIfUnclaimed(row.id);

    expect(deleted).toBe(true);
    expect(await repo.findById(row.id)).toBe(null);
  });

  it("says false for an id that is not there at all", async () => {
    expect(await repo.deleteIfUnclaimed("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  /**
   * `claim` used to return nothing and issue one blind UPDATE per id, so a row
   * that had vanished between the ownership check and the claim was a silent
   * no-op — the post came back with fewer photos than were asked for. Returning
   * the count is what lets `CreatePost`/`EditPost` notice.
   */
  it("reports how many rows it actually claimed", async () => {
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const a = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    const b = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    expect(await repo.claim(post.id, [a.id, b.id])).toBe(2);
  });

  it("reports a short count when one of the ids has vanished", async () => {
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const alive = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    const claimed = await repo.claim(post.id, [alive.id, "00000000-0000-4000-8000-000000000000"]);

    expect(claimed).toBe(1);
  });

  it("lists unclaimed rows older than a cutoff, for the sweep", async () => {
    const owner = await createUser("wildan");
    const old = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    await backdate(old.id, new Date(Date.now() - 48 * 60 * 60_000));
    const fresh = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    const stale = await repo.listUnclaimedBefore(new Date(Date.now() - 24 * 60 * 60_000), 100);

    expect(stale.map((r) => r.id)).toEqual([old.id]);
    expect(stale.map((r) => r.id)).not.toContain(fresh.id);
  });
});
