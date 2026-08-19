## Task 1: The `post_media` table and its repository

**Files:**
- Modify: `apps/api/src/db/schema.ts` (append after `posts`, which ends at line 891)
- Modify: `apps/api/src/db/test-helpers.ts` (add the new table to the reset)
- Create: `apps/api/src/application/ports/media-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-media.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-media.repository.test.ts`

**Interfaces:**
- Consumes: `appUsers`, `posts` from `../../db/schema`.
- Produces: `postMedia` (schema), `MediaRow`, `MediaRepositoryPort`, `DrizzleMediaRepository`.

- [ ] **Step 1: Add the table to `schema.ts`**

Append after `posts`. `index`, `uuid`, `integer`, `text`, `timestamp` and `sql` are already imported at the top of the file.

```ts
export const postMedia = pgTable(
  "post_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The uploader. Kept even after the post claims the row: an edit has to
    // check that the media it is being handed belongs to the editor, and the
    // post it currently sits on is not the answer to that question.
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    // NULLABLE, and this is the whole two-step upload in one column. A row
    // exists from the moment bytes land, before any post does, and is CLAIMED
    // when the post is created or edited. A null here is an orphan and the
    // worker's sweep collects it (spec §8).
    postId: uuid("post_id").references(() => posts.id),
    // 0-based, and only meaningful once claimed. The order the client sent.
    position: integer("position").notNull().default(0),
    // Of the FULL image after re-encoding, not of what was uploaded. PostCard
    // reserves space from these so the feed does not reflow as images land.
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The post's own images, in order. Covers the read on every feed row.
    index("post_media_post_position_idx").on(table.postId, table.position),
    // The sweep: unclaimed rows, oldest first. PARTIAL, so claimed rows — which
    // are the overwhelming majority — never enter this index at all.
    index("post_media_unclaimed_idx")
      .on(table.createdAt)
      .where(sql`${table.postId} is null`),
  ]
);
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && bun run db:generate`

Open the generated SQL in `apps/api/drizzle/` and confirm by eye: `post_id` is nullable, both indexes exist, and the partial index carries `WHERE "post_id" is null`. Drizzle has previously emitted modifiers nobody asked for — Phase 3 Task 1 lost a day to `DESC NULLS LAST` — so read the SQL, do not assume it.

- [ ] **Step 3: Add the table to the test reset**

In `apps/api/src/db/test-helpers.ts`, add `postMedia` to the truncate list **before** `posts` (it references them).

- [ ] **Step 4: Write the failing repository test**

Create `drizzle-media.repository.test.ts`. Use the existing repository tests as the harness pattern — they create a user, then exercise the repository against the real database.

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMediaRepository } from "./drizzle-media.repository";

beforeEach(resetDatabase);

describe("DrizzleMediaRepository", () => {
  it("creates an unclaimed row and finds it by id", async () => {
    const repo = new DrizzleMediaRepository();
    const owner = await createUser("wildan");

    const created = await repo.create({
      ownerId: owner.id,
      width: 1600,
      height: 900,
      byteSize: 240_000,
    });

    expect(created.postId).toBe(null);
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("claims rows onto a post, in the order given", async () => {
    const repo = new DrizzleMediaRepository();
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const a = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    const b = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    await repo.claim(post.id, [b.id, a.id]);

    const rows = await repo.listForPost(post.id);
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it("unclaims rows that a post no longer holds, without deleting them", async () => {
    const repo = new DrizzleMediaRepository();
    const owner = await createUser("wildan");
    const post = await createPost(owner.id);
    const kept = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    const dropped = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    await repo.claim(post.id, [kept.id, dropped.id]);

    await repo.claim(post.id, [kept.id]);

    expect((await repo.listForPost(post.id)).map((r) => r.id)).toEqual([kept.id]);
    // The row SURVIVES, unclaimed — spec §8. Asserting only its absence from the
    // post would pass equally well against an implementation that deleted it.
    const orphan = await repo.findById(dropped.id);
    expect(orphan?.postId).toBe(null);
  });

  it("lists unclaimed rows older than a cutoff, for the sweep", async () => {
    const repo = new DrizzleMediaRepository();
    const owner = await createUser("wildan");
    const old = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });
    await backdate(old.id, new Date(Date.now() - 48 * 60 * 60_000));
    const fresh = await repo.create({ ownerId: owner.id, width: 10, height: 10, byteSize: 1 });

    const stale = await repo.listUnclaimedBefore(new Date(Date.now() - 24 * 60 * 60_000), 100);

    expect(stale.map((r) => r.id)).toEqual([old.id]);
    expect(stale.map((r) => r.id)).not.toContain(fresh.id);
  });
});
```

Write `createUser`, `createPost` and `backdate` as local helpers in this file, following the helper style in `drizzle-follow.repository.test.ts`.

- [ ] **Step 5: Run it and watch it fail**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-media.repository.test.ts`
Expected: fails to resolve `./drizzle-media.repository`. **That is a load failure, not a red phase** — create the file with the port's methods throwing `new Error("not implemented")`, re-run, and confirm each test now fails on its own assertion.

- [ ] **Step 6: Write the port**

```ts
/** One media row. `postId` is null while the row is unclaimed — see the schema. */
export interface MediaRow {
  id: string;
  ownerId: string;
  postId: string | null;
  position: number;
  width: number;
  height: number;
  byteSize: number;
  createdAt: Date;
}

export interface MediaRepositoryPort {
  create(input: {
    ownerId: string;
    width: number;
    height: number;
    byteSize: number;
  }): Promise<MediaRow>;
  findById(id: string): Promise<MediaRow | null>;
  findManyByIds(ids: string[]): Promise<MediaRow[]>;
  /** In order. `position` is the index in `ids`. Rows previously on this post and absent from `ids` are UNCLAIMED, not deleted. */
  claim(postId: string, ids: string[]): Promise<void>;
  listForPost(postId: string): Promise<MediaRow[]>;
  listForPosts(postIds: string[]): Promise<MediaRow[]>;
  listUnclaimedBefore(cutoff: Date, limit: number): Promise<MediaRow[]>;
  deleteById(id: string): Promise<void>;
}
```

- [ ] **Step 7: Implement `DrizzleMediaRepository`**

`claim` runs in one transaction: set `post_id = null` for rows currently on this post, then set `post_id` and `position` for each id in `ids`. Doing it in that order means an id that is staying is simply re-claimed, and no row is ever briefly attached to two posts.

- [ ] **Step 8: Run the tests**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-media.repository.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole api suite**

Run: `cd apps/api && bun test`
Expected: the Phase 3 baseline (2045) plus the new tests, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db apps/api/drizzle apps/api/src/application/ports apps/api/src/infrastructure/repositories
git commit -m "feat(api): the post_media table and its repository"
```

---

