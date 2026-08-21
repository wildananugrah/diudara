import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { ConflictError } from "../../application/errors";
import { db } from "../../db/client";
import { appUsers, posts as postsTable } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePostEditUnitOfWork } from "./drizzle-post-edit-unit-of-work";
import { DrizzlePostRepository } from "./drizzle-post.repository";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzlePostEditUnitOfWork(db);
const posts = new DrizzlePostRepository(db);

let seedCounter = 0;

async function seedUser() {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `postuow${seedCounter}`,
      email: `postuow${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: `Post UoW ${seedCounter}`,
      bio: null,
    })
    .returning();
  return row!;
}

async function seedPost(): Promise<{ authorId: string; postId: string }> {
  const author = await seedUser();
  const post = await posts.create(author.id, "asli", "public");
  return { authorId: author.id, postId: post.id };
}

/**
 * Mirrors `drizzle-user-purchase.unit-of-work.test.ts` exactly: proves
 * `posts`/`media` are bound to the SAME transaction the unit of work opens,
 * not to the pool — the entire mechanism `PostEditUnitOfWorkPort`'s
 * docstring claims, on BOTH the paths that depend on it: fix round 1's path
 * 2 (`EditPost`'s claim failing after the visibility write already ran) and
 * fix round 2 (`CreatePost`'s claim failing after the post row already
 * committed).
 *
 * `write-post.test.ts`'s own real-transaction describe blocks prove the SAME
 * property through genuine `EditPost.execute()`/`CreatePost.execute()` calls
 * and a REAL `ConflictError` from a real vanished-media race — the tests a
 * reader will find most convincing. This file proves it one layer down,
 * directly against `DrizzlePostEditUnitOfWork` itself, which those other
 * tests do not touch (they open their own ad hoc transaction to inject the
 * race). Without this file, a defect confined to `DrizzlePostEditUnitOfWork.run`
 * alone — for instance, constructing its repositories against the POOL
 * instead of the transaction handle it opens — would be invisible to every
 * test that never calls `run` directly.
 */
describe("DrizzlePostEditUnitOfWork", () => {
  it("rolls the visibility write back when the work throws after it", async () => {
    const { postId } = await seedPost();

    await expect(
      unitOfWork().run(async ({ posts: tx }) => {
        const updated = await tx.updateBody(postId, "sekarang khusus anggota", "members");
        expect(updated?.visibility).toBe("members");
        // Stands in for `requireFullyClaimed` throwing after `updateBody` has
        // already run in the same `work` — fix round 1's path 2, reproduced
        // at the level this class alone is responsible for.
        throw new ConflictError("boom, simulating a failed claim after the write");
      })
    ).rejects.toThrow("boom, simulating a failed claim after the write");

    const [row] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
    expect(row!.visibility).toBe("public");
    expect(row!.body).toBe("asli");
  });

  /**
   * Fix round 2's shape, one layer down from `write-post.test.ts`'s
   * `CreatePost — real transaction` block: a post write followed by a
   * throw, inside the SAME `run`, must leave no row at all — not merely an
   * unchanged one, since a create has no prior state to fall back to.
   */
  it("rolls the post write back entirely when the work throws after it", async () => {
    const author = await seedUser();

    await expect(
      unitOfWork().run(async ({ posts: tx }) => {
        await tx.create(author.id, "khusus anggota, foto hilang", "members");
        // Stands in for `requireFullyClaimed` throwing after `posts.create`
        // has already run in the same `work` — fix round 2, reproduced at
        // the level this class alone is responsible for.
        throw new ConflictError("boom, simulating a failed claim after create");
      })
    ).rejects.toThrow("boom, simulating a failed claim after create");

    const rows = await db.select().from(postsTable).where(eq(postsTable.authorId, author.id));
    expect(rows).toEqual([]);
  });

  it("commits the visibility write when the work succeeds", async () => {
    const { postId } = await seedPost();

    await unitOfWork().run(async ({ posts: tx }) => {
      await tx.updateBody(postId, "khusus anggota", "members");
    });

    const [row] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
    expect(row!.visibility).toBe("members");
  });

  it("keeps the write invisible to a pooled reader until the transaction commits", async () => {
    const { postId } = await seedPost();

    let visibilityMidTransaction = "";
    await unitOfWork().run(async ({ posts: tx }) => {
      await tx.updateBody(postId, "khusus anggota", "members");
      const [row] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
      visibilityMidTransaction = row!.visibility;
    });

    expect(visibilityMidTransaction).toBe("public");
    const [after] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
    expect(after!.visibility).toBe("members");
  });

  /**
   * `lockForEdit` specifically — the row lock fix round 1 adds — survives
   * being called through the unit of work rather than only through
   * `EditPost`, so a future caller of this class does not have to
   * rediscover that `ownershipOf` was the wrong choice.
   */
  it("lockForEdit answers the same shape as ownershipOf, from inside the transaction", async () => {
    const { authorId, postId } = await seedPost();

    const owned = await unitOfWork().run(({ posts: tx }) => tx.lockForEdit(postId));

    expect(owned).toEqual({
      id: postId,
      authorId,
      isDeleted: false,
      visibility: "public",
    });
  });
});
