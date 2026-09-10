# Community Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member can start a discussion inside a community, anyone can read it, members can reply, and the owner can post an announcement.

**Architecture:** Community posts extend the existing `post` table with a nullable `community_id` and a `type`, so the feed, the composer, `post_media`'s claim-on-create upload, soft delete and the keyset cursor are all reused rather than rebuilt. The cost of that reuse is one table feeding three surfaces; two CHECK constraints and one table-driven repository test are what hold it. Comments are a new flat table.

**Tech Stack:** Bun, Hono, Drizzle ORM, PostgreSQL, React 19 + React Router, Zod (in `packages/shared`), `bun:test` with happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-10-community-feed-design.md`

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **Post types this phase:** `diskusi` and `pengumuman`. No `kegiatan`, `materi` or `dokumen` — Phases 3 and 4.
- **CHECK 1:** `community_id IS NOT NULL OR type = 'diskusi'` — a personal post has no type.
- **CHECK 2:** `community_id IS NULL OR visibility = 'public'` — a community post must never carry the personal paywall. Both constraints carry a SQL comment saying why; CHECK 2's must state that deleting it lets a community post be gated against the author's personal tier, locking out community members and letting in non-member subscribers.
- **Feed reach:** Beranda (both tabs) and profile post tabs filter `community_id IS NULL`. A community post appears on its community page and nowhere else.
- **Permissions:** read feed/discussion/comments — anyone, signed out included. Start a `diskusi` — members. Comment — members. Post a `pengumuman` — the owner. Edit a post — its author only, never the owner. Delete a post or comment — its author, or the community's owner.
- **No comment editing this phase.** `post_comment.edited_at` exists so it needs no later migration, but nothing writes it.
- **Comment count** is of live comments (`deleted_at IS NULL`), taken per feed page in one batched query. Never stored on `post`.
- **Announcements are not pinned.** They render as a distinct card in the ordinary chronological feed.
- **Endpoint prefixes:** post and comment endpoints live under `/users` (`postRoutes` is mounted with `app.route("/users", postRoutes(deps))`). Community feed endpoints live under `/communities`.
- **`comments` must be added to `RESERVED_HANDLES`** in `apps/api/src/domain/handle.ts`.
- **Existing Beranda and profile tests keep their current expectations and stay green untouched.** A test in those files needing a change is a signal to stop and re-read the spec, not to update the test.
- **Web component tests assert by role, label and text, never by class name.**
- **Never assert on a DOM node object.** A failing `bun:test` assertion that holds a happy-dom node serialises the whole tree and exhausts memory. Compare `el.textContent`, `el.getAttribute(...)`, or an array of strings — never the element itself.
- **The migration is committed but NOT run.** The repo owner runs it. Unlike Phase 1's, it is additive and destroys nothing.
- **Nothing is pushed to `origin`.** Commit only.
- **Verification before any merge:** `bun run test` and `bun run typecheck` from the repo root, both green.

---

## File Structure

**apps/api**
- `src/db/schema.ts` — modify: two columns, two CHECKs, three index changes, `postComments` table.
- `src/db/test-helpers.ts` — modify: `postComments` added to `resetDatabase()` before `posts`.
- `src/application/ports/post-repository.port.ts` — modify: `PostRow` gains `type`; `create` gains community fields; `listByCommunity` added.
- `src/application/ports/comment-repository.port.ts` — create.
- `src/infrastructure/repositories/drizzle-post.repository.ts` — modify: the three read paths gain the `community_id IS NULL` filter; `listByCommunity` added.
- `src/infrastructure/repositories/drizzle-comment.repository.ts` — create.
- `src/application/use-cases/community-feed.ts` — create: `CreateCommunityPost`, `ListCommunityFeed`.
- `src/application/use-cases/read-posts.ts` — modify: `GetPost` added.
- `src/application/use-cases/comments.ts` — create: `ListComments`, `CreateComment`, `DeleteComment`.
- `src/application/use-cases/write-post.ts` — modify: `DeletePost` gains the community-owner rule.
- `src/application/use-cases/post-views.ts` — modify: `PostView` gains `type` and `commentCount`.
- `src/routes/communities.ts` — modify: two feed endpoints.
- `src/routes/posts.ts` — modify: `GET /posts/:id`, the two comment endpoints, `DELETE /comments/:id`.
- `src/domain/handle.ts` — modify: `comments` reserved.
- `src/bootstrap.ts` — modify: wire the new use-cases into `Dependencies`.

**packages/shared**
- `src/post.schema.ts` — create: post types, body maxima, the two write payloads.
- `src/index.ts` — modify: re-export.

**apps/web**
- `src/user/apiClient.ts` — modify: five new functions, `PostView` gains two fields.
- `src/user/PostCard.tsx` — modify: three optional props.
- `src/user/CommunityPage.tsx` — modify: tab bar, feed tab, composer.
- `src/user/CommunityFeed.tsx` — create: the Diskusi tab's body.
- `src/user/DiscussionPage.tsx` — create: the detail page.
- `src/user/CommentList.tsx` — create.
- `src/App.tsx` — modify: one route.
- `src/styles.css` — modify: the announcement card and comment list.

---

## Task 1: Schema

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Create: `apps/api/src/db/schema-community-feed.test.ts`
- Create: `apps/api/drizzle/00XX_*.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `posts.communityId`, `posts.type`, and the `postComments` table, all importable from `../db/schema`.

- [ ] **Step 1: Write the failing constraint tests**

Create `apps/api/src/db/schema-community-feed.test.ts` — this directory names
schema tests per topic (`schema-phase3.test.ts`, `schema-phase4.test.ts`,
`schema-phase5b.test.ts`), and those three belong to the OLD phase numbering, so
do not add a `schema-phase2.test.ts` that would read as the 2026-08 auth phase.
These insert directly, bypassing every use-case, because a use-case test would only prove the use-case guards it:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { appUsers, communities, posts, postComments } from "./schema";
import { resetDatabase } from "./test-helpers";

describe("post community constraints", () => {
  beforeEach(resetDatabase);

  test("a personal post may not carry a type other than diskusi", async () => {
    const [user] = await db.insert(appUsers).values(aUser()).returning();
    await expect(
      db.insert(posts).values({ authorId: user.id, body: "halo", type: "pengumuman" })
    ).rejects.toThrow(/post_personal_has_no_type/);
  });

  test("a community post may not carry the personal paywall", async () => {
    const [user] = await db.insert(appUsers).values(aUser()).returning();
    const [community] = await db
      .insert(communities)
      .values({ ownerId: user.id, name: "Kelas Fisika", slug: "kelas-fisika", category: "Bimbel & Ujian" })
      .returning();
    await expect(
      db.insert(posts).values({
        authorId: user.id,
        communityId: community.id,
        body: "halo",
        visibility: "members",
      })
    ).rejects.toThrow(/post_community_is_public/);
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
```

`aUser()` is the local fixture helper this file already uses — reuse it rather than writing a second one. If the file has none, copy the shape from `schema-phase5b.test.ts`, which seeds users the same way.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun test src/db/schema-community-feed.test.ts`
Expected: FAIL — `communityId` and `type` are not properties of the insert type, so this fails to typecheck before it fails to run.

- [ ] **Step 3: Add the two columns and the two CHECKs**

In `apps/api/src/db/schema.ts`, inside the `posts` table definition, after `visibility`:

```ts
    // Phase 2. NULL means a personal post — Beranda and profiles. NOT NULL
    // means a community post, which appears on its community page and
    // nowhere else. There is no third state and nothing infers one from
    // the other.
    communityId: uuid("community_id").references(() => communities.id),
    // `diskusi` | `pengumuman`. VARCHAR, not an enum, so Phase 3's
    // `kegiatan` and Phase 4's `materi`/`dokumen` need no migration — the
    // reasoning `subscription.status` already records.
    type: varchar("type", { length: 16 }).notNull().default("diskusi"),
```

And in the same table's constraint array:

```ts
    // A personal post has no type: types are a community concept, and a
    // personal row carrying `pengumuman` is a row no surface renders.
    check("post_personal_has_no_type", sql`${table.communityId} is not null or ${table.type} = 'diskusi'`),
    // DO NOT DELETE THIS AS BELT-AND-BRACES. `visibility = 'members'` is the
    // PERSONAL paywall: `paginate()` in read-posts.ts resolves it against
    // `user_tier` subscriptions via `listActiveOwnersAmong`. A community post
    // carrying `members` would be gated against the author's personal tier,
    // which has no relationship to the community it is in — a member of the
    // community would be locked OUT of it, and a subscriber to the author who
    // never joined would be let IN. A community post's audience is the
    // community; this column must not be made to mean anything else here.
    check("post_community_is_public", sql`${table.communityId} is null or ${table.visibility} = 'public'`),
```

`communities` is declared *below* `posts` in this file, and the forward reference still resolves: drizzle's `.references(() => communities.id)` takes a lazy closure, evaluated after the module has finished loading. Do not reorder the file to "fix" it. `check` and `sql` are already imported for `follow_no_self`.

- [ ] **Step 4: Add the community feed's index — and ONLY that one**

```ts
    // Phase 2: the community feed's keyset page.
    index("post_community_created_idx")
      .on(table.communityId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
```

**Leave `post_live_created_idx` and `post_author_created_idx` exactly as they
are.** This step originally rewrote both to add `community_id IS NULL` to their
predicates, and that was wrong *here*: a partial index and the query whose
WHERE clause must match it are one change, not two. Rewriting the predicate in
this task while `listGlobal` and `listByAuthor` still filter on `deleted_at`
alone leaves Postgres unable to prove the partial index applies, so it falls
back to a sequential scan and `drizzle-post.repository.test.ts`'s "plans
listGlobal and listByAuthor WITHOUT a sequential scan of post" goes red — which
is exactly what happened when this task was first executed.

Both rewrites now live in **Task 3 Step 3**, landing in the same commit as the
filters that make them usable. The generated migration for this task therefore
contains no `DROP INDEX` at all.

Adding `post_community_created_idx` here is safe by the same reasoning
inverted: no current query filters on `community_id`, so it changes no plan.

- [ ] **Step 5: Add `post_comment`**

Immediately after `postMedia` in the same file:

```ts
/**
 * Phase 2. FLAT — no `parent_id`. The programme's feature list says "threaded
 * comments"; the spec records the deviation and its reason. `parent_id` can
 * be added later as a nullable column without moving a row.
 */
export const postComments = pgTable(
  "post_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => appUsers.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Present from the start so a comment's lifecycle needs no second
    // migration. NOTHING WRITES IT THIS PHASE — there is no edit endpoint.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // SOFT delete, matching `post`. Every read path must filter it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // The thread, oldest first. PARTIAL: deleted comments leave the index.
    index("post_comment_post_created_idx")
      .on(table.postId, table.createdAt)
      .where(sql`${table.deletedAt} is null`),
  ]
);
```

- [ ] **Step 6: Add it to `resetDatabase()`**

In `apps/api/src/db/test-helpers.ts`, import `postComments` and delete it **before** `posts` (it references `post` and `app_user`), immediately above the `postMedia` line:

```ts
  // postComments references app_user (author) and post, so it must clear
  // before both — Phase 2.
  await db.delete(postComments);
```

- [ ] **Step 7: Generate and read the migration**

Run: `cd apps/api && bun run db:generate`

Read the generated SQL before continuing. It must contain `ALTER TABLE "post" ADD COLUMN`, two `ADD CONSTRAINT ... CHECK`, `CREATE TABLE "post_comment"`, and `DROP INDEX`/`CREATE INDEX` for the two rewritten indexes. **It must contain no `DROP TABLE` and no `DROP COLUMN`.** If it does, stop and report — the phase is additive.

- [ ] **Step 8: Run the tests**

Run: `cd apps/api && bun test src/db/`
Expected: PASS, including the three new constraint tests.

Then run: `cd apps/api && bun test`
Expected: PASS. Existing post tests still create personal posts, which now default to `type = 'diskusi'` and `community_id = NULL`, so nothing should move. **If any existing test fails here, stop and report it rather than editing it** — an additive migration that breaks a test is not additive.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/ apps/api/drizzle/
git commit -m "feat: post gains a community owner and a type, plus post_comment"
```

---

## Task 2: The shared contract

**Files:**
- Create: `packages/shared/src/post.schema.ts`
- Create: `packages/shared/src/post.schema.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `COMMUNITY_POST_TYPES`, `CommunityPostType`, `MAX_COMMENT_BODY_LENGTH`, `DEFAULT_COMMENT_LIMIT`, `createCommunityPostSchema`, `CreateCommunityPostInput`, `createCommentSchema`, `CreateCommentInput`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/post.schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_POST_TYPES,
  MAX_COMMENT_BODY_LENGTH,
  createCommentSchema,
  createCommunityPostSchema,
} from "./post.schema";

describe("createCommunityPostSchema", () => {
  test("accepts the two types this phase ships", () => {
    expect(COMMUNITY_POST_TYPES).toEqual(["diskusi", "pengumuman"]);
    for (const type of COMMUNITY_POST_TYPES) {
      expect(createCommunityPostSchema.safeParse({ body: "halo semua", type }).success).toBe(true);
    }
  });

  test("rejects a type a later phase owns", () => {
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "kegiatan" }).success).toBe(false);
  });

  test("defaults the type to diskusi", () => {
    const parsed = createCommunityPostSchema.parse({ body: "halo semua" });
    expect(parsed.type).toBe("diskusi");
  });

  test("trims the body and rejects an empty one", () => {
    expect(createCommunityPostSchema.parse({ body: "  halo  " }).body).toBe("halo");
    expect(createCommunityPostSchema.safeParse({ body: "   " }).success).toBe(false);
  });
});

describe("createCommentSchema", () => {
  test("trims, rejects empty, and rejects over the maximum", () => {
    expect(createCommentSchema.parse({ body: "  setuju  " }).body).toBe("setuju");
    expect(createCommentSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "a".repeat(MAX_COMMENT_BODY_LENGTH + 1) }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "a".repeat(MAX_COMMENT_BODY_LENGTH) }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bun test src/post.schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

`packages/shared/src/post.schema.ts`:

```ts
import { z } from "zod";

/**
 * The post types Phase 2 ships. `kegiatan` (Phase 3), `materi` and `dokumen`
 * (Phase 4) join this list when the tables behind them exist — the column is
 * `varchar(16)`, so each is a one-line change here and no migration.
 */
export const COMMUNITY_POST_TYPES = ["diskusi", "pengumuman"] as const;

export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

/** One screen of a thread, matching the roster's cap and for the same reason. */
export const DEFAULT_COMMENT_LIMIT = 50;

/** Shorter than a post: a comment is a reply, not a second post. */
export const MAX_COMMENT_BODY_LENGTH = 2000;

/**
 * `type` DEFAULTS rather than being required, so a member's ordinary "start a
 * discussion" submission need not name it. The route still enforces that only
 * an owner may send `pengumuman` — a default is not an authorisation.
 */
export const createCommunityPostSchema = z.object({
  body: z.string().trim().min(1),
  type: z.enum(COMMUNITY_POST_TYPES).default("diskusi"),
  mediaIds: z.array(z.string().uuid()).optional(),
});

export type CreateCommunityPostInput = z.infer<typeof createCommunityPostSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
```

The body maximum for a post is not redefined here — `MAX_POST_BODY_LENGTH` already exists and is re-exported from `write-post.ts`. The route reuses it.

- [ ] **Step 4: Re-export and run**

Add `export * from "./post.schema";` to `packages/shared/src/index.ts`, following the existing lines' form.

Run: `cd packages/shared && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/
git commit -m "feat: the community post and comment contracts"
```

---

## Task 3: The post repository, and the leak test

**Files:**
- Modify: `apps/api/src/application/ports/post-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts`

**Interfaces:**
- Consumes: `posts.communityId`, `posts.type` (Task 1).
- Produces: `PostRow` gains `type: string` and `communityId: string | null`; `create(input: { authorId, body, visibility?, communityId?, type? }): Promise<PostRow>`; `listByCommunity(communityId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>`.

**This task carries the phase's single biggest risk.** `post.deletedAt`'s own comment records what happened last time: "a filter present on three paths and missing on the fourth… each path's own tests only ever create live posts, so nothing goes red." Step 1 is the test written so that cannot recur.

- [ ] **Step 1: Write the failing leak test — table-driven, one fixture**

Add to `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts`:

```ts
describe("community posts never leak into a personal read path", () => {
  /**
   * ONE fixture, THREE paths, driven from a table. Deliberately not three
   * tests that each happen to remember the filter: that is the exact shape
   * that let a missing `deleted_at` filter through on the fourth path last
   * phase. A path added later joins this table.
   */
  test.each([
    ["listGlobal", (repo: DrizzlePostRepository, ids: Ids) => repo.listGlobal(20, null)],
    ["listFollowing", (repo: DrizzlePostRepository, ids: Ids) => repo.listFollowing(ids.followerId, 20, null)],
    ["listByAuthor", (repo: DrizzlePostRepository, ids: Ids) => repo.listByAuthor(ids.authorId, 20, null)],
  ])("%s excludes it", async (_name, read) => {
    const ids = await seedOnePersonalAndOneCommunityPost();
    const rows = await read(new DrizzlePostRepository(db), ids);
    // Compare ids, never row objects: a failing assertion that holds a row
    // serialises everything joined to it.
    expect(rows.map((r) => r.id)).toEqual([ids.personalPostId]);
  });
});
```

`seedOnePersonalAndOneCommunityPost()` is a local helper in this file. It must create: an author, a follower who follows the author, a community owned by the author, one personal post by the author, and one community post by the author in that community. It returns `{ authorId, followerId, personalPostId, communityPostId }` (the `Ids` type). Write it beside the file's existing seed helpers and follow their shape.

The `listFollowing` row must be authored by someone the follower follows, or the test passes vacuously — assert in the helper that the follow row was created.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-post.repository.test.ts`
Expected: FAIL on all three rows — each currently returns both posts.

- [ ] **Step 3: Add the filter to the three read paths, and rewrite the two indexes with it**

These land together, in one commit, and the order is not negotiable: the index
predicates and the query WHERE clauses must match, or the planner cannot use
the index. Task 1 deliberately left both indexes alone for this reason.

In `apps/api/src/db/schema.ts`, replace the two existing `posts` indexes:

```ts
    // Untuk Anda: newest first across everybody. PARTIAL on BOTH conditions,
    // so deleted rows AND community rows leave the hot index entirely rather
    // than being filtered out of every scan. Phase 2 added the second
    // condition when Beranda became `community_id IS NULL`.
    index("post_live_created_idx")
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.communityId} is null`),
    // A profile's posts, and the post side of the Mengikuti join. BOTH
    // consumers exclude community posts, so the filter belongs in the index.
    index("post_author_created_idx")
      .on(table.authorId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null and ${table.communityId} is null`),
```

`post_author_created_idx` was NOT partial before; making it partial is
deliberate and is why it is rewritten rather than extended. Run
`bun run db:generate` for the migration carrying both — this one DOES contain
`DROP INDEX`, which is correct for an index rewrite.

**Two existing tests in `drizzle-post.repository.test.ts` break here, and both
are updated deliberately with a comment recording why** — the programme's
working agreement requires exactly that, rather than deleting or weakening
them:

- `indexes listGlobal's (created_at desc, id desc), live rows only` pins the
  predicate string `WHERE (deleted_at IS NULL)`. It becomes
  `WHERE ((deleted_at IS NULL) AND (community_id IS NULL))`.
- `plans listGlobal and listByAuthor WITHOUT a sequential scan of post` is
  **not** edited. It must go green on its own once the filters below land. If
  it does not, the index and the query still disagree — stop and report rather
  than relaxing the assertion.

Then in `drizzle-post.repository.ts`:

```ts
  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(and(isNull(posts.deletedAt), isNull(posts.communityId)), limit, before);
  }

  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(
      and(eq(posts.authorId, authorId), isNull(posts.deletedAt), isNull(posts.communityId)),
      limit,
      before
    );
  }
```

And in `listFollowing`'s `.where(...)`, add `isNull(posts.communityId)` to the existing `and(...)`.

- [ ] **Step 4: Run the leak test**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-post.repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `listByCommunity` and `create` tests**

```ts
test("listByCommunity returns only that community's live posts, newest first", async () => {
  const ids = await seedTwoCommunitiesWithPosts();
  const rows = await new DrizzlePostRepository(db).listByCommunity(ids.communityAId, 20, null);
  expect(rows.map((r) => r.body)).toEqual(["kedua", "pertama"]);
});

test("create stores the community and the type", async () => {
  const ids = await seedCommunity();
  const row = await new DrizzlePostRepository(db).create({
    authorId: ids.ownerId,
    body: "pengumuman penting",
    communityId: ids.communityId,
    type: "pengumuman",
  });
  expect(row.type).toBe("pengumuman");
  expect(row.communityId).toBe(ids.communityId);
});

test("create with no community leaves a personal diskusi post", async () => {
  const ids = await seedCommunity();
  const row = await new DrizzlePostRepository(db).create({ authorId: ids.ownerId, body: "halo" });
  expect(row.communityId).toBeNull();
  expect(row.type).toBe("diskusi");
});
```

- [ ] **Step 6: Change `create`'s signature and add `listByCommunity`**

`create` currently takes positional `(authorId, body, visibility?)` and has callers in `write-post.ts` and its tests. **Change it to a single object parameter** — a fourth and fifth positional argument, both optional, is where a caller silently passes `type` into `visibility`:

```ts
  async create(input: {
    authorId: string;
    body: string;
    visibility?: string;
    communityId?: string;
    type?: string;
  }): Promise<PostRow> {
```

Keep the existing "omit the key entirely rather than passing `undefined`" technique for every optional column, and its comment — drizzle inserts NULL into a NOT NULL column when handed an explicit `undefined`.

Update the port's declaration and every call site the compiler flags. `bun run typecheck` is what finds them; there should be exactly two production call sites (`CreatePost`) plus tests.

Add:

```ts
  listByCommunity(communityId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(
      and(eq(posts.communityId, communityId), isNull(posts.deletedAt)),
      limit,
      before
    );
  }
```

Add `communityId` and `type` to `postColumns` so `PostRow` carries them, and add both to the `PostRow` interface with doc comments matching the schema's.

- [ ] **Step 7: Run the repository suite**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-post.repository.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole API suite**

Run: `cd apps/api && bun test`
Expected: PASS. Existing feed and profile tests are the check that the filter changed nothing for personal posts.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/application/ports/post-repository.port.ts apps/api/src/infrastructure/repositories/
git commit -m "feat: community posts stay out of the personal read paths"
```

---

## Task 4: The comment repository

**Files:**
- Create: `apps/api/src/application/ports/comment-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-comment.repository.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-comment.repository.test.ts`

**Interfaces:**
- Consumes: `postComments` (Task 1).
- Produces:

```ts
export interface CommentRow {
  id: string;
  body: string;
  createdAt: Date;
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
}

export interface CommentOwnership {
  id: string;
  authorId: string;
  postId: string;
  isDeleted: boolean;
}

export interface CommentRepositoryPort {
  create(postId: string, authorId: string, body: string): Promise<CommentRow>;
  listForPost(postId: string, limit: number): Promise<CommentRow[]>;
  /** Live comment counts for a whole feed page, in ONE query. Missing ids mean zero. */
  countForPosts(postIds: string[]): Promise<Map<string, number>>;
  ownershipOf(id: string): Promise<CommentOwnership | null>;
  /** Idempotent, like the post's. */
  softDelete(id: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
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
  const counts = await new DrizzleCommentRepository(db).countForPosts([ids.postAId, ids.postBId]);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-comment.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the port**

Create `comment-repository.port.ts` with the interfaces quoted in **Interfaces** above, each field carrying a doc comment in the house style. `authorId` is present on `CommentRow` for the same reason `PostRow` carries it: "may this viewer delete this" is a question about ids, and the view mapper picks its wire fields explicitly.

- [ ] **Step 4: Write the adapter**

Create `drizzle-comment.repository.ts`. Follow `drizzle-post.repository.ts`'s shape exactly: a module-level `commentColumns` projection joined to `appUsers`, a class taking `DatabaseExecutor`.

`countForPosts` must guard the empty list before querying — `inArray(x, [])` generates invalid SQL in some drivers and is a wasted round trip in all of them:

```ts
  async countForPosts(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const rows = await this.db
      .select({ postId: postComments.postId, count: sql<number>`count(*)::int` })
      .from(postComments)
      .where(and(inArray(postComments.postId, postIds), isNull(postComments.deletedAt)))
      .groupBy(postComments.postId);
    return new Map(rows.map((r) => [r.postId, r.count]));
  }
```

`::int` is not optional: Postgres `count(*)` is `bigint`, which arrives as a string and would make every count a string on the wire.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-comment.repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/application/ports/comment-repository.port.ts apps/api/src/infrastructure/repositories/drizzle-comment.repository*
git commit -m "feat: the comment repository"
```

---

## Task 5: The feed use-cases

**Files:**
- Create: `apps/api/src/application/use-cases/community-feed.ts`
- Create: `apps/api/src/application/use-cases/community-feed.test.ts`
- Modify: `apps/api/src/application/use-cases/post-views.ts`
- Modify: `apps/api/src/application/use-cases/read-posts.ts`

**Interfaces:**
- Consumes: `PostRepositoryPort.listByCommunity`/`create` (Task 3), `CommentRepositoryPort.countForPosts` (Task 4), `CommunityRepositoryPort.findBySlug`/`isMember` (Phase 1).
- Produces: `PostView` gains `type: string` and `commentCount: number`; `class CreateCommunityPost`, `class ListCommunityFeed`, `class GetPost`.

- [ ] **Step 1: Extend `PostView`**

In `post-views.ts`, add to the `PostView` interface:

```ts
  /**
   * `diskusi` | `pengumuman` on a community post; always `diskusi` on a
   * personal one, where the CHECK constraint permits nothing else. Present on
   * EVERY post rather than only community ones, so the key set is stable —
   * the same reasoning `membersOnly` records.
   */
  type: string;
  /**
   * Live comments only. `0` on a personal post, which cannot be commented on
   * this phase, and on a community post nobody has replied to — the two are
   * not distinguished, because no surface needs to tell them apart.
   */
  commentCount: number;
```

`toPostView` gains a `commentCount` parameter. Give it **no default**: a defaulted count is how a feed page ships zeros for every row when a caller forgets to pass the map.

- [ ] **Step 2: Write the failing use-case tests**

`community-feed.test.ts`. Use the in-memory fakes this directory already uses (copy the fake repository shapes from `join-community.test.ts` and `read-posts.test.ts`):

```ts
describe("CreateCommunityPost", () => {
  test("a member may start a diskusi", async () => { /* asserts the created row's type and communityId */ });

  test("a non-member may not, and nothing is written", async () => {
    await expect(useCase.execute({ slug: "kelas-fisika", authorId: strangerId, body: "halo", type: "diskusi" }))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.created).toEqual([]);
  });

  test("a member may not post a pengumuman", async () => {
    await expect(useCase.execute({ slug: "kelas-fisika", authorId: memberId, body: "x", type: "pengumuman" }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the owner may post a pengumuman", async () => { /* … */ });

  test("an unknown slug is a NotFoundError, checked before membership", async () => {
    await expect(useCase.execute({ slug: "tidak-ada", authorId: strangerId, body: "x", type: "diskusi" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ListCommunityFeed", () => {
  test("a signed-out viewer gets the page", async () => { /* viewerId: null must not throw */ });

  test("comment counts come from ONE batched call for the whole page", async () => {
    await useCase.execute({ slug: "kelas-fisika", viewerId: null, before: null });
    expect(comments.countForPostsCalls.length).toBe(1);
  });

  test("an unknown slug is a NotFoundError", async () => { /* … */ });
});
```

The batched-call test is not ceremony: `paginate()`'s own docstring records that a per-post lookup would be 20 round trips on the busiest page in the product, and a comment count is the third thing on this page that could be fetched per row.

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && bun test src/application/use-cases/community-feed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `CreateCommunityPost` and `ListCommunityFeed`**

`community-feed.ts`. Both resolve the slug first via `communities.findBySlug`, throwing `NotFoundError` when it is null — **before** any membership check, so an unknown slug never answers "forbidden" and thereby confirms which slugs exist.

`CreateCommunityPost.execute({ slug, authorId, body, type, mediaIds })`:
1. `findBySlug` → `NotFoundError`.
2. `type === "pengumuman"` → require `community.ownerId === authorId`, else `ForbiddenError`.
3. otherwise → require `isMember(community.id, authorId)`, else `ForbiddenError`.
4. delegate to the existing `CreatePost` for the write, passing `communityId` and `type`, so media claiming and the body-length rule stay in one place.

Step 4 is the important one: **do not reimplement the write.** `CreatePost` already claims media, enforces `MAX_POST_BODY_LENGTH`, and runs inside `PostWriteUnitOfWorkPort`. `CreateCommunityPost` is an authorisation wrapper around it.

`ListCommunityFeed.execute({ slug, viewerId, limit?, before })`:
1. `findBySlug` → `NotFoundError`.
2. `posts.listByCommunity(community.id, limit + 1, before)`.
3. hand the rows to `paginate()` unchanged, plus one `comments.countForPosts(rows.map(r => r.id))`.

`paginate()` needs the count map threaded to `toFeedPage`/`toPostView`. Add it as a required parameter to `paginate()` and pass an empty map from `ListFeed` and `ListUserPosts` — personal posts have no comments this phase, and an empty map makes that explicit at each call site rather than by omission.

- [ ] **Step 5: Write `GetPost`**

In `read-posts.ts`, beside `ListFeed`:

```ts
/**
 * One post, for DiscussionDetail. Answers for PERSONAL posts too, honouring
 * the paywall gate: one endpoint that applies the gate correctly is safer
 * than a community-only endpoint that never learns about it.
 */
export class GetPost {
  async execute(input: { postId: string; viewerId: string | null }): Promise<PostView> {
```

A missing or soft-deleted post is a `NotFoundError`. Reuse the same gating path `paginate()` uses rather than a second copy of the lock rule — factor the single-row case out of `paginate()` if that is what it takes, and if you do, say so in the commit message.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun test src/application/use-cases/`
Expected: PASS, including the existing `read-posts.test.ts` — which is where a mistake in threading the count map through `paginate()` will show up.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/application/use-cases/
git commit -m "feat: the community feed use-cases"
```

---

## Task 6: The comment use-cases, and the owner's delete

**Files:**
- Create: `apps/api/src/application/use-cases/comments.ts`
- Create: `apps/api/src/application/use-cases/comments.test.ts`
- Modify: `apps/api/src/application/use-cases/write-post.ts`
- Modify: `apps/api/src/application/use-cases/write-post.test.ts`

**Interfaces:**
- Consumes: `CommentRepositoryPort` (Task 4); `PostRepositoryPort.ownershipOf` — which **already returns `communityId: string | null`**, added to `PostOwnership` in Task 1 under ruling R1, so no further port change is needed for it; `CommunityRepositoryPort.isMember` (Phase 1).
- **Adds `CommunityRepositoryPort.findById(id: string): Promise<CommunityRecord | null>`** — Phase 1's community port has `findBySlug` but no by-id lookup, and `DeleteComment`'s owner check resolves a community from the post's `communityId`, which is an id. Add it to the port, the Drizzle adapter, and every `CommunityRepositoryPort` fake the compiler flags. Same shape as Task 5's `getById` addition. This is ruling R9.
- Produces: `class ListComments`, `class CreateComment`, `class DeleteComment`, and a `CommentView` — `{ id, body, createdAt: string, author: { handle, displayName } }`, nested in the same one place `PostView` is.

**`CommentRepositoryPort` already has what the three use-cases need** — `create`, `listForPost`, `ownershipOf`, `softDelete` (Task 4). `ListComments` maps `CommentRow[]` → `CommentView[]`. `CreateComment` needs `posts.ownershipOf(postId)` for `{ communityId, isDeleted }` (null → `NotFoundError`; `isDeleted` → `NotFoundError`; `communityId` null → `ForbiddenError`; else `isMember(communityId, authorId)` → `ForbiddenError` on false). `DeleteComment` needs `comments.ownershipOf(commentId)` for `{ authorId, postId, isDeleted }`, then — if the deleter is not the author — `posts.ownershipOf(postId)` for `communityId`, then `communities.findById(communityId)` for `ownerId`.

- [ ] **Step 1: Write the failing comment tests**

```ts
describe("CreateComment", () => {
  test("a member of the post's community may comment", async () => { /* … */ });

  test("a non-member may not", async () => {
    await expect(useCase.execute({ postId, authorId: strangerId, body: "halo" }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a PERSONAL post cannot be commented on at all", async () => {
    // The post has communityId null, so there is no membership that could
    // authorise this — the spec's "only community posts take comments".
    await expect(useCase.execute({ postId: personalPostId, authorId: anyoneId, body: "halo" }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a deleted post cannot be commented on", async () => { /* NotFoundError */ });
});

describe("DeleteComment", () => {
  test("the author may delete their own", async () => { /* … */ });
  test("the community owner may delete anybody's", async () => { /* … */ });
  test("another member may not", async () => { /* ForbiddenError */ });
  test("deleting an already-deleted comment is a no-op, not an error", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/application/use-cases/comments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the three use-cases**

`comments.ts`. `CreateComment` resolves the post's `communityId` first; a null one is `ForbiddenError`, not a special case — nobody is a member of "no community", so the ordinary membership check answers it correctly. Write that reasoning as a comment, because a future reader will otherwise add an `if (communityId === null)` branch that says the same thing twice.

`DeleteComment` is idempotent on an already-deleted comment, matching `DeletePost`.

- [ ] **Step 4: Write the failing `DeletePost` owner test**

In `write-post.test.ts`:

```ts
test("a community's owner may delete a member's post in it", async () => {
  await deletePost.execute({ deleterId: ownerId, postId: memberPostId });
  expect(posts.softDeleted).toContain(memberPostId);
});

test("a community's owner may NOT edit a member's post in it", async () => {
  await expect(editPost.execute({ editorId: ownerId, postId: memberPostId, body: "diubah" }))
    .rejects.toBeInstanceOf(ForbiddenError);
});

test("a stranger may not delete a community post", async () => { /* ForbiddenError */ });
```

The edit test is a negative that must not be dropped as redundant: it is the assertion that an owner moderating removes a post and never rewrites another member's words under that member's name.

- [ ] **Step 5: Add the owner rule to `DeletePost` only**

`DeletePost` gains the community repository as a dependency. When the deleter is not the author and the post has a `communityId`, it is permitted iff the deleter owns that community. `EditPost` is untouched.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun test src/application/use-cases/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/application/use-cases/ \
        apps/api/src/application/ports/comment-repository.port.ts \
        apps/api/src/application/ports/community-repository.port.ts \
        apps/api/src/infrastructure/repositories/drizzle-community.repository.ts \
        apps/api/src/infrastructure/repositories/drizzle-community.repository.test.ts
git commit -m "feat: comments, and an owner who can moderate by deletion only"
```

If `bun run typecheck` flags a fake in another `*.test.ts` for the new
`findById`, stage that too. `git status` before the commit and confirm every
modified file is one this task is meant to touch.

---

## Task 7: Routes and wiring

**Carried in from earlier tasks — do this task's wiring on top of these:**
- `bootstrap.ts` has **no DI wiring** yet for `CreateCommunityPost`, `ListCommunityFeed`, `GetPost` (Task 5), or `ListComments`/`CreateComment`/`DeleteComment` (Task 6). Construct each with its real repositories and add it to the `Dependencies` object, following exactly how Phase 1 wired `joinCommunity` / `createCommunity`. `DrizzleCommentRepository` is constructed once and shared by `ListComments`, `CreateComment`, `DeleteComment`, `ListCommunityFeed`, and `DeleteComment`'s sibling `DeletePost` (which gained the community dep in Task 6).
- The four `PostView` exact-key-set arrays in `routes/posts.test.ts` were **already widened** with `commentCount` and `type` by Task 5 (to keep the suite green then). Do not re-edit them; if a new route test needs the key set, reuse the existing `POST_KEYS` const.
- **The community-post route MUST cap `mediaIds` per-call.** `createCommunityPostSchema` (Task 2) deliberately carries no `.max()` — the image cap is a per-process value (`deps.maxPostImages`), which is why `routes/posts.ts` `buildPostBodySchema` is built per-request. The `POST /communities/:slug/posts` handler applies the same `.max(deps.maxPostImages, ...)` refinement to `mediaIds` before validating, or an unbounded id array reaches the media-claim path.

**Files:**
- Modify: `apps/api/src/routes/communities.ts` + `.test.ts`
- Modify: `apps/api/src/routes/posts.ts` + `.test.ts`
- Modify: `apps/api/src/domain/handle.ts`
- Modify: `apps/api/src/bootstrap.ts` — where `Dependencies` is assembled

**Interfaces:**
- Consumes: every use-case from Tasks 5 and 6.
- Produces: the six endpoints in the spec's API table.

- [ ] **Step 1: Reserve the `comments` handle**

Add `"comments",` to `RESERVED_HANDLES` in `apps/api/src/domain/handle.ts`, in alphabetical position, with a comment naming `DELETE /users/comments/:id` as the route it protects.

Run the guard test that derives the list from the route table (find it with `grep -rl "RESERVED_HANDLES" apps/api/src`) **before** adding the route: it should be green now and stay green after.

- [ ] **Step 2: Write the failing route tests**

In `communities.test.ts` — these go through the real `createApp`, as Phase 1's do:

```ts
test("GET /communities/:slug/posts is readable signed out", async () => {
  const res = await app.request("/communities/kelas-fisika/posts");
  expect(res.status).toBe(200);
});

test("POST /communities/:slug/posts requires auth", async () => {
  const res = await app.request("/communities/kelas-fisika/posts", { method: "POST", body: JSON.stringify({ body: "halo" }) });
  expect(res.status).toBe(401);
});

test("POST /communities/:slug/posts by a non-member is 403", async () => { /* … */ });
test("POST /communities/:slug/posts with type pengumuman by a member is 403", async () => { /* … */ });
test("an unknown slug is 404 on both", async () => { /* … */ });
```

In `posts.test.ts`:

```ts
test("GET /users/posts/:id answers a community post signed out", async () => { /* 200 */ });
test("GET /users/posts/:id is 404 for a deleted post", async () => { /* … */ });
test("POST /users/posts/:id/comments requires auth", async () => { /* 401 */ });
test("DELETE /users/comments/:id by a stranger is 403", async () => { /* … */ });
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/api && bun test src/routes/`
Expected: FAIL with 404s from Hono — the routes do not exist.

- [ ] **Step 4: Add the community feed endpoints**

In `communities.ts`, add to `deps`' `Pick<...>` list: `createCommunityPost`, `listCommunityFeed`. Then:

```ts
  app.get<"/:slug/posts">("/:slug/posts", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    return c.json(
      await deps.listCommunityFeed.execute({
        slug: c.req.param("slug"),
        viewerId,
        before: parseBefore(c.req.query("before")),
        limit: parseFeedLimit(c.req.query("limit")),
      })
    );
  });
```

**The page-size rule lives in `routes/posts.ts` and must not be retyped.** That
file holds module-local `DEFAULT_FEED_PAGE_SIZE = 20` and `MAX_FEED_PAGE_SIZE =
50`, applied by `parseFeedQuery(tab, limit)` — which also validates the feed's
`tab` and so cannot be called from here as it stands. Split its limit half into
an exported `parseFeedLimit(raw: string | undefined): number` and have
`parseFeedQuery` call it, so both feeds clamp identically and the two numbers
exist once. A `?limit=` over the maximum is a 400 with the existing Bahasa
message, not a silent clamp — keep that behaviour, it is what the current
message promises.

`read-posts.ts` has a THIRD `DEFAULT_FEED_PAGE_SIZE`, deliberately private as a
fallback for direct callers. Leave it alone; do not export it to reach it.

**Declare `/:slug/posts` BEFORE the existing `/:slug`** — the same literal-wins ordering rule `/komunitas/baru` follows on the web side, and the reason `app.ts`'s comment gives for its own mount order.

**The cursor parser is `parseBefore` in `routes/posts.ts`**, currently module-local.
Export it and import it here rather than writing a second one — it is what makes
a malformed `?before=` a 400 rather than silently "no cursor", and two parsers
is how the two feeds come to disagree about that.

The POST mirrors it with `requireAuth` and `validate(createCommunityPostSchema)`.

- [ ] **Step 5: Add the post and comment endpoints**

In `posts.ts`, add `GET /posts/:id`, `GET /posts/:id/comments`, `POST /posts/:id/comments`, `DELETE /comments/:id` (all relative to the router, which is mounted at `/users`). `validateParams` with a UUID schema on every `:id`, matching the existing `postIdParams`.

- [ ] **Step 6: Wire the dependencies**

Construct `DrizzleCommentRepository` once and pass it to `ListComments`, `CreateComment`, `DeleteComment`, `ListCommunityFeed` and `DeletePost`, alongside the existing repositories. Follow exactly how Phase 1 wired `joinCommunity`.

- [ ] **Step 7: Run everything**

Run: `cd apps/api && bun test && bun run typecheck`
Expected: PASS, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/
git commit -m "feat: the community feed and comment endpoints, wired"
```

---

## Task 8: The community feed on screen

**Files:**
- Modify: `apps/web/src/user/apiClient.ts`
- Modify: `apps/web/src/user/PostCard.tsx` + `.test.tsx`
- Create: `apps/web/src/user/CommunityFeed.tsx` + `.test.tsx`
- Modify: `apps/web/src/user/CommunityPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: the endpoints from Task 7.
- Produces: `listCommunityPosts(slug, before?)`, `createCommunityPost(slug, input)`, `getPost(id)`, `listComments(postId)`, `createComment(postId, body)`, `deleteComment(id)`; `PostView` gains `type` and `commentCount`.

- [ ] **Step 1: Add the client functions**

In `apiClient.ts`, beside `listFeed`. Reads use `publicGet` (the signed-out-safe path), writes use `apiFetch`:

```ts
/** `GET /communities/:slug/posts` — public, backs the Diskusi tab. */
export function listCommunityPosts(slug: string, before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams();
  if (before !== undefined && before !== null) params.set("before", before);
  const search = params.toString();
  return publicGet<FeedPage>(
    `/communities/${encodeURIComponent(slug)}/posts${search === "" ? "" : `?${search}`}`,
    "gagal memuat diskusi"
  );
}
```

Add `type: string` and `commentCount: number` to the client's `PostView` interface to match the server's.

- [ ] **Step 2: Write the failing `PostCard` tests**

```tsx
test("a pengumuman card is labelled as one", () => {
  render(<PostCard post={aPost({ type: "pengumuman" })} isOwn={false} />);
  expect(screen.getByText("Pengumuman")).toBeTruthy();
});

test("a diskusi card carries no type label", () => {
  render(<PostCard post={aPost({ type: "diskusi" })} isOwn={false} />);
  expect(screen.queryByText("Pengumuman")).toBeNull();
});

test("the comment count links to the discussion", () => {
  render(<PostCard post={aPost({ commentCount: 3 })} isOwn={false} detailHref="/komunitas/kelas-fisika/diskusi/p1" />);
  const link = screen.getByRole("link", { name: /3 komentar/ });
  // A STRING, never the node: a failing assertion holding a happy-dom
  // element serialises the whole tree and exhausts memory.
  expect(link.getAttribute("href")).toBe("/komunitas/kelas-fisika/diskusi/p1");
});

test("with no detailHref there is no comment link at all", () => {
  render(<PostCard post={aPost({ commentCount: 3 })} isOwn={false} />);
  expect(screen.queryByRole("link", { name: /komentar/ })).toBeNull();
});
```

The last case is the one that keeps Beranda unchanged: a personal post gets no `detailHref`, so nothing new renders there.

- [ ] **Step 3: Add the three optional props**

```tsx
  /** Rendered as a link when present. Absent on Beranda and profiles, where there is no discussion page. */
  detailHref?: string;
```

Plus the `pengumuman` badge read from `post.type` and the count read from `post.commentCount`. All three are additive: no existing call site changes.

- [ ] **Step 4: Run the PostCard tests**

Run: `cd apps/web && bun test src/user/PostCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing `CommunityFeed` tests**

Cases: a member sees the composer; a non-member sees `Gabung` in its place; a signed-out visitor sees `Masuk untuk gabung`; the owner alone sees the type selector; a submitted post appears at the top without a refetch (via `PostFeed`'s `prepend`); a failed load shows copy from `errorCopy.ts` with `role="alert"`; an empty community shows the empty message.

- [ ] **Step 6: Write `CommunityFeed`**

It renders `PostComposer` (or the join control) above a `PostFeed` whose `load` is `(before) => listCommunityPosts(slug, before)`, holding `PostFeedHandle` to `prepend` on submit. The type selector renders **only** when `viewerIsOwner` — never disabled, never hidden-but-present.

- [ ] **Step 7: Write the failing `CommunityPage` tab tests**

```tsx
test("the two tabs are the tab bar, and Diskusi is the default", () => { /* aria-current on Diskusi */ });
test("?tab=anggota shows the roster and not the feed", () => { /* … */ });
test("clicking Anggota puts the tab in the URL", () => { /* … */ });
```

Every assertion by role, label and text.

- [ ] **Step 8: Add the tab bar**

Copy Jelajah's pattern exactly — `.feed-tabs` markup, `aria-current`, `useSearchParams`, and **only the active half mounted**, for the reason Jelajah's own comment gives: the inactive half must not fetch. Phase 1's roster moves under `?tab=anggota` unchanged.

- [ ] **Step 9: Style the announcement card**

In `styles.css`, the `pengumuman` badge and card accent, using existing Udara tokens only. **No new colour values** — Phase 0's palette work and its AA ratios are settled.

- [ ] **Step 10: Run the web suite**

Run: `cd apps/web && bun test && bun run typecheck`
Expected: PASS. Beranda's and the profile's existing tests must be untouched and green.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/
git commit -m "feat: a community's feed, under its first real tab bar"
```

---

## Task 9: The discussion page

**Files:**
- Create: `apps/web/src/user/DiscussionPage.tsx` + `.test.tsx`
- Create: `apps/web/src/user/CommentList.tsx` + `.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `getPost`, `listComments`, `createComment`, `deleteComment` (Task 8 Step 1).
- Produces: the finished phase.

**`getPost` returns `commentCount: 0` always** — the `GET /users/posts/:id` endpoint has no comment repository behind it (Task 5, ruling deferred). If the discussion-detail view shows a reply count anywhere, derive it from `listComments(...)`'s result length, never from `getPost(...).commentCount`.

- [ ] **Step 1: Write the failing `CommentList` tests**

Cases: comments render oldest first with author handle and body; a member sees the comment form; a non-member and a signed-out visitor see no form; the author of a comment sees a delete control and nobody else does; the community owner sees one on every comment; an empty thread shows `Belum ada komentar.`

- [ ] **Step 2: Write `CommentList`**

- [ ] **Step 3: Write the failing `DiscussionPage` tests**

Cases: the post body and author render; the comment thread renders below it; an unknown id renders `NotFoundPage`; a failed load shows `errorCopy.ts` copy with `role="alert"`; a submitted comment appears without a refetch.

Loading, not-found and error are three separate early returns — the shape `ProfilePage` and `CommunityPage` both already use.

- [ ] **Step 4: Write `DiscussionPage`**

- [ ] **Step 5: Register the route**

In `App.tsx`, inside the `AppShell` layout route, add `/komunitas/:slug/diskusi/:postId` **after** `/komunitas/:slug` and **before** the catch-all `/:handleParam`.

- [ ] **Step 6: Full verification**

From the repo root: `bun run test` and `bun run typecheck`.
Report the actual pass/fail counts for `apps/api`, `apps/web` and `packages/shared` — not "all green".

- [ ] **Step 7: Commit and stop**

Do **not** merge and do **not** push. Report to the repo owner: the test counts, that the migration in `apps/api/drizzle` is additive and theirs to run, and that nothing has been rendered in a browser.

---

## Self-Review

**Spec coverage.** Two columns, two CHECKs, three indexes and `post_comment` → Task 1. The shared contract and the two write payloads → Task 2. `community_id IS NULL` on the three read paths, plus the table-driven leak test the spec's Testing section demands → Task 3. `countForPosts` as one batched query, per "no stored comment count" → Task 4. Feed reach, the permissions table's post rows, `GetPost`, and announcements-unpinned (a plain chronological `listByCommunity`) → Task 5. The permissions table's comment rows, comments-are-community-only, and the owner-deletes-but-never-edits rule → Task 6. The six endpoints, the `/users` prefix and `comments` in `RESERVED_HANDLES` → Task 7. The tab bar, one card not two, the inline composer, the owner-only type selector → Task 8. `DiscussionDetail` and its route → Task 9. "No comment editing" is covered by omission and stated in Global Constraints. The sidebar's joined-communities group is out of scope by the spec's own "Not in this phase".

**Placeholder scan.** Tasks 5, 6, 8 and 9 give several test cases as prose or as a `describe` skeleton with `/* … */` bodies rather than quoting every assertion. This is a deliberate departure from the plan-writing rule and is flagged rather than hidden — Phase 1's plan made the same call for the same reason: each case names the exact behaviour, the exact error class, and the exact Indonesian string where one is user-visible, and each points at a file in this repo to copy the harness from. Quoting roughly seventy assertions verbatim would make this document longer than the code it describes. **If an implementer finds a case underspecified, that is a plan defect — report it rather than guessing.**

**Type consistency.** `PostRow` gains `type` and `communityId` in Task 3 and is read under those names in Tasks 5 and 6. `PostView` gains `type` and `commentCount` in Task 5 and is consumed under those names in Task 8. `CommentRow`, `CommentOwnership` and `CommentRepositoryPort` are declared once in Task 4 and referenced by those exact names in Tasks 6 and 7. `countForPosts(postIds: string[]): Promise<Map<string, number>>` matches its call site in Task 5. `listByCommunity(communityId, limit, before)` matches Task 5's use. `createCommunityPostSchema` is defined in Task 2 and consumed in Task 7 Step 4.

**Known hazards.**

1. **Task 3 Step 6 changes `create`'s signature from positional to an object**, which touches `CreatePost` and every test that constructs a post through the repository. If Tasks 3 and 5 are executed by different agents, this is the seam most likely to drop — the compiler catches it, so `bun run typecheck` at the end of Task 3 is not optional.
2. **Task 5 Step 4 threads a count map through `paginate()`**, which `ListFeed` and `ListUserPosts` also call. Passing an empty map from both is required; forgetting one leaves Beranda's `commentCount` undefined at runtime while typechecking cleanly if the parameter is made optional. **Do not make it optional.**
3. **Task 1's index rewrite makes `post_author_created_idx` partial for the first time.** If a query exists that reads a *deleted* post by author, it loses its index. Grep for `listByAuthor` callers before assuming none does.
