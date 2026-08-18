## Task 1: The `post` table and its repository

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add after `follows`, which ends at line 862)
- Modify: `apps/api/src/db/test-helpers.ts`
- Create: `apps/api/src/application/ports/post-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts`

**Interfaces:**
- Consumes: `appUsers`, `follows` from `../../db/schema`; `clampLimit` exported from `./drizzle-follow.repository`; `KeysetCursor` from `../../domain/keyset-cursor`.
- Produces: everything in `post-repository.port.ts` below, and `DrizzlePostRepository`.

- [ ] **Step 1: Add the table to `schema.ts`**

Append after the `follows` declaration. `index`, `uniqueIndex`, `check` and `sql` are already imported at the top of the file.

```ts
export const posts = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => appUsers.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set on edit, null otherwise. Drives PostCard's `· diedit` marker, which is
    // the whole of "a reader can tell a post changed" — there is no edit history.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // SOFT delete. Every read path must filter this, and the spec (§4.2) names a
    // filter present on three paths and missing on the fourth as this phase's
    // single biggest risk: each path's own tests only ever create live posts, so
    // nothing goes red.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Untuk Anda: newest first across everybody. PARTIAL, so deleted rows leave
    // the hot index entirely rather than being filtered out of every scan.
    index("post_live_created_idx")
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    // A profile's posts, and the post side of the Mengikuti join.
    index("post_author_created_idx").on(table.authorId, table.createdAt.desc()),
  ]
);
```

- [ ] **Step 2: Generate the migration and read what it produced**

```bash
cd apps/api && bun run db:generate && bun run db:migrate
```

Then open the new `apps/api/drizzle/00NN_*.sql` and **confirm with your own eyes** that it contains
`DESC` on both index columns and `WHERE "deleted_at" is null` on `post_live_created_idx`. Drizzle
silently drops modifiers it does not understand. If either is missing, fix `schema.ts` and
regenerate — never edit the SQL.

Paste the generated file into your report.

- [ ] **Step 3: Add `posts` to the truncate order**

In `apps/api/src/db/test-helpers.ts`, add before the `appUsers` delete, with a comment matching the
style every existing entry uses:

```ts
// post references app_user (author), so it must clear before app_user.
await db.delete(posts);
```

- [ ] **Step 4: Write the port**

Create `apps/api/src/application/ports/post-repository.port.ts`:

```ts
import type { KeysetCursor } from "../../domain/keyset-cursor";

/**
 * One post as the repository returns it: FLAT, with the author's public fields
 * joined in. The nesting into `{ author: { ... } }` happens in `post-views.ts`,
 * so the shape the wire sees is decided in exactly one place.
 *
 * `authorId` is deliberately ABSENT — nothing outside the ownership check needs
 * it, and a row shape that carries it is one `c.json(row)` away from leaking it.
 */
export interface PostRow {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  authorHandle: string;
  authorDisplayName: string;
}

/** What an edit or delete needs before it is allowed to proceed. */
export interface PostOwnership {
  id: string;
  authorId: string;
  isDeleted: boolean;
}

export interface PostRepositoryPort {
  create(authorId: string, body: string): Promise<PostRow>;
  /** `null` when the id has never existed. A soft-deleted post still resolves, with `isDeleted: true`. */
  ownershipOf(id: string): Promise<PostOwnership | null>;
  /** `null` if the post is missing or already deleted. Sets `edited_at`. */
  updateBody(id: string, body: string): Promise<PostRow | null>;
  /** Idempotent: deleting an already-deleted post is a no-op, not an error. */
  softDelete(id: string): Promise<void>;
  /** Newest first, across every author. Excludes deleted. */
  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /** Newest first, only authors `viewerId` follows. Excludes deleted. Excludes the viewer's own. */
  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /** Newest first, one author. Excludes deleted. */
  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
}
```

Note `listFollowing` excludes the viewer's own posts: Mengikuti means the accounts you follow, and
you cannot follow yourself (`follow_no_self`), so a join through `follow` excludes them naturally.
The docstring records it so nobody "fixes" it later by adding a union.

- [ ] **Step 5: Write the failing repository tests**

Create `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts`. Copy the fixture
idiom from `drizzle-follow.repository.test.ts` verbatim — `beforeEach(resetDatabase)`, a module-level
`seedUser`, a module-level `const repo = new DrizzlePostRepository(db)`.

```ts
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
```

- [ ] **Step 6: Run them and watch them fail**

```bash
cd /Users/bellinnn/Documents/projects/diudara && bun run test 2>&1 | grep -E "drizzle-post|[0-9]+ (pass|fail)"
```
Expected: failure on `Cannot find module './drizzle-post.repository'`.

- [ ] **Step 7: Write the repository**

Create `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts`:

```ts
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, follows, posts } from "../../db/schema";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../../application/ports/post-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

/**
 * The ONE projection every read path selects. `author_id` and `deleted_at` are
 * absent by construction rather than stripped later — Phase 1's review found the
 * no-email invariant defended on only two of five repository paths precisely
 * because each path chose its own columns.
 */
const postColumns = {
  id: posts.id,
  body: posts.body,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
  authorHandle: appUsers.handle,
  authorDisplayName: appUsers.displayName,
} as const;

/**
 * `(created_at, id) < (cursor.timestamp, cursor.id)` in a form Postgres can use
 * the index for. Written as an explicit OR rather than a row comparison because
 * the index is `(created_at desc, id desc)` and a row-wise `<` on mixed
 * directions does not match it.
 */
function beforeCursor(cursor: KeysetCursor | null) {
  if (cursor === null) return undefined;
  return or(
    lt(posts.createdAt, cursor.timestamp),
    and(eq(posts.createdAt, cursor.timestamp), lt(posts.id, cursor.id))
  );
}

export class DrizzlePostRepository implements PostRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(authorId: string, body: string): Promise<PostRow> {
    const [inserted] = await this.db
      .insert(posts)
      .values({ authorId, body })
      .returning({ id: posts.id });
    const row = await this.readOne(inserted!.id);
    // The row was just inserted inside this call; a null here means the
    // projection join is broken, which is a bug rather than a missing post.
    if (row === null) throw new Error("post disappeared immediately after insert");
    return row;
  }

  async ownershipOf(id: string): Promise<PostOwnership | null> {
    const [row] = await this.db
      .select({ id: posts.id, authorId: posts.authorId, deletedAt: posts.deletedAt })
      .from(posts)
      .where(eq(posts.id, id));
    if (row === undefined) return null;
    return { id: row.id, authorId: row.authorId, isDeleted: row.deletedAt !== null };
  }

  async updateBody(id: string, body: string): Promise<PostRow | null> {
    const [updated] = await this.db
      .update(posts)
      .set({ body, editedAt: sql`now()` })
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .returning({ id: posts.id });
    if (updated === undefined) return null;
    return this.readOne(updated.id);
  }

  async softDelete(id: string): Promise<void> {
    // No `isNull` guard: re-deleting is a no-op that must not error, and
    // re-stamping deleted_at on an already-deleted row changes nothing anyone
    // can observe. The guard would only make the second call a silent failure.
    await this.db
      .update(posts)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)));
  }

  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(isNull(posts.deletedAt), limit, before);
  }

  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(and(eq(posts.authorId, authorId), isNull(posts.deletedAt)), limit, before);
  }

  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    // The join through `follow` is what excludes the viewer's own posts:
    // `follow_no_self` means no row can pair someone with themselves.
    return this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .innerJoin(follows, eq(follows.followeeId, posts.authorId))
      .where(and(eq(follows.followerId, viewerId), isNull(posts.deletedAt), beforeCursor(before)))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(clampLimit(limit));
  }

  private page(
    filter: ReturnType<typeof and>,
    limit: number,
    before: KeysetCursor | null
  ): Promise<PostRow[]> {
    return this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .where(and(filter, beforeCursor(before)))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(clampLimit(limit));
  }

  private async readOne(id: string): Promise<PostRow | null> {
    const [row] = await this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .where(eq(posts.id, id));
    return row ?? null;
  }
}
```

- [ ] **Step 8: Run the tests until green**

```bash
cd /Users/bellinnn/Documents/projects/diudara && bun run test 2>&1 | grep -E "[0-9]+ (pass|fail)"
```
Expected: 0 fail across all four workspaces.

- [ ] **Step 9: Prove the soft-delete filters are real**

Delete `isNull(posts.deletedAt)` from `listGlobal`, run the suite, record which test fails and its
exact output. Restore. Repeat for `listByAuthor` and for `listFollowing`. **All three must go red
individually.** If any of them stays green the filter is untested and you must add the missing
assertion — this is the risk the spec names as this phase's biggest. Paste all three outputs.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(posts): the post table and its repository"
```

---

