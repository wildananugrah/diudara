# Posts and a Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app content — a `post` table, a two-tab Beranda feed, an inline composer, posts on the profile, and edit/delete of your own posts.

**Architecture:** Ports-and-adapters, exactly as the `follow` feature merged yesterday. A `post` table with soft delete, a `PostRepositoryPort` and its Drizzle implementation, use cases that map rows to a public view, Hono routes mounted under `/users`, and React screens under `apps/web/src/user/`. Pagination reuses the existing `keyset-cursor.ts` primitive rather than inventing one.

**Tech Stack:** Bun workspaces, Hono, Drizzle ORM + Postgres, Zod, React 19 + react-router-dom, `bun:test` with happy-dom for the web workspace.

**Spec:** `docs/superpowers/specs/2026-08-18-posts-and-feed-design.md`. Read it once before Task 1; it explains *why* for everything below.

## Global Constraints

- **Root gates: `bun run test` and `bun run typecheck` from the repo root — `bun run test`, NEVER bare `bun test`**, which yields ~123 spurious failures because `apps/web` needs its own `bunfig.toml` preload and Bun reads `bunfig.toml` from CWD only. Baseline at the start of this plan: **2595 pass / 0 fail** (shared 82, worker 38, web 514, api 1961).
- **Migrations are Drizzle-generated only**: edit `apps/api/src/db/schema.ts`, then `cd apps/api && bun run db:generate`. Never hand-write a file in `apps/api/drizzle/`, and never edit an applied one. Commit `apps/api/drizzle/meta/` alongside the `.sql`.
- **Every user-visible string is Bahasa Indonesia.** Error text on screen comes from `describeRequestFailure` in `apps/web/src/user/errorCopy.ts`, never from the server's message. `apps/web/src/test/no-raw-server-errors.test.ts` is a source scan that fails the suite if a component reads `.message` off a caught error.
- **The creator dashboard is forbidden.** Do not touch anything under `apps/web/src/dashboard/`, and do not restyle it. It is deleted in Phase 8.
- **The post projection is exactly `id`, `body`, `createdAt`, `editedAt`, `author: { handle, displayName }`.** No `authorId`, no `deletedAt`, no email, no WhatsApp number. Assert on response **keys** — `expect(Object.keys(x).sort()).toEqual([...])` — never on TypeScript types; a bare `select()` returns every column whatever the types claim.
- **Every new endpoint lives under the `/users/` prefix.** `apps/web/src/test/vite-proxy-coverage.test.ts` statically greps every fetch call site and fails if its first path segment has no entry in `vite.config.ts`'s proxy table. `/users` is already there, so this plan needs **no proxy change** — a new top-level prefix would need one, and that exact gap has broken this app three times.
- **`/beranda` is already inside `AppShell` in `apps/web/src/App.tsx`.** This plan adds **no new route**, so `App.test.tsx`'s exhaustive shell-partition assertions must not change. If you find yourself editing those `toEqual([...])` arrays, stop — you have added a route the plan does not call for.
- **Shared numbers live in `packages/shared/src/auth.schema.ts`** and are imported by both `apps/api` and `apps/web` via `@diudara/shared`. **Tests on both sides assert the LITERAL number, never the constant** — asserting against the same symbol production reads moves in lockstep with a regression and passes vacuously.
- `expect(<DOM element>).toBeNull()` hangs `bun test`. There is a source-scan guard; use `expect(x === null).toBe(true)` or `queryBy...` truthiness instead.
- Conventional-commit subjects, matching `git log --oneline`. Commit per step where the plan says to.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/api/src/application/ports/post-repository.port.ts` | `PostRow`, `PostOwnership`, `PostRepositoryPort` |
| `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts` | the three list queries, create, update, soft delete |
| `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts` | integration tests against a real database |
| `apps/api/src/application/use-cases/post-views.ts` | `PostView`, `toPostView`, `toFeedPage` — pure mappers |
| `apps/api/src/application/use-cases/post-views.test.ts` | mapper unit tests incl. the key set |
| `apps/api/src/application/use-cases/write-post.ts` | `CreatePost`, `EditPost`, `DeletePost` |
| `apps/api/src/application/use-cases/write-post.test.ts` | |
| `apps/api/src/application/use-cases/read-posts.ts` | `ListFeed`, `ListUserPosts` |
| `apps/api/src/application/use-cases/read-posts.test.ts` | |
| `apps/api/src/routes/posts.ts` | the five routes, mounted at `/users` |
| `apps/api/src/routes/posts.test.ts` | route-level tests incl. the auth split |
| `apps/web/src/user/relativeTime.ts` | `formatRelativeTime(iso, now)` — Bahasa, injected clock |
| `apps/web/src/user/relativeTime.test.ts` | every boundary |
| `apps/web/src/user/PostCard.tsx` | one post, plus the own-post menu |
| `apps/web/src/user/PostCard.test.tsx` | |
| `apps/web/src/user/PostComposer.tsx` | the inline box, reused by edit |
| `apps/web/src/user/PostComposer.test.tsx` | |
| `apps/web/src/user/PostFeed.tsx` | a paginated list of `PostCard` + `Muat lebih banyak` |
| `apps/web/src/user/PostFeed.test.tsx` | |

**Modified:**

| File | Change |
|---|---|
| `apps/api/src/application/errors.ts` | `ForbiddenError`, the first 403 in this codebase |
| `apps/api/src/db/schema.ts` | the `posts` table |
| `apps/api/drizzle/` | one generated migration + `meta/` |
| `apps/api/src/db/test-helpers.ts` | `posts` added to the truncate order |
| `apps/api/src/bootstrap.ts` | five new dependencies |
| `apps/api/src/app.ts` | `app.route("/users", postRoutes(deps))` |
| `packages/shared/src/auth.schema.ts` | `MAX_POST_BODY_LENGTH` only — the page sizes stay in `apps/api`, see Task 2 Step 1 |
| `apps/web/src/user/apiClient.ts` | `PostView`, `FeedPage`, five endpoint functions, `repairSplitSession`, `SessionUser` loses `id` |
| `apps/web/src/user/BerandaPage.tsx` | the real two-tab feed |
| `apps/web/src/user/ProfilePage.tsx` | that person's posts |
| `apps/web/src/App.tsx` | call `repairSplitSession()` once at the root |
| `apps/web/src/styles.css` | additive only |

---

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

## Task 2: Use cases, shared limits, and the API routes

**Files:**
- Modify: `packages/shared/src/auth.schema.ts`
- Create: `apps/api/src/application/use-cases/post-views.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/write-post.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/read-posts.ts` + `.test.ts`
- Create: `apps/api/src/routes/posts.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `PostRepositoryPort`, `PostRow`, `PostOwnership` from Task 1; `UserRepositoryPort` (for handle → user); `encodeKeysetCursor`, `decodeKeysetCursor` from `../../domain/keyset-cursor`; `NotFoundError`, `ForbiddenError`, `ValidationError` from `../errors` (Step 0 adds `ForbiddenError`); `requireUserAuth`, `resolveViewerId` from `../http/user-auth.middleware`; `validate` middleware.
- Produces: `PostView`, `toPostView`, `toFeedPage`, `FeedPage`, `CreatePost`, `EditPost`, `DeletePost`, `ListFeed`, `ListUserPosts`, `postRoutes`.

- [ ] **Step 0: Add `ForbiddenError`**

`apps/api/src/application/errors.ts` has **no 403 class** — verified: it exports `ValidationError`
(400), `UnauthorizedError` (401), `NotFoundError` (404), `ConflictError` (409) and others, and
nothing maps to 403. Add one, matching the existing classes exactly:

```ts
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(message, 403);
  }
}
```

`errorHandler` already turns any `AppError` into `{ error: message }` with `err.status`, so no
handler change is needed. **Pin it**: a test asserting `new ForbiddenError().status === 403`, because
a 403 arriving as a 409 is exactly the kind of silent mis-mapping this project has paid for.

- [ ] **Step 1: Add the shared constant**

In `packages/shared/src/auth.schema.ts`, after `DEFAULT_FOLLOW_LIST_LIMIT` (line 82), following the
docstring style of the two constants above it. **Only `MAX_POST_BODY_LENGTH` goes here** — see the
note after the code block.

```ts
/**
 * Longest post body — **the ONE definition**, imported by the server that
 * refuses a longer one and by the client that must never send one.
 *
 * Same defect class as `MAX_EXPLORE_QUERY_LENGTH` above, which reached
 * production: a limit known only to the server put a raw English Zod message on
 * the screen. The composer's counter, its `maxLength`, and the route's validator
 * all read this.
 *
 * Tests on both sides assert the LITERAL `1000`; see `MAX_EXPLORE_QUERY_LENGTH`
 * for why never the constant.
 */
export const MAX_POST_BODY_LENGTH = 1000;
```

**The two page-size numbers stay in `apps/api`, not in `packages/shared`.** Declare them at the top
of `apps/api/src/routes/posts.ts`:

```ts
const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;
```

`packages/shared` exists for a number **both sides read**, and the client reads neither of these: the
feed's paging is driven entirely by the opaque `nextCursor` the server hands back, so `apps/web` never
sends a `limit` and never needs to know the page size. A constant exported to a workspace that does
not import it is the shape of the `PAYMENT_GATEWAY_PROVIDER` flag this project already deleted once —
config for a decision nobody is making. If a later phase gives the client a reason to know the page
size, move it then, with the reason recorded.

`MAX_POST_BODY_LENGTH` is different, and is the one that belongs there: the composer's counter, its
`maxLength` attribute and the route's validator all read it, so a single edit must redden both
workspaces. That mutation is Task 2 Step 10 #3.

- [ ] **Step 2: Write the failing mapper test**

Create `apps/api/src/application/use-cases/post-views.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { PostRow } from "../ports/post-repository.port";
import { toFeedPage, toPostView } from "./post-views";

const row: PostRow = {
  id: "aaaaaaaa-0000-4000-8000-000000000000",
  body: "halo",
  createdAt: new Date("2026-08-18T03:00:00.000Z"),
  editedAt: null,
  authorHandle: "budi",
  authorDisplayName: "Budi",
};

describe("toPostView", () => {
  it("returns EXACTLY the wire keys, with the author nested", () => {
    const view = toPostView(row);

    expect(Object.keys(view).sort()).toEqual(["author", "body", "createdAt", "editedAt", "id"]);
    expect(Object.keys(view.author).sort()).toEqual(["displayName", "handle"]);
  });

  it("keeps editedAt as an explicit null so the key set never varies", () => {
    expect("editedAt" in toPostView(row)).toBe(true);
    expect(toPostView(row).editedAt === null).toBe(true);
  });

  it("serialises timestamps as ISO strings", () => {
    expect(toPostView(row).createdAt).toBe("2026-08-18T03:00:00.000Z");
  });
});

describe("toFeedPage", () => {
  it("returns a null nextCursor when the page is not full", () => {
    const page = toFeedPage([row], 20);

    expect(page.posts).toHaveLength(1);
    expect(page.nextCursor === null).toBe(true);
  });

  it("drops the probe row and points nextCursor at the LAST KEPT row", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const third: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "tiga" };

    const page = toFeedPage([row, second, third], 2);

    expect(page.posts.map((post) => post.body)).toEqual(["halo", "dua"]);
    expect(page.nextCursor).toBe("2026-08-18T03:00:00.000Z|bbbbbbbb-0000-4000-8000-000000000000");
  });
});
```

- [ ] **Step 3: Run it and watch it fail, then write the mappers**

Create `apps/api/src/application/use-cases/post-views.ts`:

```ts
import { encodeKeysetCursor } from "../../domain/keyset-cursor";
import type { PostRow } from "../ports/post-repository.port";

/**
 * A post as the wire sees it. The nesting happens HERE and nowhere else, so
 * "what a post looks like to a client" has one definition.
 */
export interface PostView {
  id: string;
  body: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null on an unedited post — explicitly null, never absent, so the key set is stable. */
  editedAt: string | null;
  author: { handle: string; displayName: string };
}

export interface FeedPage {
  posts: PostView[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

export function toPostView(row: PostRow): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
  };
}

/**
 * Turns `limit + 1` rows into a page of at most `limit`.
 *
 * THE PROBE ROW IS WHY: asking for one more than we intend to return is the only
 * way `nextCursor === null` can mean "there is nothing after this" rather than
 * "this page happened to come back full". Without it, every exhausted feed shows
 * a "Muat lebih banyak" button that fetches an empty page.
 */
export function toFeedPage(rows: PostRow[], limit: number): FeedPage {
  const kept = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = kept[kept.length - 1];
  return {
    posts: kept.map(toPostView),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null,
  };
}
```

- [ ] **Step 4: Write the failing write-path tests**

Create `apps/api/src/application/use-cases/write-post.test.ts`. Use a hand-written in-memory fake of
`PostRepositoryPort` — this project does not use a mocking framework for ports.

```ts
import { describe, expect, it } from "bun:test";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../ports/post-repository.port";
import { CreatePost, DeletePost, EditPost } from "./write-post";

function fakeRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

class FakePosts implements PostRepositoryPort {
  ownership: PostOwnership | null = null;
  updated: { id: string; body: string } | null = null;
  deleted: string[] = [];
  updateResult: PostRow | null = fakeRow();

  async create(_authorId: string, body: string): Promise<PostRow> {
    return fakeRow({ body });
  }
  async ownershipOf(): Promise<PostOwnership | null> {
    return this.ownership;
  }
  async updateBody(id: string, body: string): Promise<PostRow | null> {
    this.updated = { id, body };
    return this.updateResult;
  }
  async softDelete(id: string): Promise<void> {
    this.deleted.push(id);
  }
  async listGlobal(): Promise<PostRow[]> {
    return [];
  }
  async listFollowing(): Promise<PostRow[]> {
    return [];
  }
  async listByAuthor(): Promise<PostRow[]> {
    return [];
  }
}

const AUTHOR = "11111111-0000-4000-8000-000000000000";
const SOMEONE_ELSE = "22222222-0000-4000-8000-000000000000";

describe("CreatePost", () => {
  it("refuses an empty body", async () => {
    const posts = new FakePosts();
    await expect(new CreatePost(posts).execute({ authorId: AUTHOR, body: "" })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("refuses a body that is only whitespace", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "   \n\t  " })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body over the limit — asserted against the LITERAL 1000", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1001) })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1000) })
    ).resolves.toBeDefined();
  });

  it("trims the body before storing it", async () => {
    const posts = new FakePosts();
    const view = await new CreatePost(posts).execute({ authorId: AUTHOR, body: "  halo  " });
    expect(view.body).toBe("halo");
  });
});

describe("EditPost", () => {
  it("404s an id that never existed", async () => {
    const posts = new FakePosts();
    posts.ownership = null;
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "x", body: "baru" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("403s someone else's post — and does NOT write", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: SOMEONE_ELSE, isDeleted: false };
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "p", body: "baru" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.updated === null).toBe(true);
  });

  it("404s a deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: AUTHOR, isDeleted: true };
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "p", body: "baru" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DeletePost", () => {
  it("is idempotent on an already-deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: AUTHOR, isDeleted: true };
    await new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" });
    expect(posts.deleted).toEqual(["p"]);
  });

  it("403s someone else's post — and does NOT delete", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: SOMEONE_ELSE, isDeleted: false };
    await expect(
      new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.deleted).toEqual([]);
  });
});
```

`ForbiddenError` is the class Step 0 adds. A 403 must not arrive as a 409, and the route tests in
Step 7 assert the status code, not the class.

- [ ] **Step 5: Write the write-path use cases**

Create `apps/api/src/application/use-cases/write-post.ts`:

```ts
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import { toPostView, type PostView } from "./post-views";

export { MAX_POST_BODY_LENGTH };

const EMPTY_MESSAGE = "kiriman tidak boleh kosong";
const TOO_LONG_MESSAGE = `kiriman maksimal ${MAX_POST_BODY_LENGTH} karakter`;
const NOT_YOURS_MESSAGE = "kiriman ini bukan milik Anda";

/**
 * Trims, then validates. In that order deliberately: a body of three spaces is
 * empty, and validating before trimming would accept it.
 */
function requireBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError(EMPTY_MESSAGE);
  if (body.length > MAX_POST_BODY_LENGTH) throw new ValidationError(TOO_LONG_MESSAGE);
  return body;
}

export class CreatePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { authorId: string; body: string }): Promise<PostView> {
    const row = await this.posts.create(input.authorId, requireBody(input.body));
    return toPostView(row);
  }
}

export class EditPost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { editorId: string; postId: string; body: string }): Promise<PostView> {
    const body = requireBody(input.body);
    // Ownership BEFORE the write, and a 403 that does not reveal the body:
    // returning 404 for someone else's post would make the id an existence
    // oracle, and 403 on a post you cannot see reveals nothing you could not
    // learn from the feed, where every post is public in this phase.
    const owned = await this.requireOwn(input.postId, input.editorId);
    if (owned.isDeleted) throw new NotFoundError("post not found");
    const row = await this.posts.updateBody(input.postId, body);
    if (row === null) throw new NotFoundError("post not found");
    return toPostView(row);
  }

  private async requireOwn(postId: string, actorId: string) {
    const owned = await this.posts.ownershipOf(postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== actorId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    return owned;
  }
}

export class DeletePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * Idempotent: deleting an already-deleted post returns normally. A button that
   * errors when the state already matches what you asked for is worse than one
   * that agrees — the same ruling follow/unfollow made.
   */
  async execute(input: { deleterId: string; postId: string }): Promise<void> {
    const owned = await this.posts.ownershipOf(input.postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== input.deleterId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    await this.posts.softDelete(input.postId);
  }
}
```

Note `EditPost` has a private `requireOwn` and `DeletePost` repeats the two checks inline. That is
deliberate: `EditPost` needs the returned `owned` to test `isDeleted`, `DeletePost` does not.
If you prefer one shared helper function at module scope, that is fine — do not create a base class.

- [ ] **Step 6: Write the read use cases and their tests**

Create `apps/api/src/application/use-cases/read-posts.ts`:

```ts
import { NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import { normalizeHandle } from "../../domain/handle";
import { toFeedPage, type FeedPage } from "./post-views";

/**
 * The fallback when a caller passes no limit. `routes/posts.ts` always passes one,
 * so this only guards a direct call from a test or a future caller.
 */
const DEFAULT_FEED_PAGE_SIZE = 20;

export type FeedTab = "untuk-anda" | "mengikuti";

export class ListFeed {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * `viewerId` is REQUIRED for `mengikuti` and unused for `untuk-anda`. The route
   * is what enforces the 401, not this class — see `routes/posts.ts` for why the
   * two tabs differ in auth at all (`/beranda` is a publicly reachable page).
   */
  async execute(input: {
    tab: FeedTab;
    viewerId: string | null;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    if (input.tab === "mengikuti") {
      if (input.viewerId === null) {
        throw new Error("ListFeed: mengikuti requires a viewer; the route must reject first");
      }
      const rows = await this.posts.listFollowing(input.viewerId, limit + 1, input.before);
      return toFeedPage(rows, limit);
    }
    const rows = await this.posts.listGlobal(limit + 1, input.before);
    return toFeedPage(rows, limit);
  }
}

export class ListUserPosts {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly posts: PostRepositoryPort
  ) {}

  async execute(input: {
    handle: string;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const user = await this.users.findByHandle(normalizeHandle(input.handle));
    if (!user) throw new NotFoundError("user not found");
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    const rows = await this.posts.listByAuthor(user.id, limit + 1, input.before);
    return toFeedPage(rows, limit);
  }
}
```

**Check `normalizeHandle`'s import path** — `follow-user.ts` imports it; copy that import line
verbatim rather than guessing. Same for `UserRepositoryPort`'s path and `findByHandle`'s exact name.

Write `read-posts.test.ts` covering: `untuk-anda` calls `listGlobal` with `limit + 1`; `mengikuti`
calls `listFollowing`; an unknown handle throws `NotFoundError`; and the `limit + 1` is asserted as
the literal `21` when no limit is given.

- [ ] **Step 7: Write the failing route tests**

Create `apps/api/src/routes/posts.test.ts`. Copy how `users.test.ts` builds an app and issues
requests — read it first and match it exactly. Cover at minimum:

```
- POST /users/posts with no Authorization        -> 401
- POST /users/posts with a session               -> 201, body keys are exactly
                                                    ["author","body","createdAt","editedAt","id"]
- POST /users/posts with body ""                 -> 400
- POST /users/posts with 1001 chars              -> 400   (LITERAL 1001)
- GET  /users/feed?tab=untuk-anda  NO header     -> 200    <- §5.1, the whole reason the split exists
- GET  /users/feed?tab=mengikuti   NO header     -> 401    <- §5.1
- GET  /users/feed?tab=mengikuti   with header   -> 200
- GET  /users/feed?tab=nonsense                  -> 400
- GET  /users/feed?before=garbage                -> 400, NOT a silent restart at page 1
- GET  /users/feed?limit=999                     -> 400 or clamped to 50; assert which, LITERAL 50
- GET  /users/budi/posts           NO header     -> 200, author-scoped
- GET  /users/tidak-ada/posts                    -> 404
- PATCH /users/posts/:id  by the author          -> 200, editedAt non-null
- PATCH /users/posts/:id  by another user        -> 403
- DELETE /users/posts/:id by another user        -> 403
- DELETE /users/posts/:id twice by the author    -> 200 both times
- a deleted post is absent from GET /users/feed?tab=untuk-anda AND from GET /users/:handle/posts
```

- [ ] **Step 8: Write the router**

Create `apps/api/src/routes/posts.ts`. Mirror `routes/users.ts`: a Hono app with
`UserAuthVariables`, `requireAuth` applied **per route** (never `app.use("*")`), `validate()` for
bodies, a hand-rolled Zod parse for query params.

```ts
import { Hono } from "hono";
import { z } from "zod";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { decodeKeysetCursor, type KeysetCursor } from "../domain/keyset-cursor";
import { validate } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";
import type { FeedTab } from "../application/use-cases/read-posts";

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;

const postBodySchema = z.object({
  body: z.string().min(1).max(MAX_POST_BODY_LENGTH),
});

const feedQuerySchema = z.object({
  tab: z.enum(["untuk-anda", "mengikuti"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FEED_PAGE_SIZE).optional(),
});

function parseFeedQuery(rawTab: string | undefined, rawLimit: string | undefined) {
  const parsed = feedQuerySchema.safeParse({
    ...(rawTab === undefined || rawTab === "" ? {} : { tab: rawTab }),
    ...(rawLimit === undefined || rawLimit === "" ? {} : { limit: rawLimit }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `permintaan tidak valid: tab harus untuk-anda atau mengikuti, dan limit 1-${MAX_FEED_PAGE_SIZE}`
    );
  }
  return {
    tab: (parsed.data.tab ?? "untuk-anda") as FeedTab,
    limit: parsed.data.limit ?? DEFAULT_FEED_PAGE_SIZE,
  };
}

/**
 * A malformed `?before=` is a 400, never "no cursor". Treating it as absent
 * restarts the list at page 1, so a "Muat lebih banyak" button with a corrupt
 * cursor loops for ever showing the same rows — see `keyset-cursor.ts`.
 */
function parseBefore(raw: string | undefined): KeysetCursor | null {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeKeysetCursor(raw);
  if (cursor === null) throw new ValidationError("penanda halaman tidak valid");
  return cursor;
}

export function postRoutes(deps: Dependencies) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/posts", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.createPost.execute({ authorId: c.get("userId"), body: input.body });
    return c.json(view, 201);
  });

  app.patch<"/posts/:id">("/posts/:id", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.editPost.execute({
      editorId: c.get("userId"),
      postId: c.req.param("id"),
      body: input.body,
    });
    return c.json(view);
  });

  app.delete<"/posts/:id">("/posts/:id", requireAuth, async (c) => {
    await deps.deletePost.execute({ deleterId: c.get("userId"), postId: c.req.param("id") });
    return c.json({ deleted: true });
  });

  // §5.1: `untuk-anda` is PUBLIC and `mengikuti` requires a session. `/beranda`
  // is a publicly reachable page, so an auth-only feed endpoint would break a
  // page a signed-out visitor can open — the cross-layer shape this project
  // keeps finding. Hence `resolveViewerId` (which degrades to null) plus an
  // explicit 401 for the one tab that cannot work without a viewer.
  app.get("/feed", async (c) => {
    const { tab, limit } = parseFeedQuery(c.req.query("tab"), c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    if (tab === "mengikuti" && viewerId === null) {
      return c.json({ error: "masuk untuk melihat kiriman yang Anda ikuti" }, 401);
    }
    const page = await deps.listFeed.execute({ tab, viewerId, limit, before });
    return c.json(page);
  });

  app.get<"/:handle/posts">("/:handle/posts", async (c) => {
    const { limit } = parseFeedQuery(undefined, c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const page = await deps.listUserPosts.execute({
      handle: c.req.param("handle"),
      limit,
      before,
    });
    return c.json(page);
  });

  return app;
}
```

- [ ] **Step 9: Wire it up**

In `apps/api/src/bootstrap.ts`, construct `DrizzlePostRepository` and the five use cases and add them
to `Dependencies` — follow exactly how `followUser` / `listFollows` were added.

In `apps/api/src/app.ts`, beside the existing `app.route("/users", userRoutes(deps));`:

```ts
app.route("/users", postRoutes(deps));
```

**Two routers on one prefix is intentional** — it keeps `routes/users.ts` from growing again. Verify
by test that `GET /users/budi/posts` and `GET /users/budi/followers` BOTH still resolve; if
registration order shadows one, mount `postRoutes` first and pin the order with a test.

- [ ] **Step 10: Run the suite, then prove three things by mutation**

1. Change `parseBefore` to `return null` instead of throwing on a bad cursor → a test must go red.
2. Delete the `tab === "mengikuti" && viewerId === null` guard → a test must go red.
3. Change `MAX_POST_BODY_LENGTH` in `packages/shared` from `1000` to `999` → **tests in BOTH
   `apps/api` and `apps/web` must go red** (web will only have them after Task 5; note that and
   re-run this mutation at Task 5's end).

Restore each. Paste all outputs.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(posts): use cases, shared limits, and the API routes"
```

---

## Task 3: The relative-time formatter and `PostCard`

**Files:**
- Create: `apps/web/src/user/relativeTime.ts` + `relativeTime.test.ts`
- Create: `apps/web/src/user/PostCard.tsx` + `PostCard.test.tsx`
- Modify: `apps/web/src/styles.css` (additive only)

**Interfaces:**
- Consumes: nothing from earlier tasks except the `PostView` shape, which Task 5 adds to `apiClient`. **Declare `PostView` in `apiClient.ts` as part of THIS task** so `PostCard` can import it: `export interface PostView { id: string; body: string; createdAt: string; editedAt: string | null; author: { handle: string; displayName: string } }`.
- Produces: `formatRelativeTime(iso: string, now: Date): string`; `PostCard` with props `{ post: PostView; isOwn: boolean; now?: Date; onEdit?: (post: PostView) => void; onDeleted?: (id: string) => void }`. **`onDeleted` takes the id, not the post** — the row is gone, and the caller only needs to know which one.

**There is no relative-time formatter anywhere in this repo** — searched for `timeAgo`,
`formatRelative`, `Intl.RelativeTimeFormat`, `dayjs`, `date-fns`; nothing. You are writing the first
one. Every existing screen leaves timestamps as raw ISO strings.

- [ ] **Step 1: Write the failing formatter test**

Create `apps/web/src/user/relativeTime.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "./relativeTime";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it('reads "baru saja" under a minute', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("baru saja");
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe("baru saja");
  });

  it("switches to minutes at exactly one minute", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1m");
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe("59m");
  });

  it("switches to hours at exactly one hour", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1j");
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe("23j");
  });

  it("switches to days at exactly one day", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("1h");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6h");
  });

  it("switches to an absolute Indonesian date at seven days", () => {
    expect(formatRelativeTime(ago(7 * DAY), NOW)).toBe("11 Agu 2026");
  });

  it('treats a future timestamp as "baru saja" rather than negative', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe("baru saja");
  });

  it("returns an empty string for an unparseable value rather than NaN", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write the formatter**

Create `apps/web/src/user/relativeTime.ts`:

```ts
/**
 * "2j", "3h", "11 Agu 2026" — Bahasa Indonesia, from an ISO string.
 *
 * `now` IS A PARAMETER, not `Date.now()`. This project has a family of a dozen
 * flakes that are all a clock read on one side compared against a clock read on
 * the other, and they fire under CPU contention. A formatter that reads the
 * clock itself cannot be tested at a boundary at all.
 *
 * MONTH NAMES ARE A LITERAL ARRAY, not `Intl.DateTimeFormat("id-ID")`. A Bun or
 * Node build without full ICU silently falls back to English, which would make
 * this pass locally and print "Aug" in production.
 */
const MONTHS_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const at = then.getTime();
  if (Number.isNaN(at)) return "";

  const elapsed = now.getTime() - at;
  // A clock ahead of the server's is a skew, not a post from the future.
  if (elapsed < MINUTE) return "baru saja";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}j`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}h`;

  return `${then.getUTCDate()} ${MONTHS_ID[then.getUTCMonth()]} ${then.getUTCFullYear()}`;
}
```

- [ ] **Step 3: Write the failing `PostCard` test**

Create `apps/web/src/user/PostCard.test.tsx`. Follow `FollowButton.test.tsx`'s idiom:
`@testing-library/react`, `MemoryRouter`, `afterEach(cleanup)`, and **no module mocking**.

Cover:
- the display name, `@handle` and body all render
- the handle links to `/@handle`
- `· diedit` is **absent** when `editedAt` is null and **present** when it is set
- `isOwn: false` renders **no** `Edit` and no `Hapus` control
- `isOwn: true` renders both, and clicking each calls the matching callback with the post
- the relative time renders (pass a fixed `now` prop, or inject the clock — your choice, but it must
  be injectable; a card that reads `Date.now()` cannot be tested at a boundary)
- **no follow button is rendered at all**, and `PostCard`'s props contain no `viewerFollows` — assert
  this by scanning the source file for the string `viewerFollows`, the way
  `FollowButton.test.tsx` scans source. Phase 2's carry-forward names this card as exactly where
  `viewerFollows` gets guessed again as `signedIn ? false : null`.

- [ ] **Step 4: Write `PostCard`**

Keep it under 90 lines. Body text must preserve line breaks (`white-space: pre-wrap` in
`styles.css`) and must **never** be rendered with `dangerouslySetInnerHTML`. Add only additive CSS.

- [ ] **Step 5: Run the suite, then prove the card by mutation**

- Remove the `editedAt !== null` condition so `diedit` always renders → red.
- Remove the `isOwn` condition on the menu → red.
- Change `formatRelativeTime`'s `WEEK` boundary to `6 * DAY` → red.

Restore each; paste the outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): relative time in Bahasa, and PostCard"
```

---

## Task 4: `PostFeed` — a paginated list with "Muat lebih banyak"

**Files:**
- Modify: `apps/web/src/user/apiClient.ts`
- Create: `apps/web/src/user/PostFeed.tsx` + `PostFeed.test.tsx`

**Interfaces:**
- Consumes: `PostCard` and `PostView` from Task 3.
- Produces: `FeedPage`; `listFeed(tab, before?)`, `listUserPosts(handle, before?)`, `createPost(body)`, `editPost(id, body)`, `deletePost(id)`; `PostFeed` with props `{ load: (before: string | null) => Promise<FeedPage>; emptyMessage: string; ownHandle: string | null; onEdit?: (post: PostView) => void; onDeleted?: (id: string) => void }`.

- [ ] **Step 1: Add the client functions**

In `apiClient.ts`, beside `listFollowers`:

```ts
export interface FeedPage {
  posts: PostView[];
  nextCursor: string | null;
}

/**
 * `untuk-anda` is PUBLIC, `mengikuti` is not — hence two different helpers for
 * one endpoint.
 *
 * `publicGet` sends the viewer's token when there is one and never clears the
 * session on a 401; `apiFetch` does clear it. `mengikuti` genuinely requires a
 * live session, so a 401 there means the token is dead and clearing it is right.
 * `untuk-anda` must keep working with no session at all, because `/beranda` is a
 * publicly reachable page.
 */
export function listFeed(tab: "untuk-anda" | "mengikuti", before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams({ tab });
  if (before !== undefined && before !== null) params.set("before", before);
  const path = `/users/feed?${params.toString()}`;
  return tab === "mengikuti"
    ? apiFetch<FeedPage>(path)
    : publicGet<FeedPage>(path, "gagal memuat kiriman");
}

export function listUserPosts(handle: string, before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams();
  if (before !== undefined && before !== null) params.set("before", before);
  const search = params.toString();
  return publicGet<FeedPage>(
    `/users/${encodeURIComponent(handle)}/posts${search === "" ? "" : `?${search}`}`,
    "gagal memuat kiriman"
  );
}

export function createPost(body: string): Promise<PostView> {
  return apiFetch<PostView>("/users/posts", { method: "POST", body: JSON.stringify({ body }) });
}

export function editPost(id: string, body: string): Promise<PostView> {
  return apiFetch<PostView>(`/users/posts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export function deletePost(id: string): Promise<void> {
  return apiFetch<void>(`/users/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Pin the auth split in `apiClient.test.ts`**

Two tests, both asserting on the captured `fetch` call:

```ts
it("listFeed('untuk-anda') sends no Authorization when there is no session, and still resolves", async () => {
  // no setUserSession
  // assert: init.headers has no Authorization, and the promise resolves
});

it("listFeed('mengikuti') sends the viewer's Bearer token", async () => {
  setUserSession("jwt-abc", USER);
  // assert: Authorization === "Bearer jwt-abc"
});

it("listFeed('untuk-anda') sends the token when there IS a session", async () => {
  // publicGet attaches it; this is the header whose absence made the follow
  // button unreachable for every signed-in user in Phase 2.
});
```

- [ ] **Step 3: Write the failing `PostFeed` test**

Cover, with `global.fetch` replaced:
- an empty first page renders `emptyMessage` and **no** "Muat lebih banyak" button
- a page with `nextCursor` renders the button; clicking it appends and passes `before=<cursor>`
- when the second page returns `nextCursor: null` the button disappears
- **a failed "load more" keeps the posts already on screen** and shows Bahasa copy — the exact
  regression the final review of Phase 2 made a merge blocker
- the error text comes from `describeRequestFailure`, never the server's string (the
  `no-raw-server-errors` scan enforces this; make sure it actually covers your new file)
- clicking "Muat lebih banyak" twice quickly does not fire two requests

- [ ] **Step 4: Write `PostFeed`**

The state shape is the whole point, so here it is explicitly. `posts`, `nextCursor`, `loading` and
`error` are **four separate pieces of state, never one discriminated union** — a union forces an error
to replace the list, which is the regression the final review of Phase 2 made a merge blocker.

```tsx
import { useCallback, useEffect, useState } from "react";
import PostCard from "./PostCard";
import { describeRequestFailure } from "./errorCopy";
import type { FeedPage, PostView } from "./apiClient";

interface Props {
  /** `null` means "the first page". Identity matters: a changed `load` refetches from the top. */
  load: (before: string | null) => Promise<FeedPage>;
  emptyMessage: string;
  /** The signed-in viewer's handle, or `null` when signed out. Decides which rows get a menu. */
  ownHandle: string | null;
  onEdit?: (post: PostView) => void;
  onDeleted?: (id: string) => void;
}

export default function PostFeed({ load, emptyMessage, ownHandle, onEdit, onDeleted }: Props) {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held SEPARATELY from `posts`. A failed "load more" must leave what already
  // loaded on screen — Jelajah's two rails follow the same rule for the same
  // reason, and the final review of Phase 2 measured the alternative.
  const [error, setError] = useState<string | null>(null);
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);

  const fetchPage = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await load(before);
        setPosts((current) => (before === null ? page.posts : [...current, ...page.posts]));
        setNextCursor(page.nextCursor);
        setFirstPageLoaded(true);
      } catch (err: unknown) {
        setError(describeRequestFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [load]
  );

  useEffect(() => {
    setPosts([]);
    setNextCursor(null);
    setFirstPageLoaded(false);
    void fetchPage(null);
  }, [fetchPage]);

  return (
    <div className="post-feed">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          isOwn={ownHandle !== null && post.author.handle === ownHandle}
          onEdit={onEdit}
          onDeleted={onDeleted}
        />
      ))}

      {firstPageLoaded && posts.length === 0 && !loading ? (
        <p className="empty">{emptyMessage}</p>
      ) : null}

      {error !== null ? <p className="feed-error">{error}</p> : null}

      {nextCursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
          {loading ? "Memuat..." : "Muat lebih banyak"}
        </button>
      ) : null}
    </div>
  );
}
```

**`load` must be memoised by the caller** (`useCallback`), or the `useEffect` refetches on every
render. Beranda's two tabs rely on that identity change to reload when the tab changes — one place
where a missing `useCallback` is a hang, not a slowdown, so pin it: a test that renders, waits, and
asserts exactly one request.

`disabled={loading}` is what makes a double-tap one request. Do not also add a ref guard; one
mechanism, tested.

- [ ] **Step 5: Run the suite, then prove it by mutation**

- Make the error branch replace `posts` with `[]` → the "keeps posts on screen" test must go red.
- Render the button unconditionally → red.
- Drop `before` from the second request → red.

Restore; paste outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): PostFeed with keyset pagination"
```

---

## Task 5: Beranda's two tabs, and composing, editing and deleting

**Files:**
- Create: `apps/web/src/user/PostComposer.tsx` + `PostComposer.test.tsx`
- Modify: `apps/web/src/user/BerandaPage.tsx` (currently an 18-line placeholder) + its test
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `PostFeed`, `listFeed`, `createPost`, `editPost`, `deletePost`, `MAX_POST_BODY_LENGTH` from `@diudara/shared`.
- Produces: `PostComposer` with props `{ initialBody?: string; submitLabel: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void }`.

- [ ] **Step 1: Write the failing composer test**

Cover:
- `Kirim` is disabled when empty, when whitespace-only, and when over the limit
- the counter shows `0/1000` initially — **assert the LITERAL 1000**, never the constant
- `maxLength` on the textarea equals the literal `1000`
- a successful submit clears the box
- **a failed submit keeps the text** and shows Bahasa copy — losing what someone typed is the worst
  available outcome
- while in flight the button is disabled and a second click fires nothing

- [ ] **Step 2: Write `PostComposer`**

Placeholder `Apa yang terjadi?`. Both the `maxLength` attribute and a `.slice(0, MAX_POST_BODY_LENGTH)`
in `onChange` — belt and braces, exactly as `JelajahPage` bounds `?q=`.

- [ ] **Step 3: Write the failing Beranda test**

Cover:
- `Untuk Anda` is the default tab and `Mengikuti` is the other
- the tab lives in the URL (`?tab=mengikuti`), so back/forward work and a link is shareable
- **signed out, `Mengikuti` shows `Masuk untuk melihat` with a link to `/masuk` and fires NO
  request** — mirroring how the profile's follow button behaves
- signed out, `Untuk Anda` still loads and renders posts
- the composer is **absent** when signed out
- a new post prepends to the visible list without a refetch
- `Hapus` on your own post asks for confirmation, and on confirm removes the row
- `Edit` opens the composer pre-filled, and saving updates the row in place and shows `diedit`

- [ ] **Step 4: Rewrite `BerandaPage`**

Replace the placeholder. Keep the `Jelajah` link in the empty state — it is the only answer to an
empty follow graph, and Mengikuti's empty state is exactly where someone needs it.

The tab and the signed-out branch are the two things worth writing out:

```tsx
import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PostFeed from "./PostFeed";
import PostCard from "./PostCard";
import PostComposer from "./PostComposer";
import { createPost, isUserSignedIn, getSessionUser, listFeed } from "./apiClient";
import type { PostView } from "./apiClient";

type Tab = "untuk-anda" | "mengikuti";

export default function BerandaPage() {
  // The tab lives in the URL, not in component state: back and forward then work,
  // and a link to Mengikuti is shareable. `?tab=` absent means Untuk Anda, so the
  // bare `/beranda` is the default rather than a redirect.
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "mengikuti" ? "mengikuti" : "untuk-anda";
  const signedIn = isUserSignedIn();
  const ownHandle = getSessionUser()?.handle ?? null;
  const [prepended, setPrepended] = useState<PostView[]>([]);

  // Memoised on `tab` so PostFeed refetches when the tab changes and NOT on every
  // render. See PostFeed's note: without this the effect loops.
  const load = useCallback((before: string | null) => listFeed(tab, before), [tab]);

  return (
    <main className="user-page">
      <h1>Beranda</h1>

      <nav className="feed-tabs" aria-label="Jenis beranda">
        <button
          type="button"
          aria-current={tab === "untuk-anda"}
          onClick={() => setParams({})}
        >
          Untuk Anda
        </button>
        <button
          type="button"
          aria-current={tab === "mengikuti"}
          onClick={() => setParams({ tab: "mengikuti" })}
        >
          Mengikuti
        </button>
      </nav>

      {signedIn ? (
        <PostComposer
          submitLabel="Kirim"
          onSubmit={async (body) => {
            const created = await createPost(body);
            setPrepended((current) => [created, ...current]);
          }}
        />
      ) : null}

      {prepended.map((post) => (
        <PostCard key={post.id} post={post} isOwn={true} />
      ))}

      {/* Mengikuti needs a viewer the server can resolve, so signed out it says so
          rather than firing a request that can only 401 — the same choice the
          profile's follow button makes with "Masuk untuk mengikuti". */}
      {tab === "mengikuti" && !signedIn ? (
        <p className="signed-out-notice">
          <Link to="/masuk">Masuk untuk melihat</Link>
        </p>
      ) : (
        <PostFeed
          load={load}
          ownHandle={ownHandle}
          emptyMessage={
            tab === "mengikuti"
              ? "Belum ada kiriman dari orang yang Anda ikuti."
              : "Belum ada kiriman untuk ditampilkan."
          }
        />
      )}

      <p>
        Temukan orang untuk diikuti di <Link to="/jelajah">Jelajah</Link>.
      </p>
    </main>
  );
}
```

The `prepended` list above is the simplest correct way to show a just-created post without a
refetch, but it means a new post appears **twice** after a tab switch that refetches. Either clear
`prepended` when `tab` changes, or lift the list into `PostFeed` via an imperative handle — **pick
one and pin it with a test that posts, switches tab, switches back, and asserts the post appears
exactly once.** Do not leave both.

`onEdit` and `onDeleted` wiring is yours to complete: `PostCard` raises them, and Beranda must
update the row in place on an edit and remove it on a delete. The test list in Step 3 is what
defines "correct" here.

- [ ] **Step 5: Run the suite, then prove Beranda by mutation**

- Make the signed-out `Mengikuti` tab fetch instead of showing `Masuk untuk melihat` → red.
- Render the composer when signed out → red.
- Drop the `?tab=` URL sync and use component state → the URL test must go red.

Then **re-run Task 2's Step-10 mutation**: change `MAX_POST_BODY_LENGTH` from `1000` to `999` in
`packages/shared` and confirm tests now go red in **both** `apps/api` and `apps/web`. Restore; paste
all four outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): Beranda's two tabs, and composing, editing and deleting"
```

---

## Task 6: Posts on the profile

**Files:**
- Modify: `apps/web/src/user/ProfilePage.tsx` + its test

**Interfaces:**
- Consumes: `PostFeed`, `listUserPosts`, `getSessionUser`.

- [ ] **Step 1: Write the failing test**

Cover:
- a profile renders that person's posts below the existing header
- signed out, the posts still render — `listUserPosts` goes through `publicGet`
- an empty list renders honest Bahasa copy, not a spinner
- on **your own** profile the posts carry `Edit` and `Hapus`; on someone else's they do not
- a failed post load does **not** blank the profile header that already loaded — the same rule
  Jelajah's rails follow
- deleting from your own profile removes the row

- [ ] **Step 2: Add the feed to `ProfilePage`**

Hold the post state **separately** from the profile state, for the reason above.

- [ ] **Step 3: Prove it by mutation**

- Make a post-load failure set the profile state to an error → the "header survives" test must go red.
- Pass `isOwn` as `true` unconditionally → red.

Restore; paste outputs.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): a profile shows that person's posts"
```

---

## Task 7: Repairing the split session

**Files:**
- Modify: `apps/web/src/user/apiClient.ts` + `apiClient.test.ts`
- Modify: `apps/web/src/App.tsx` + `App.test.tsx`

**Background — read this, it is a carry-forward from Phase 2, not a new idea.** The token key and the
account key can disagree. In that state a live `Ikuti` appears on your own profile and on your own
Jelajah row; tapping it 409s. `setUserSession` is already all-or-nothing, so the storage-quota path is
closed; only a corrupt or hand-edited account blob reaches it. Phase 2's final review let it ship on
the condition that Phase 3 repair it **at the cause**.

- [ ] **Step 1: Drop `id` from `SessionUser`**

`GET /users/me` has never returned the user's id, so the blob cannot be rebuilt while `id` is
required. **`SessionUser.id` is read nowhere** — verify that yourself with
`grep -rn "\.id" apps/web/src/user | grep -i session` plus a read of `FollowButton.tsx:99` and
`JelajahPage.tsx` — every consumer uses `handle` or `displayName`. Remove the field from the
interface, from `getSessionUser`'s validation, and from the login/signup call sites that pass it.

An already-stored blob still parses, because an extra key is ignored. Pin that with a test that
writes a blob **containing** `id` and asserts `getSessionUser()` still returns.

- [ ] **Step 2: Write the failing repair test**

```ts
it("rebuilds the account blob when a token is present and the account is missing", async () => {
  // arrange: write ONLY the token key, no account key
  // arrange: fetch returns the /users/me shape
  // act: await repairSplitSession()
  // assert: getSessionUser() is non-null, handle matches, and fetch was called with /users/me
});

it("does nothing when both keys are present", async () => {
  // assert: fetch was never called
});

it("does nothing when there is no token at all", async () => {
  // assert: fetch was never called — a signed-out visitor must not hit /users/me
});

it("leaves the user signed out when /users/me 401s", async () => {
  // apiFetch clears the token on a 401; assert isUserSignedIn() is false and it does not throw
});
```

- [ ] **Step 3: Write `repairSplitSession`**

```ts
/**
 * The token key and the account key can disagree — a corrupt or hand-edited
 * account blob leaves `isUserSignedIn()` true while `getSessionUser()` is null,
 * and in that state a live "Ikuti" renders on your own profile.
 *
 * Repaired AT THE CAUSE. Phase 2 shipped this residual and its review's condition
 * was that Phase 3 fix the cause rather than the three screens that render
 * wrongly because of it — the instance-versus-class distinction that cost this
 * project a whole extra round when two fixes each closed their own call site and
 * a guard test then found four more offenders.
 *
 * Swallows its own failure deliberately: this runs on every app start, and a
 * network blip must not stop the app rendering. A 401 inside `apiFetch` already
 * clears the dead token, which is the correct outcome.
 */
export async function repairSplitSession(): Promise<void> {
  if (!isUserSignedIn() || getSessionUser() !== null) return;
  const token = getUserToken();
  if (token === null) return;
  try {
    const me = await getOwnProfile();
    setUserSession(token, { handle: me.handle, displayName: me.displayName, email: me.email });
  } catch {
    // Nothing to do: a 401 has already cleared the token, and any other failure
    // leaves the split state to be retried on the next start.
  }
}
```

- [ ] **Step 4: Call it once, at the root**

In `apps/web/src/App.tsx`'s `App` component:

```tsx
export default function App() {
  useEffect(() => {
    void repairSplitSession();
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
```

One call site, above the router, so it covers `/@handle` and `/jelajah` alike — the two surfaces
where the bad state is visible sit on opposite sides of the shell boundary. Add a test that `App`
triggers exactly one `/users/me` request in the split state and none otherwise.

- [ ] **Step 5: Prove it by mutation**

- Invert the `getSessionUser() !== null` guard → the "does nothing when both keys are present" test
  must go red.
- Remove the `isUserSignedIn()` guard → the signed-out test must go red.
- Remove the `useEffect` from `App` → the App-level test must go red.

Restore; paste outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix(web): repair a split session at the cause"
```

---

## Task 8: The gate

Not a coding task, but fix what it surfaces. Every gate in this project has found something no unit
test could: the previous one found six pages dead in the running app because of one missing Vite
proxy entry, and the one before found a whole feature unreachable from the UI.

- [ ] **Step 1: Green suite three times**

```bash
cd /Users/bellinnn/Documents/projects/diudara && bun run test 2>&1 | tee /tmp/run1.log | grep -E "[0-9]+ (pass|fail)"
grep -cE '\(fail\)' /tmp/run1.log
bun run typecheck
```

**Capture every `(fail)` line verbatim before re-running.** A dozen flakes are on record, all
`apps/api` comparisons between a Bun-side clock and Postgres `now()`, firing under CPU contention.
That capture discipline has been broken three times on this project and each time the sighting was
lost. A failure that is not one of the recorded timestamp ones is real until proven otherwise.

- [ ] **Step 2: In a real browser, recording actual output**

Start the API and the web dev server. Then:

- Sign up a second account if you do not have two.
- From `/beranda`, post something. Confirm it appears immediately, and confirm it survives a reload.
- Post a 1000-character body; confirm it is accepted. Try 1001 in the box; confirm the UI refuses
  before any request leaves.
- Post more than 20 posts, then confirm `Muat lebih banyak` appears, loads the next page, and
  **disappears on the last page**. Confirm no post appears twice.
- With the second account, follow the first, then check `Mengikuti` shows its posts and
  `Untuk Anda` shows everyone's.
- **Sign out and open `/beranda`.** `Untuk Anda` must still load. `Mengikuti` must read
  `Masuk untuk melihat` and fire no request — check the network panel, not just the screen.
- Edit one of your posts; confirm `diedit` appears. Delete one; confirm it vanishes from Beranda
  **and** from your profile, and that reloading does not bring it back.
- Open the other account's profile; confirm its posts render and carry **no** Edit or Hapus.
- Confirm the four nav destinations still work on a **narrow** and a **wide** viewport.
- **Confirm the creator dashboard still logs in and looks untouched** — this phase was forbidden from
  restyling it.

- [ ] **Step 3: Confirm the projection over the wire**

While signed out, read the actual JSON from `GET /users/<handle>/posts` and `GET /users/feed`
(curl or the network panel) and confirm no response contains `authorId`, `deletedAt`, `email` or a
user `id`. Paste the real response.

- [ ] **Step 4: Confirm the soft delete in the database**

Delete a post from the UI, then:

```sql
select id, deleted_at is null as live from post order by created_at desc limit 5;
```

Confirm the row is still present with a non-null `deleted_at` — deletion must be soft, not a
`DELETE`.

- [ ] **Step 5: Write the report and update the ledger**

Record what you could not verify, plainly. Then stop — the whole-branch review comes next.
