import { describe, expect, it, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, follows } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleFollowRepository } from "./drizzle-follow.repository";

beforeEach(resetDatabase);

const repo = new DrizzleFollowRepository(db);

let seedCounter = 0;

async function seedUser(overrides: { displayName?: string; bio?: string | null } = {}) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `user${seedCounter}`,
      email: `user${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: overrides.displayName ?? `User ${seedCounter}`,
      bio: overrides.bio ?? null,
    })
    .returning();
  return row;
}

describe("DrizzleFollowRepository.follow", () => {
  it("returns true on the first call and false on a repeat, leaving one row", async () => {
    const alice = await seedUser();
    const bob = await seedUser();

    const first = await repo.follow(alice.id, bob.id);
    const second = await repo.follow(alice.id, bob.id);

    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await db
      .select()
      .from(follows)
      .where(sql`${follows.followerId} = ${alice.id} and ${follows.followeeId} = ${bob.id}`);
    expect(rows).toHaveLength(1);
  });
});

describe("DrizzleFollowRepository.unfollow", () => {
  it("returns true when a row was removed and false when there was nothing to remove", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    await repo.follow(alice.id, bob.id);

    const first = await repo.unfollow(alice.id, bob.id);
    const second = await repo.unfollow(alice.id, bob.id);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe("DrizzleFollowRepository.isFollowing", () => {
  it("reflects the current state through a follow and an unfollow", async () => {
    const alice = await seedUser();
    const bob = await seedUser();

    expect(await repo.isFollowing(alice.id, bob.id)).toBe(false);

    await repo.follow(alice.id, bob.id);
    expect(await repo.isFollowing(alice.id, bob.id)).toBe(true);

    await repo.unfollow(alice.id, bob.id);
    expect(await repo.isFollowing(alice.id, bob.id)).toBe(false);
  });
});

describe("DrizzleFollowRepository.countsFor", () => {
  it("is correct after a follow, an unfollow and a re-follow", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const carol = await seedUser();

    expect(await repo.countsFor(alice.id)).toEqual({ followers: 0, following: 0 });

    await repo.follow(alice.id, bob.id);
    await repo.follow(carol.id, alice.id);

    expect(await repo.countsFor(alice.id)).toEqual({ followers: 1, following: 1 });

    await repo.unfollow(alice.id, bob.id);
    expect(await repo.countsFor(alice.id)).toEqual({ followers: 1, following: 0 });

    await repo.follow(alice.id, bob.id);
    expect(await repo.countsFor(alice.id)).toEqual({ followers: 1, following: 1 });
  });
});

describe("DrizzleFollowRepository.listFollowers / listFollowing", () => {
  it("returns only handle, displayName and bio, newest first", async () => {
    const target = await seedUser();
    const first = await seedUser({ displayName: "First Follower", bio: "hello" });
    const second = await seedUser({ displayName: "Second Follower", bio: null });

    await repo.follow(first.id, target.id);
    await repo.follow(second.id, target.id);

    const followers = await repo.listFollowers(target.id, 10);

    expect(followers).toHaveLength(2);
    // Newest first: second followed after first.
    expect(followers[0].handle).toBe(second.handle);
    expect(followers[1].handle).toBe(first.handle);
    expect(followers[0].displayName).toBe("Second Follower");
    expect(followers[0].bio).toBeNull();
    expect(followers[1].bio).toBe("hello");

    for (const row of followers) {
      expect(Object.keys(row).sort()).toEqual(["bio", "displayName", "handle"]);
      expect("id" in row).toBe(false);
      expect("email" in row).toBe(false);
    }
  });

  it("listFollowing returns only the three public fields, newest first", async () => {
    const source = await seedUser();
    const olderFollowee = await seedUser({ displayName: "Older Followee" });
    const newerFollowee = await seedUser({ displayName: "Newer Followee" });

    await repo.follow(source.id, olderFollowee.id);
    await repo.follow(source.id, newerFollowee.id);

    const following = await repo.listFollowing(source.id, 10);

    expect(following).toHaveLength(2);
    expect(following[0].handle).toBe(newerFollowee.handle);
    expect(following[1].handle).toBe(olderFollowee.handle);

    for (const row of following) {
      expect(Object.keys(row).sort()).toEqual(["bio", "displayName", "handle"]);
      expect("id" in row).toBe(false);
      expect("email" in row).toBe(false);
    }
  });
});

describe("follow_no_self CHECK constraint", () => {
  it("rejects follower_id = followee_id inserted directly through the driver", async () => {
    const alice = await seedUser();

    // Bypasses the repository entirely — proves the CHECK is IN THE DATABASE,
    // not merely enforced by a use-case guard that a bulk import or a manual
    // fix could route around. Wrapped in an IIFE so `expect().rejects` sees a
    // genuine Promise rather than drizzle's thenable query builder.
    let caught: unknown;
    try {
      await db.insert(follows).values({ followerId: alice.id, followeeId: alice.id });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // SQLSTATE 23514 is check_violation; drizzle wraps the driver error, so
    // walk `.cause` the same way `uniqueViolationConstraint` does.
    let current: unknown = caught;
    let code: unknown;
    let constraintName: unknown;
    for (let depth = 0; current && depth < 5; depth++) {
      const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
      if (candidate.code !== undefined) {
        code = candidate.code;
        constraintName = candidate.constraint_name;
        break;
      }
      current = candidate.cause;
    }
    expect(code).toBe("23514");
    expect(constraintName).toBe("follow_no_self");

    const rows = await db
      .select()
      .from(follows)
      .where(sql`${follows.followerId} = ${alice.id} and ${follows.followeeId} = ${alice.id}`);
    expect(rows).toHaveLength(0);
  });
});

describe("DrizzleFollowRepository.follow concurrency", () => {
  it("four simultaneous calls for the same pair produce one row and exactly one true", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const latch = new ArrivalLatch(4);

    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await latch.arriveAndWait();
        return repo.follow(alice.id, bob.id);
      })
    );

    expect(results.filter((created) => created)).toHaveLength(1);

    const rows = await db
      .select()
      .from(follows)
      .where(sql`${follows.followerId} = ${alice.id} and ${follows.followeeId} = ${bob.id}`);
    expect(rows).toHaveLength(1);
  });
});
