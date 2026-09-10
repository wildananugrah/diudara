import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { appUsers, communities, posts, postComments } from "./schema";
import { resetDatabase } from "./test-helpers";

/**
 * Local to this file, per the Task 1 brief's pre-flight ruling: this file has
 * no existing user fixture to reuse, so it copies the seeding shape
 * `schema-phase5b.test.ts` uses (handle/email/password_hash/display_name),
 * with a module-level counter so repeated calls in one test never collide on
 * the unique `handle`/`email` indexes.
 */
/**
 * Drizzle's query builder is a thenable rather than a real Promise, so
 * `expect(builder).rejects.toThrow()` does not drive it to completion and the
 * assertion passes vacuously (in this run it instead failed outright with
 * "Expected promise" — either way, not a real assertion) — see
 * `drizzle-follow.repository.test.ts`'s identical helper and comment.
 * Awaiting inside a real async function, a genuine try/catch, drives it.
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * The driver's own constraint name, one level down `error.cause` — same
 * shape `schema-phase5b.test.ts` reads off `membership_reminder`'s claim
 * violation. Asserted against THIS rather than the error's own `.message`,
 * which is drizzle's generic "Failed query" wrapper and never names the
 * constraint at all.
 */
function constraintNameOf(error: unknown): unknown {
  return (error as { cause?: { constraint_name?: unknown } } | null)?.cause?.constraint_name;
}

let userCounter = 0;
function aUser() {
  userCounter += 1;
  return {
    handle: `feeduser${userCounter}`,
    email: `feeduser${userCounter}@example.com`,
    passwordHash: "irrelevant-hash",
    displayName: `Feed User ${userCounter}`,
  };
}

describe("post community constraints", () => {
  beforeEach(resetDatabase);

  test("a personal post may not carry a type other than diskusi", async () => {
    const [user] = await db.insert(appUsers).values(aUser()).returning();
    const error = await captureError(() =>
      db.insert(posts).values({ authorId: user.id, body: "halo", type: "pengumuman" })
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("post_personal_has_no_type");
  });

  test("a community post may not carry the personal paywall", async () => {
    const [user] = await db.insert(appUsers).values(aUser()).returning();
    const [community] = await db
      .insert(communities)
      .values({ ownerId: user.id, name: "Kelas Fisika", slug: "kelas-fisika", category: "Bimbel & Ujian" })
      .returning();
    const error = await captureError(() =>
      db.insert(posts).values({
        authorId: user.id,
        communityId: community.id,
        body: "halo",
        visibility: "members",
      })
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("post_community_is_public");
  });

  test("a community post with the defaults is accepted", async () => {
    const [user] = await db.insert(appUsers).values(aUser()).returning();
    const [community] = await db
      .insert(communities)
      .values({ ownerId: user.id, name: "Kelas Fisika", slug: "kelas-fisika", category: "Bimbel & Ujian" })
      .returning();
    const [row] = await db
      .insert(posts)
      .values({ authorId: user.id, communityId: community.id, body: "halo" })
      .returning();
    expect(row.type).toBe("diskusi");
    expect(row.visibility).toBe("public");
  });
});
