import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { appUsers, communities, communityEvents, posts } from "./schema";
import { resetDatabase } from "./test-helpers";

/**
 * Phase 3's Task 1. The helpers are `schema-community-feed.test.ts`'s,
 * copied rather than shared for the reason that file already records: a
 * schema test file seeds its own fixtures so a failure names one table.
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function constraintNameOf(error: unknown): unknown {
  return (error as { cause?: { constraint_name?: unknown } } | null)?.cause?.constraint_name;
}

let counter = 0;
async function anEventHost() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `eventuser${counter}`,
      email: `eventuser${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Event User ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: user.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  const [post] = await db
    .insert(posts)
    .values({ authorId: user.id, communityId: community.id, body: "kelas tambahan", type: "kegiatan" })
    .returning();
  return { user, community, post };
}

/** 15 September 2026, 16:00 WIB. */
const STARTS_AT = new Date("2026-09-15T09:00:00.000Z");

describe("community_event constraints", () => {
  beforeEach(resetDatabase);

  test("an event with only the required fields is accepted", async () => {
    const { community, post } = await anEventHost();
    const [row] = await db
      .insert(communityEvents)
      .values({
        postId: post.id,
        communityId: community.id,
        title: "Kelas tambahan: Trigonometri lanjutan",
        startsAt: STARTS_AT,
      })
      .returning();
    expect(row.postId).toBe(post.id);
    expect(row.endsAt).toBeNull();
    expect(row.location).toBeNull();
  });

  test("ends_at may not land before starts_at", async () => {
    const { community, post } = await anEventHost();
    const error = await captureError(() =>
      db.insert(communityEvents).values({
        postId: post.id,
        communityId: community.id,
        title: "Mundur ke masa lalu",
        startsAt: STARTS_AT,
        endsAt: new Date(STARTS_AT.getTime() - 60_000),
      })
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("community_event_ends_after_starts");
  });

  /**
   * A zero-length event is a data-entry slip the composer's own time fields
   * make easy to produce, so the CHECK is `>` and not `>=` (spec §"The
   * CHECK"). Asserted separately from the backwards case because an
   * off-by-one in the operator passes that test and fails this one.
   */
  test("ends_at may not equal starts_at", async () => {
    const { community, post } = await anEventHost();
    const error = await captureError(() =>
      db.insert(communityEvents).values({
        postId: post.id,
        communityId: community.id,
        title: "Tanpa durasi",
        startsAt: STARTS_AT,
        endsAt: STARTS_AT,
      })
    );
    expect(error).not.toBeNull();
    expect(constraintNameOf(error)).toBe("community_event_ends_after_starts");
  });

  /**
   * The 1:1 is the primary key doing its job: a second row for the same post
   * is what an event with two dates would look like in the database.
   */
  test("a post may carry only one event", async () => {
    const { community, post } = await anEventHost();
    const values = {
      postId: post.id,
      communityId: community.id,
      title: "Sesi pertama",
      startsAt: STARTS_AT,
    };
    await db.insert(communityEvents).values(values);
    const error = await captureError(() =>
      db.insert(communityEvents).values({ ...values, title: "Sesi kedua" })
    );
    expect(error).not.toBeNull();
  });

  test("resetDatabase clears events, so a suite that made one leaves none", async () => {
    const { community, post } = await anEventHost();
    await db.insert(communityEvents).values({
      postId: post.id,
      communityId: community.id,
      title: "Akan dihapus",
      startsAt: STARTS_AT,
    });
    await resetDatabase();
    expect(await db.select().from(communityEvents)).toHaveLength(0);
  });
});
