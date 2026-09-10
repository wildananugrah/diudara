import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, postComments, posts } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommentRepository } from "./drizzle-comment.repository";

beforeEach(resetDatabase);

let seedCounter = 0;

/** Same shape as `drizzle-post.repository.test.ts`'s `seedUser`, but the handle is caller-chosen — the first test asserts on it. */
async function seedUser(handle: string, displayName: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle,
      email: `${handle}-${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName,
      bio: null,
    })
    .returning();
  return row!;
}

async function seedPost(authorId: string, body: string) {
  const [row] = await db.insert(posts).values({ authorId, body }).returning();
  return row!;
}

/**
 * Pins `created_at` explicitly: `listForPost` orders by it, and two inserts a
 * few milliseconds apart could otherwise tie or invert under wall-clock jitter.
 */
async function seedComment(postId: string, authorId: string, body: string, createdAt: Date) {
  const [row] = await db
    .insert(postComments)
    .values({ postId, authorId, body, createdAt })
    .returning();
  return row!;
}

/**
 * One user whose handle is exactly `wildan`, one post, then two comments —
 * `pertama` then `kedua`, an hour apart so their order is the query's doing,
 * not the clock's. `firstCommentId` is the `pertama` comment.
 */
async function seedPostWithComments(): Promise<{
  postId: string;
  authorId: string;
  firstCommentId: string;
}> {
  const author = await seedUser("wildan", "Wildan Nugrah");
  const post = await seedPost(author.id, "kiriman dengan diskusi");
  const first = await seedComment(
    post.id,
    author.id,
    "pertama",
    new Date("2026-09-10T01:00:00.000Z")
  );
  await seedComment(post.id, author.id, "kedua", new Date("2026-09-10T02:00:00.000Z"));
  return { postId: post.id, authorId: author.id, firstCommentId: first.id };
}

/**
 * postA has two comments (`satu` then `dua`), postB has none — the fixture the
 * `countForPosts` tests need. `firstCommentId` is a comment on postA, for the
 * deleted-count test.
 */
async function seedTwoPostsOneWithComments(): Promise<{
  postAId: string;
  postBId: string;
  firstCommentId: string;
}> {
  const author = await seedUser("komentator", "Komentator");
  const postA = await seedPost(author.id, "punya komentar");
  const postB = await seedPost(author.id, "sepi");
  const first = await seedComment(
    postA.id,
    author.id,
    "satu",
    new Date("2026-09-10T01:00:00.000Z")
  );
  await seedComment(postA.id, author.id, "dua", new Date("2026-09-10T02:00:00.000Z"));
  return { postAId: postA.id, postBId: postB.id, firstCommentId: first.id };
}

describe("DrizzleCommentRepository", () => {
  test("listForPost returns live comments oldest first with the author joined", async () => {
    const ids = await seedPostWithComments(); // "pertama", then "kedua"
    const rows = await new DrizzleCommentRepository(db).listForPost(ids.postId, 50);
    expect(rows.map((r) => r.body)).toEqual(["pertama", "kedua"]);
    expect(rows[0].authorHandle).toBe("wildan");
  });

  test("listForPost excludes a soft-deleted comment", async () => {
    const ids = await seedPostWithComments();
    const repo = new DrizzleCommentRepository(db);
    await repo.softDelete(ids.firstCommentId);
    expect((await repo.listForPost(ids.postId, 50)).map((r) => r.body)).toEqual(["kedua"]);
  });

  test("countForPosts answers for many posts in one call and omits nothing", async () => {
    const ids = await seedTwoPostsOneWithComments(); // postA: 2 comments, postB: 0
    const counts = await new DrizzleCommentRepository(db).countForPosts([
      ids.postAId,
      ids.postBId,
    ]);
    expect(counts.get(ids.postAId)).toBe(2);
    expect(counts.get(ids.postBId) ?? 0).toBe(0);
  });

  test("countForPosts does not count deleted comments", async () => {
    const ids = await seedTwoPostsOneWithComments();
    const repo = new DrizzleCommentRepository(db);
    await repo.softDelete(ids.firstCommentId);
    expect((await repo.countForPosts([ids.postAId])).get(ids.postAId)).toBe(1);
  });

  test("countForPosts with an empty list makes no query and returns an empty map", async () => {
    expect((await new DrizzleCommentRepository(db).countForPosts([])).size).toBe(0);
  });

  test("softDelete is idempotent", async () => {
    const ids = await seedPostWithComments();
    const repo = new DrizzleCommentRepository(db);
    await repo.softDelete(ids.firstCommentId);
    await repo.softDelete(ids.firstCommentId); // must not throw
    expect((await repo.listForPost(ids.postId, 50)).length).toBe(1);
  });

  test("ownershipOf resolves a live comment, a soft-deleted one, and null for a stranger id", async () => {
    const ids = await seedPostWithComments();
    const repo = new DrizzleCommentRepository(db);

    const live = await repo.ownershipOf(ids.firstCommentId);
    expect(live?.postId).toBe(ids.postId);
    expect(live?.authorId).toBe(ids.authorId);
    expect(live?.isDeleted).toBe(false);

    await repo.softDelete(ids.firstCommentId);
    expect((await repo.ownershipOf(ids.firstCommentId))?.isDeleted).toBe(true);

    expect(await repo.ownershipOf("8a1f0e6e-0000-4000-8000-000000000000")).toBeNull();
  });

  test("create returns the new comment with the author's public fields joined", async () => {
    const ids = await seedPostWithComments();
    const row = await new DrizzleCommentRepository(db).create(
      ids.postId,
      ids.authorId,
      "komentar baru"
    );
    expect(row.body).toBe("komentar baru");
    expect(row.authorHandle).toBe("wildan");
    expect(row.authorId).toBe(ids.authorId);
  });
});
