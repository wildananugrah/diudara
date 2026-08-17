import { describe, expect, it, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { db, sql as pgClient } from "../../db/client";
import { appUsers, follows } from "../../db/schema";
import * as schema from "../../db/schema";
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

/**
 * Runs `fn` and returns whatever it threw, or `null` if it succeeded.
 *
 * Drizzle's query builder is a thenable rather than a real Promise, so
 * `expect(builder).rejects.toThrow()` does not drive it to completion and the
 * assertion passes vacuously — see `schema-phase5.test.ts`'s identical
 * helper. Awaiting inside a real async function (a genuine `try`/`catch`, no
 * IIFE needed) does.
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
 * Walks a caught error's `.cause` chain for the Postgres SQLSTATE and, when
 * present, the constraint name — the same shape `pg-errors.ts`'s
 * `uniqueViolationConstraint` documents for `23505`, generalised to any code.
 */
function driverError(error: unknown): { code: unknown; constraintName: unknown } {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code !== undefined) {
      return { code: candidate.code, constraintName: candidate.constraint_name };
    }
    current = candidate.cause;
  }
  return { code: undefined, constraintName: undefined };
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

/**
 * See the port docstring: `follow()` deliberately does NOT guard a self-follow
 * or a nonexistent user. These pin the exact, documented behaviour — a RAW
 * driver error out of `follow()` itself — so a future change that adds a
 * silent `return false` here (which the port docstring explicitly forbids)
 * fails a test, not just a review.
 */
describe("DrizzleFollowRepository.follow — precondition violations (documented, not guarded)", () => {
  it("raises the raw CHECK violation for a self-follow, uncaught", async () => {
    const alice = await seedUser();

    const error = await captureError(() => repo.follow(alice.id, alice.id));

    expect(error).not.toBeNull();
    const { code, constraintName } = driverError(error);
    expect(code).toBe("23514");
    expect(constraintName).toBe("follow_no_self");

    const rows = await db
      .select()
      .from(follows)
      .where(sql`${follows.followerId} = ${alice.id} and ${follows.followeeId} = ${alice.id}`);
    expect(rows).toHaveLength(0);
  });

  it("raises the raw foreign-key violation for a nonexistent followee, uncaught", async () => {
    const alice = await seedUser();
    const nonexistent = "00000000-0000-4000-8000-000000000000";

    const error = await captureError(() => repo.follow(alice.id, nonexistent));

    expect(error).not.toBeNull();
    const { code, constraintName } = driverError(error);
    expect(code).toBe("23503");
    expect(constraintName).toBe("follow_followee_id_app_user_id_fk");
  });
});

describe("DrizzleFollowRepository.follow — ON CONFLICT target", () => {
  it("names the unique index's columns explicitly, not a bare ON CONFLICT DO NOTHING", async () => {
    const alice = await seedUser();
    const bob = await seedUser();

    // Captures the SQL the SHIPPED `follow()` implementation actually issues,
    // via drizzle's own query logger against the same underlying connection —
    // not a hand-written duplicate query in the test, which would only prove
    // the test's own construction rather than the repository's. Per
    // `drizzle-join-request.repository.ts`'s `createPending` docstring: drop
    // `target` and Postgres still accepts a bare `ON CONFLICT DO NOTHING`
    // (today, with only one unique constraint on this table) — no error to
    // catch, "no test would necessarily notice" — so the only thing that can
    // close this gap is inspecting the SQL text itself.
    const queries: string[] = [];
    const loggedDb = drizzle(pgClient, {
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });
    const loggedRepo = new DrizzleFollowRepository(loggedDb);

    await loggedRepo.follow(alice.id, bob.id);

    const insertQuery = queries.find((query) => query.toLowerCase().includes("insert into"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.toLowerCase()).toContain(
      'on conflict ("follower_id","followee_id") do nothing'
    );
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

  it("listFollowers caps at limit even when more rows exist", async () => {
    const target = await seedUser();
    const followers = await Promise.all(
      Array.from({ length: 5 }, () => seedUser())
    );
    for (const follower of followers) {
      await repo.follow(follower.id, target.id);
    }

    const page = await repo.listFollowers(target.id, 2);

    expect(page).toHaveLength(2);
  });

  it("listFollowing caps at limit even when more rows exist", async () => {
    const source = await seedUser();
    const followees = await Promise.all(
      Array.from({ length: 5 }, () => seedUser())
    );
    for (const followee of followees) {
      await repo.follow(source.id, followee.id);
    }

    const page = await repo.listFollowing(source.id, 2);

    expect(page).toHaveLength(2);
  });

  it("a non-positive limit yields zero rows rather than the whole table", async () => {
    const target = await seedUser();
    const followers = await Promise.all(
      Array.from({ length: 3 }, () => seedUser())
    );
    for (const follower of followers) {
      await repo.follow(follower.id, target.id);
    }

    // Drizzle silently drops the LIMIT clause for a negative value — the
    // hazard `clampLimit` exists to close. -1 is exactly what a malformed
    // HTTP query param (`?limit=-1`) hands the repository.
    expect(await repo.listFollowers(target.id, -1)).toEqual([]);
    expect(await repo.listFollowers(target.id, 0)).toEqual([]);
    expect(await repo.listFollowing(followers[0].id, -1)).toEqual([]);
  });
});

describe("follow_no_self CHECK constraint", () => {
  it("rejects follower_id = followee_id inserted directly through the driver", async () => {
    const alice = await seedUser();

    // Bypasses the repository entirely — proves the CHECK is IN THE DATABASE,
    // not merely enforced by a use-case guard that a bulk import or a manual
    // fix could route around.
    const error = await captureError(() =>
      db.insert(follows).values({ followerId: alice.id, followeeId: alice.id })
    );

    expect(error).not.toBeNull();
    // SQLSTATE 23514 is check_violation; drizzle wraps the driver error, so
    // walk `.cause` the same way `uniqueViolationConstraint` does.
    const { code, constraintName } = driverError(error);
    expect(code).toBe("23514");
    expect(constraintName).toBe("follow_no_self");

    const rows = await db
      .select()
      .from(follows)
      .where(sql`${follows.followerId} = ${alice.id} and ${follows.followeeId} = ${alice.id}`);
    expect(rows).toHaveLength(0);
  });
});

/**
 * ASSERTED AGAINST `pg_indexes`, not against `schema.ts` — same discipline as
 * `schema-phase5.test.ts`'s "the indexes Phase 5's hourly passes read
 * through": a declaration in the schema that never made it into a generated
 * migration is exactly the state this guards against, and only the database
 * can say whether the index actually exists. Both directional indexes here
 * back every profile view's `listFollowers`/`listFollowing`/`countsFor` and
 * were removable with the entire suite green before this test existed —
 * nothing in `drizzle-follow.repository.test.ts` names either index.
 */
describe("the indexes profile reads go through", () => {
  async function indexDefinition(name: string): Promise<string | null> {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'follow' and indexname = ${name}`
    );
    return rows.length === 0 ? null : rows[0].indexdef;
  }

  it("indexes follower lookups by (followee_id, created_at)", async () => {
    const definition = await indexDefinition("follow_followee_created_idx");
    expect(definition).not.toBeNull();
    // Column order is the point: followee_id is the equality "who follows
    // this person" filters on, created_at is what the list sorts by.
    expect(definition).toMatch(/\(\s*followee_id\s*,\s*created_at\s*\)/);
  });

  it("indexes following lookups by (follower_id, created_at)", async () => {
    const definition = await indexDefinition("follow_follower_created_idx");
    expect(definition).not.toBeNull();
    expect(definition).toMatch(/\(\s*follower_id\s*,\s*created_at\s*\)/);
  });

  it("still has the unique index arbitrating one row per (follower_id, followee_id)", async () => {
    const definition = await indexDefinition("follow_follower_followee_unique");
    expect(definition).not.toBeNull();
    expect(definition).toContain("UNIQUE");
    expect(definition).toMatch(/\(\s*follower_id\s*,\s*followee_id\s*\)/);
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
