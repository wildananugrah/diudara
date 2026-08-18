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
