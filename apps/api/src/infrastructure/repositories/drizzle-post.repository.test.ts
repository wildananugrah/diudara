import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, follows, posts } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePostRepository } from "./drizzle-post.repository";

beforeEach(resetDatabase);

const repo = new DrizzlePostRepository(db);

let seedCounter = 0;

async function seedUser() {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `user${seedCounter}`,
      email: `user${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: `User ${seedCounter}`,
      bio: null,
    })
    .returning();
  return row!;
}

/** Inserts directly so `created_at` and `id` are ours to control. */
async function seedPost(authorId: string, body: string, createdAt: Date, id?: string) {
  const [row] = await db
    .insert(posts)
    .values({ authorId, body, createdAt, ...(id === undefined ? {} : { id }) })
    .returning();
  return row!;
}

describe("DrizzlePostRepository.create", () => {
  it("returns the row with the author's public fields and no authorId", async () => {
    const author = await seedUser();

    const row = await repo.create(author.id, "halo semua");

    expect(Object.keys(row).sort()).toEqual([
      "authorDisplayName",
      "authorHandle",
      "body",
      "createdAt",
      "editedAt",
      "id",
    ]);
    expect(row.authorHandle).toBe(author.handle);
    expect(row.editedAt === null).toBe(true);
  });
});

describe("DrizzlePostRepository soft delete", () => {
  it("hides a deleted post from ALL THREE list paths", async () => {
    const author = await seedUser();
    const viewer = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followeeId: author.id });
    const post = await repo.create(author.id, "akan dihapus");

    await repo.softDelete(post.id);

    expect(await repo.listGlobal(20, null)).toEqual([]);
    expect(await repo.listFollowing(viewer.id, 20, null)).toEqual([]);
    expect(await repo.listByAuthor(author.id, 20, null)).toEqual([]);
  });

  it("is idempotent — deleting twice does not throw", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "sekali saja");

    await repo.softDelete(post.id);
    await repo.softDelete(post.id);

    const ownership = await repo.ownershipOf(post.id);
    expect(ownership?.isDeleted).toBe(true);
  });

  it("refuses to edit a deleted post", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "asli");
    await repo.softDelete(post.id);

    expect(await repo.updateBody(post.id, "diubah") === null).toBe(true);
  });
});

describe("DrizzlePostRepository.updateBody", () => {
  it("changes the body and stamps editedAt", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "asli");

    const updated = await repo.updateBody(post.id, "sudah diubah");

    expect(updated?.body).toBe("sudah diubah");
    expect(updated?.editedAt instanceof Date).toBe(true);
  });
});

describe("DrizzlePostRepository keyset pagination", () => {
  it("orders by id when two posts share a created_at, and pages across the tie", async () => {
    const author = await seedUser();
    const shared = new Date("2026-08-18T03:00:00.000Z");
    // Ids chosen so the desc order is c, b, a.
    const a = await seedPost(author.id, "a", shared, "aaaaaaaa-0000-4000-8000-000000000000");
    const b = await seedPost(author.id, "b", shared, "bbbbbbbb-0000-4000-8000-000000000000");
    const c = await seedPost(author.id, "c", shared, "cccccccc-0000-4000-8000-000000000000");

    const firstPage = await repo.listGlobal(2, null);
    expect(firstPage.map((row) => row.body)).toEqual(["c", "b"]);

    const secondPage = await repo.listGlobal(2, { timestamp: shared, id: b.id });
    expect(secondPage.map((row) => row.body)).toEqual(["a"]);
    expect(a.id).toBe("aaaaaaaa-0000-4000-8000-000000000000");
    expect(c.id).toBe("cccccccc-0000-4000-8000-000000000000");
  });

  it("does not repeat or skip a row when a newer post lands between pages", async () => {
    const author = await seedUser();
    const older = await seedPost(author.id, "lama", new Date("2026-08-18T01:00:00.000Z"));
    const newer = await seedPost(author.id, "baru", new Date("2026-08-18T02:00:00.000Z"));

    const firstPage = await repo.listGlobal(1, null);
    expect(firstPage.map((row) => row.body)).toEqual(["baru"]);

    // A post arrives at the TOP between the two "load more" clicks. An offset
    // would now repeat "baru"; a cursor anchored on a row cannot drift.
    await seedPost(author.id, "paling baru", new Date("2026-08-18T03:00:00.000Z"));

    const secondPage = await repo.listGlobal(
      5,
      { timestamp: newer.createdAt, id: newer.id }
    );
    expect(secondPage.map((row) => row.body)).toEqual(["lama"]);
    expect(older.body).toBe("lama");
  });
});

describe("DrizzlePostRepository.listFollowing", () => {
  it("returns only followed authors' posts, never the viewer's own", async () => {
    const viewer = await seedUser();
    const followed = await seedUser();
    const stranger = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followeeId: followed.id });
    await repo.create(followed.id, "diikuti");
    await repo.create(stranger.id, "tidak diikuti");
    await repo.create(viewer.id, "milik sendiri");

    const rows = await repo.listFollowing(viewer.id, 20, null);

    expect(rows.map((row) => row.body)).toEqual(["diikuti"]);
  });
});

describe("DrizzlePostRepository limits", () => {
  it("returns nothing for a nonsensical limit rather than the whole table", async () => {
    const author = await seedUser();
    await repo.create(author.id, "satu");

    expect(await repo.listGlobal(-1, null)).toEqual([]);
  });
});
