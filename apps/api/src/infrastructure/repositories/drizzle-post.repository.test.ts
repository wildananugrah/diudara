import { describe, expect, it, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, sql as pgClient } from "../../db/client";
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

/**
 * Builds `count` UUIDs for a same-timestamp tie test: `idAtRank(count, 0)` is
 * the LARGEST of the set (sorts first under `desc(id)`), `idAtRank(count,
 * count - 1)` is the smallest. Every varying digit stays 0-9, so hex/lexical
 * ordering of the UUID matches decimal rank ordering exactly.
 */
function idAtRank(count: number, rank: number): string {
  const suffix = (count - 1 - rank).toString().padStart(12, "0");
  return `ffffffff-0000-4000-8000-${suffix}`;
}

/**
 * A fixed permutation of `[0, count)` that is neither ascending nor
 * descending — Task 1 review finding I2: the shipped "orders by id when two
 * posts share a created_at" test above inserted exactly 3 rows in ASCENDING
 * id order and asserted DESCENDING output, which a 3-row top-N heapsort can
 * satisfy BY COINCIDENCE even with the `id` tiebreaker deleted from the
 * query entirely (verified: removing `desc(posts.id)` from `page()` left
 * that test green). Insertion order here matches neither "keep physical
 * order" nor "reverse physical order" — the two ways a small heapsort's tie
 * handling can accidentally look sorted — so only a REAL `ORDER BY id` can
 * produce the exact sequence these tests assert. `step` must be coprime
 * with `count` for this to visit every rank exactly once.
 */
function shuffledRanks(count: number, step = 7): number[] {
  return Array.from({ length: count }, (_, i) => (i * step) % count);
}

describe("DrizzlePostRepository.create", () => {
  it("returns the row with the author's public fields, its id and visibility", async () => {
    const author = await seedUser();

    const row = await repo.create(author.id, "halo semua");

    expect(Object.keys(row).sort()).toEqual([
      "authorDisplayName",
      "authorHandle",
      "authorId",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "visibility",
    ]);
    expect(row.authorHandle).toBe(author.handle);
    expect(row.editedAt === null).toBe(true);
  });

  it("carries the author's id and its visibility, defaulting to public", async () => {
    const author = await seedUser();

    const post = await repo.create(author.id, "halo");
    const rows = await repo.listByAuthor(author.id, 10, null);

    expect(rows[0]?.authorId).toBe(author.id);
    expect(rows[0]?.visibility).toBe("public");
    expect(post.authorId).toBe(author.id);
    expect(post.visibility).toBe("public");
  });
});

/**
 * What BARRIER TWO (`MediaEntitlement`, spec §6.2) reads before any bytes
 * leave storage.
 */
describe("DrizzlePostRepository.gatingOf", () => {
  it("answers the author and the visibility of a public post", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "terbuka");

    expect(await repo.gatingOf(post.id)).toEqual({
      authorId: author.id,
      // The literal on the wire between the column and the gate, never the
      // constant it is compared against.
      visibility: "public",
    });
  });

  it("answers 'members' for a gated post", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "khusus anggota");
    await db
      .update(posts)
      .set({ visibility: "members" })
      .where(sql`${posts.id} = ${post.id}`);

    expect(await repo.gatingOf(post.id)).toEqual({
      authorId: author.id,
      visibility: "members",
    });
  });

  /**
   * Spec §6.3, and the reason this method has no `deleted_at` filter: a
   * soft-deleted post is unreachable through every projection, but its images
   * are still reachable by id and this route keeps serving them exactly as it
   * does today. Answering `null` here would make the gate refuse them, which
   * is a change to deletion semantics smuggled in through a WHERE clause.
   */
  it("still answers for a SOFT-DELETED post, with the visibility it was deleted with", async () => {
    const author = await seedUser();
    const post = await repo.create(author.id, "dihapus");
    await db
      .update(posts)
      .set({ visibility: "members" })
      .where(sql`${posts.id} = ${post.id}`);
    await repo.softDelete(post.id);

    expect(await repo.gatingOf(post.id)).toEqual({
      authorId: author.id,
      visibility: "members",
    });
  });

  it("answers null for an id that has never existed", async () => {
    expect(await repo.gatingOf("8a1f0e6e-0000-4000-8000-000000000000")).toBeNull();
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

  it("breaks a WIDE same-timestamp tie strictly by id — page()'s own tiebreaker, not luck", async () => {
    const author = await seedUser();
    const shared = new Date("2026-08-18T06:00:00.000Z");
    const count = 24;

    for (const rank of shuffledRanks(count)) {
      await seedPost(author.id, `rank-${rank}`, shared, idAtRank(count, rank));
    }

    const rows = await repo.listGlobal(count, null);

    expect(rows.map((row) => row.body)).toEqual(
      Array.from({ length: count }, (_, rank) => `rank-${rank}`)
    );
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

  it("breaks a WIDE same-timestamp tie strictly by id — listFollowing's own tiebreaker, not luck", async () => {
    const viewer = await seedUser();
    const followed = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followeeId: followed.id });
    const shared = new Date("2026-08-18T07:00:00.000Z");
    const count = 24;

    for (const rank of shuffledRanks(count)) {
      await seedPost(followed.id, `rank-${rank}`, shared, idAtRank(count, rank));
    }

    const rows = await repo.listFollowing(viewer.id, count, null);

    expect(rows.map((row) => row.body)).toEqual(
      Array.from({ length: count }, (_, rank) => `rank-${rank}`)
    );
  });

  it("also clamps a nonsensical limit rather than returning the whole table", async () => {
    const viewer = await seedUser();
    const followed = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followeeId: followed.id });
    await repo.create(followed.id, "satu juga");

    // I4: `listFollowing` calls `clampLimit` at its OWN call site rather than
    // through `page()` — this fails independently if that call is ever
    // replaced with a bare `limit`.
    expect(await repo.listFollowing(viewer.id, -1, null)).toEqual([]);
  });
});

describe("DrizzlePostRepository limits", () => {
  it("returns nothing for a nonsensical limit rather than the whole table", async () => {
    const author = await seedUser();
    await repo.create(author.id, "satu");

    expect(await repo.listGlobal(-1, null)).toEqual([]);
  });
});

/**
 * Task 1 review finding I3: the exact-key-set assertion in
 * `DrizzlePostRepository.create` above only exercises `readOne` — the
 * `.map((row) => row.body)` idiom every list test uses, and `toEqual([])` on
 * the soft-delete test, cannot see an extra key at all. Verified by mutation:
 * adding `deletedAt` and `appUsers.email` to the select in `page()` or in
 * `listFollowing()` left the whole suite at 9 pass / 0 fail before these
 * existed. (`authorId` and `visibility` were later added to `postColumns`
 * deliberately, in Phase 6 — the exact-key-set below was widened alongside
 * them, not exempted from this check.) `postColumns` is shared by all three
 * list paths, so one row from each is enough to catch a leak introduced at
 * either call site.
 */
describe("DrizzlePostRepository projection on every list path", () => {
  const POST_ROW_KEYS = [
    "authorDisplayName",
    "authorHandle",
    "authorId",
    "body",
    "createdAt",
    "editedAt",
    "id",
    "visibility",
  ].sort();

  it("listGlobal rows carry only the public post fields", async () => {
    const author = await seedUser();
    await repo.create(author.id, "cek proyeksi global");

    const [row] = await repo.listGlobal(1, null);

    expect(Object.keys(row!).sort()).toEqual(POST_ROW_KEYS);
  });

  it("listByAuthor rows carry only the public post fields", async () => {
    const author = await seedUser();
    await repo.create(author.id, "cek proyeksi penulis");

    const [row] = await repo.listByAuthor(author.id, 1, null);

    expect(Object.keys(row!).sort()).toEqual(POST_ROW_KEYS);
  });

  it("listFollowing rows carry only the public post fields", async () => {
    const viewer = await seedUser();
    const followed = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followeeId: followed.id });
    await repo.create(followed.id, "cek proyeksi mengikuti");

    const [row] = await repo.listFollowing(viewer.id, 1, null);

    expect(Object.keys(row!).sort()).toEqual(POST_ROW_KEYS);
  });
});

/**
 * Task 1 review finding C1. An index that EXISTS is not an index the planner
 * USES: both indexes below were present in every migration since Task 1 but
 * read by NEITHER `listGlobal` nor `listByAuthor`/`listFollowing` —
 * `pg_stat_user_indexes` showed `post_live_created_idx` at `idx_scan: 0`
 * after four real queries, because drizzle's query-builder `desc()` (bare
 * `DESC`, which Postgres reads as `NULLS FIRST`) didn't match either index's
 * own `DESC NULLS LAST`. See `newestFirstOrder()`'s docstring in
 * `drizzle-post.repository.ts` for the fix.
 *
 * TWO layers, same discipline `drizzle-follow.repository.test.ts`'s "the
 * indexes profile reads go through" and `schema-phase5.test.ts`'s "the
 * indexes Phase 5's hourly passes read through" each established
 * separately: `pg_indexes` proves the index EXISTS with the right columns —
 * a declaration in `schema.ts` that never made it into a generated migration
 * is exactly that gap — and a REAL `EXPLAIN` on a REALISTICALLY sized table
 * proves the planner actually chooses it. `enable_seqscan = off` is
 * deliberately NOT used for the second part — that would make any index
 * look used, which is the exact failure this guards against — so the table
 * is instead given a size (100 authors, 10k posts, 5% soft-deleted,
 * `analyze`d) where seq-scanning is measurably worse. A tiny table is
 * correctly seq-scanned however many indexes it has.
 */
describe("the indexes post reads go through", () => {
  async function indexDefinition(name: string): Promise<string | null> {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'post' and indexname = ${name}`
    );
    return rows.length === 0 ? null : rows[0].indexdef;
  }

  it("indexes listGlobal's (created_at desc, id desc), live rows only", async () => {
    const definition = await indexDefinition("post_live_created_idx");
    expect(definition).not.toBeNull();
    expect(definition).toMatch(/\(\s*created_at\s+DESC[^,]*,\s*id\s+DESC/i);
    expect(definition).toContain("WHERE (deleted_at IS NULL)");
  });

  it("indexes listByAuthor's/listFollowing's (author_id, created_at desc)", async () => {
    const definition = await indexDefinition("post_author_created_idx");
    expect(definition).not.toBeNull();
    expect(definition).toMatch(/\(\s*author_id\s*,\s*created_at\s+DESC/i);
  });

  it("plans listGlobal and listByAuthor WITHOUT a sequential scan of post", async () => {
    await db.execute(sql`
      insert into app_user (handle, email, whatsapp_number, password_hash, display_name, bio)
      select 'bulkpost' || g, 'bulkpost' || g || '@example.com', null, 'x', 'Bulk Post Author ' || g, null
      from generate_series(1, 100) g
    `);
    await db.execute(sql`
      insert into post (author_id, body, created_at, deleted_at)
      select a.id,
             'bulk post ' || gs,
             timestamptz '2026-01-01 00:00:00+00' + (gs || ' seconds')::interval,
             case when gs % 20 = 0
               then timestamptz '2026-01-01 00:00:00+00' + (gs || ' seconds')::interval
               else null
             end
      from generate_series(1, 10000) gs
      join (
        select id, (row_number() over (order by id) - 1) as idx
        from app_user where handle like 'bulkpost%'
      ) a on a.idx = gs % 100
    `);
    // Statistics, or the planner is guessing — and a planner that is
    // guessing picks a seq scan.
    await db.execute(sql`analyze post`);
    await db.execute(sql`analyze app_user`);

    const oneAuthorId = (
      await db.execute<{ id: string }>(sql`select id from app_user where handle = 'bulkpost1'`)
    )[0]!.id;

    // Captures the EXACT SQL the SHIPPED `listGlobal`/`listByAuthor` issue —
    // NOT a hand-written copy of what they are supposed to produce, which
    // would drift silently from the real query and pass regardless of what
    // the repository actually does. This is the gap a first draft of this
    // test had: it hand-wrote `order by ... desc nulls last` directly in the
    // EXPLAIN text, so mutating `newestFirstOrder()` back to the shipped bug
    // left it green — proving nothing. `.toSQL()` is drizzle's synchronous,
    // non-executing introspection of its own lazy query builder: calling it
    // on the un-awaited return of `listGlobal`/`listByAuthor` (both are NOT
    // `async` methods — they return the builder chain itself) never sends
    // anything over the wire on its own.
    type ToSql = { toSQL(): { sql: string; params: unknown[] } };
    const { sql: globalText, params: globalParams } = (
      repo.listGlobal(20, null) as unknown as ToSql
    ).toSQL();
    const { sql: byAuthorText, params: byAuthorParams } = (
      repo.listByAuthor(oneAuthorId, 20, null) as unknown as ToSql
    ).toSQL();

    const globalPlan = await pgClient.unsafe<{ "QUERY PLAN": string }[]>(
      `explain ${globalText}`,
      globalParams as never[]
    );
    const byAuthorPlan = await pgClient.unsafe<{ "QUERY PLAN": string }[]>(
      `explain ${byAuthorText}`,
      byAuthorParams as never[]
    );

    const globalPlanText = globalPlan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(globalPlanText).not.toContain("Seq Scan on post");
    expect(globalPlanText).toContain("post_live_created_idx");

    const byAuthorPlanText = byAuthorPlan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(byAuthorPlanText).not.toContain("Seq Scan on post");
    expect(byAuthorPlanText).toContain("post_author_created_idx");
  });
});
