# Task 1 report: the `post` table and its repository

Worktree: `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`, branch `feat/posts`.

## Summary

All 10 steps completed as specified. Both syntax questions posed in the brief were verified
against the installed Drizzle version and matched the brief's syntax exactly — no deviation
required. All three soft-delete filter mutations went red individually, as required by Step 9.

## Setup note (not in the brief)

The worktree had no `node_modules` and no `apps/api/.env`. Ran `bun install` (230 packages).
`apps/api/.env` is gitignored and not shared across worktrees, so I copied the main checkout's
`apps/api/.env` into this worktree — same DB credentials, same already-running Postgres/MediaMTX
containers (`infra-postgres-1`, healthy, port 5432). No new infra was started.

## Step 2: the generated migration

```
cd apps/api && bun run db:generate
```
produced `apps/api/drizzle/0022_violet_lila_cheney.sql`:

```sql
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_live_created_idx" ON "post" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "post"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "post_author_created_idx" ON "post" USING btree ("author_id","created_at" DESC NULLS LAST);
```

Confirmed with my own eyes: `post_live_created_idx` has `DESC` on both `created_at` and `id`, and
carries `WHERE "post"."deleted_at" is null`. Nothing was missing; no regeneration was needed.

`bun run db:migrate` applied it cleanly against the running dev Postgres (two harmless NOTICEs
about the `drizzle` schema/migrations table already existing from prior migrations).

## Verifying the two "don't assume" syntax questions

Before writing `schema.ts`, I read the installed Drizzle type definitions directly
(`node_modules/.bun/drizzle-orm@0.45.2+.../drizzle-orm/pg-core/indexes.d.ts` and
`pg-core/columns/common.d.ts`) rather than trusting the brief blind:

- `ExtraConfigColumn` (what `table.createdAt` is inside an index builder callback) declares
  `desc(): Omit<this, 'asc' | 'desc'>` — so `table.createdAt.desc()` is real.
- `IndexBuilder` (returned from `.on(...)`) declares `where(condition: SQL): this` — so chaining
  `.where(sql\`...\`)` after `.on(...)` is real.

Both match the brief's syntax verbatim. `bun run typecheck` and `db:generate` both confirmed this
in practice — no adjustment to `schema.ts` was needed.

## Step 3: truncate order

Added to `apps/api/src/db/test-helpers.ts`, immediately before the `app_user` delete, matching the
existing comment style (each entry explains its FK position):

```ts
// post references app_user (author), so it must clear before app_user.
await db.delete(posts);
```

## Steps 4–8: port, tests, repository — all as specified in the brief, transcribed verbatim.

Files:
- `apps/api/src/application/ports/post-repository.port.ts` (new)
- `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts` (new)
- `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts` (new)

Step 6 (pre-implementation, confirming the test file fails for the right reason):

```
@diudara/api test: src/infrastructure/repositories/drizzle-post.repository.test.ts:
@diudara/api test: error: Cannot find module './drizzle-post.repository' from
  '.../drizzle-post.repository.test.ts'
@diudara/api test:  1961 pass
@diudara/api test:  1 fail
```

Step 8, after writing the repository, full `bun run test` from repo root:

```
@diudara/shared test:  82 pass / 0 fail
@diudara/worker test:  38 pass / 0 fail
@diudara/web test:  514 pass / 0 fail
@diudara/api test:  1970 pass / 0 fail
```

Total: **2604 pass / 0 fail** (baseline 2595 + 9 new post-repository tests; no other test's
pass/fail count moved). `bun run typecheck` from repo root: all four workspaces exit 0.

No flakes were observed on any run in this session.

## Step 9: proving the soft-delete filters are real

Each mutation below was applied alone, the suite run, output captured, then the file was restored
before the next mutation (verified via `grep -n "isNull(posts.deletedAt)"` afterward — all 5 call
sites: `updateBody`, `softDelete`, `listGlobal`, `listByAuthor`, `listFollowing` present).

### Mutation 1 — `listGlobal`: `isNull(posts.deletedAt)` → `undefined`

```
src/infrastructure/repositories/drizzle-post.repository.test.ts:
66 |     expect(await repo.listGlobal(20, null)).toEqual([]);
                                                 ^
error: expect(received).toEqual(expected)

- []
+ [
+   {
+     "authorDisplayName": "User 2",
+     "authorHandle": "user2",
+     "body": "akan dihapus",
+     "createdAt": 2026-08-17T22:47:56.453Z,
+     "editedAt": null,
+     "id": "401ee3f5-b7b8-450f-84a4-f837ee8755b9",
+   },
+ ]

- Expected  - 1
+ Received  + 10

(fail) DrizzlePostRepository soft delete > hides a deleted post from ALL THREE list paths [19.26ms]

 8 pass
 1 fail
```

### Mutation 2 — `listByAuthor`: dropped `isNull(posts.deletedAt)` from the `and(...)`

```
66 |     expect(await repo.listGlobal(20, null)).toEqual([]);
67 |     expect(await repo.listFollowing(viewer.id, 20, null)).toEqual([]);
68 |     expect(await repo.listByAuthor(author.id, 20, null)).toEqual([]);
                                                              ^
error: expect(received).toEqual(expected)

- []
+ [
+   {
+     "authorDisplayName": "User 2",
+     "authorHandle": "user2",
+     "body": "akan dihapus",
+     "createdAt": 2026-08-17T22:48:11.627Z,
+     "editedAt": null,
+     "id": "51df953d-5d19-41b4-8f37-6e6fff6b2b6c",
+   },
+ ]

- Expected  - 1
+ Received  + 10

(fail) DrizzlePostRepository soft delete > hides a deleted post from ALL THREE list paths [21.28ms]

 8 pass
 1 fail
```

### Mutation 3 — `listFollowing`: dropped `isNull(posts.deletedAt)` from the `and(...)`

```
66 |     expect(await repo.listGlobal(20, null)).toEqual([]);
67 |     expect(await repo.listFollowing(viewer.id, 20, null)).toEqual([]);
                                                               ^
error: expect(received).toEqual(expected)

- []
+ [
+   {
+     "authorDisplayName": "User 2",
+     "authorHandle": "user2",
+     "body": "akan dihapus",
+     "createdAt": 2026-08-17T22:48:27.678Z,
+     "editedAt": null,
+     "id": "d774c89b-13bc-4aa7-b3fe-65244f5ff2d5",
+   },
+ ]

- Expected  - 1
+ Received  + 10

(fail) DrizzlePostRepository soft delete > hides a deleted post from ALL THREE list paths [19.80ms]

 8 pass
 1 fail
```

**All three went red individually**, each caught by the same assertion
(`"hides a deleted post from ALL THREE list paths"`), which is exactly the test the brief's Step 5
was designed to exercise. No additional assertion was needed — the existing test already covers
all three paths in one `it`, and removing any one path's filter fails it on that path's own
`expect` line before reaching the next.

After the third mutation was restored, full `bun run test` + `bun run typecheck` were re-run
(see below) to confirm the tree was back to fully green before committing.

## Final verification (post-restore, pre-commit)

```
@diudara/shared test:  82 pass / 0 fail
@diudara/worker test:  38 pass / 0 fail
@diudara/web test:  514 pass / 0 fail
@diudara/api test:  1970 pass / 0 fail
```
Total 2604 pass / 0 fail.

```
$ bun run --workspaces typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

## Things not verified

- Whether `post_live_created_idx`/`post_author_created_idx` are actually used by Postgres's query
  planner for the three list queries (`EXPLAIN`) — not checked; the brief did not ask for it and
  correctness (not query-plan verification) was the scope of Step 9.
- No load/concurrency testing of the keyset pagination beyond the two tests in the brief.
- Nothing outside Task 1's file list was touched or reviewed (no work under
  `apps/web/src/dashboard/`, per the constraint).

## Deviations from the brief

None. The brief's table declaration, port, test file and repository implementation were
transcribed verbatim and required no changes to pass typecheck or the test suite.

## Fix round 1

Five findings from the review (C1 Critical, I2/I3/I4 Important, M5 Minor). All five addressed.
Files touched: `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts` and its test
file only — no schema/migration change was needed (see C1's disposition for why).

### C1 (Critical) — `post_live_created_idx`/`post_author_created_idx` were never used

**Diagnosis, verified independently before touching code.** Reproduced the reviewer's finding
directly against the dev Postgres (`infra-postgres-1`) inside a `BEGIN;...ROLLBACK;` transaction —
100 authors, 40,000 posts, 5% soft-deleted, `analyze`d — using the exact bare-`desc()` shape the
shipped code issued:

```
=== BEFORE: bare desc(), mismatched NULLS (the shipped Task-1 bug) — listGlobal shape ===
 Limit  (cost=1938.96..1939.01 rows=20 width=78) (actual time=15.443..15.447 rows=20 loops=1)
   ->  Sort  (cost=1938.96..2033.99 rows=38012 width=78) (actual time=15.443..15.444 rows=20 loops=1)
         Sort Key: p.created_at DESC, p.id DESC
         Sort Method: top-N heapsort  Memory: 30kB
         ->  Hash Join  (cost=8.63..927.47 rows=38012 width=78) (actual time=0.053..8.592 rows=38000 loops=1)
               ->  Seq Scan on post p  (cost=0.00..817.00 rows=38012 width=63) (actual time=0.004..3.305 rows=38000 loops=1)
                     Filter: (deleted_at IS NULL)
                     Rows Removed by Filter: 2000
 Execution Time: 15.478 ms

=== BEFORE: bare desc(), mismatched NULLS — listByAuthor shape (one specific author) ===
 Limit  (cost=377.52..377.57 rows=20 width=78) (actual time=0.196..0.199 rows=20 loops=1)
   ->  Sort  (cost=370.95..371.42 rows=190 width=78) (actual time=0.196..0.197 rows=20 loops=1)
         Sort Key: p.created_at DESC, p.id DESC
         Sort Method: top-N heapsort  Memory: 30kB
         ->  Nested Loop  (cost=9.84..365.89 rows=190 width=78) (actual time=0.050..0.159 rows=200 loops=1)
               ->  Bitmap Heap Scan on post p  (cost=9.84..357.42 rows=190 width=63) (actual time=0.032..0.120 rows=200 loops=1)
                     Filter: (deleted_at IS NULL)
                     ->  Bitmap Index Scan on post_author_created_idx  (cost=0.00..9.79 rows=200 width=0)
```

`listByAuthor` was already pulling the equality filter from the index (`Bitmap Index Scan on
post_author_created_idx`) but still paid a full `Sort` for the order — matching the reviewer's
"gets the author filter from it but still pays a top-N heapsort" exactly.

```
=== AFTER: desc nulls last, matching the index — listGlobal shape ===
 Limit  (cost=0.44..2.48 rows=20 width=78) (actual time=0.020..0.042 rows=20 loops=1)
   ->  Nested Loop  (cost=0.44..3861.54 rows=38012 width=78) (actual time=0.020..0.041 rows=20 loops=1)
         ->  Index Scan using post_live_created_idx on post p  (cost=0.29..2881.22 rows=38012 width=63) (actual time=0.012..0.014 rows=20 loops=1)
         ->  Memoize  (cost=0.15..0.17 rows=1 width=47) (actual time=0.001..0.001 rows=1 loops=20)
               ->  Index Scan using app_user_pkey on app_user u  (cost=0.14..0.16 rows=1 width=47) (actual time=0.001..0.001 rows=1 loops=20)
 Execution Time: 0.066 ms

=== AFTER: desc nulls last, matching the index — listByAuthor shape (one specific author) ===
 Limit  (cost=10.39..81.28 rows=20 width=78) (actual time=0.056..0.059 rows=20 loops=1)
   ->  Incremental Sort  (cost=3.82..677.23 rows=190 width=78) (actual time=0.056..0.057 rows=20 loops=1)
         Sort Key: p.created_at DESC NULLS LAST, p.id DESC NULLS LAST
         Presorted Key: p.created_at
         ->  Nested Loop  (cost=0.29..668.68 rows=190 width=78) (actual time=0.031..0.047 rows=21 loops=1)
               ->  Index Scan using post_author_created_idx on post p  (cost=0.29..659.73 rows=190 width=63) (actual time=0.024..0.030 rows=21 loops=1)
                     Index Cond: (author_id = $0)
                     Filter: (deleted_at IS NULL)
 Execution Time: 0.081 ms
```

`listGlobal`'s cost dropped from ~1939 to ~2.48; `listByAuthor`'s from ~377 to ~81 (`Bitmap Index
Scan` under a `Sort` became `Index Scan` under a much cheaper `Incremental Sort` — the index
doesn't carry `id`, so a tie-break sort within each author's presorted run remains, but the
expensive full sort of the whole author's row set is gone).

**Fix chosen: match the ORDER BY to the index, not the index to the ORDER BY.** Both are
semantically free (`created_at`/`id` are `NOT NULL`), so I picked the one with lower blast radius:
changing `page()`'s and `listFollowing()`'s `.orderBy(desc(posts.createdAt), desc(posts.id))` to
`.orderBy(sql\`${posts.createdAt} desc nulls last\`, sql\`${posts.id} desc nulls last\`)` (extracted
into a shared `newestFirstOrder()` helper) is a pure application-layer change — no new migration,
and it leaves migration `0022` (already reviewed byte-for-byte) untouched. Changing the index
instead would have required a second generated migration for no additional benefit, since neither
option changes result rows.

**Proving the test can see it.** A first draft of the proof test hand-wrote its own `EXPLAIN`
SQL matching the *intended* query shape — exactly the trap this finding is about: mutating
`newestFirstOrder()` back to the bug left that draft at **18 pass / 0 fail**, because the test
never actually ran the repository's own generated SQL. Rewrote it to capture the query via
drizzle's own (non-executing) `.toSQL()` on the un-awaited return of `listGlobal`/`listByAuthor`
(both are non-`async` methods that return the lazy query-builder chain itself), then ran
`EXPLAIN` through `postgres.js`'s `.unsafe(text, params)` against the exact SQL text and bound
parameters the shipped repository produces — same idea as `DrizzleFollowRepository.follow`'s ON
CONFLICT test (`f6c2f6c`), which captures real SQL rather than a hand copy for the same reason.

With that fixed, re-mutating `newestFirstOrder()` back to bare `desc()` (no `nulls last`) now goes
red, against the **real** shipped SQL:

```
error: expect(received).not.toContain(expected)

Expected to not contain: "Seq Scan on post"
Received: "Limit  (cost=488.04..488.09 rows=20 width=75)
  ->  Sort  (cost=488.04..511.79 rows=9500 width=75)
        Sort Key: post.created_at DESC, post.id DESC
        ->  Hash Join  (cost=4.25..235.24 rows=9500 width=75)
              Hash Cond: (post.author_id = app_user.id)
              ->  Seq Scan on post  (cost=0.00..205.00 rows=9500 width=62)
                    Filter: (deleted_at IS NULL)
              ->  Hash  (cost=3.00..3.00 rows=100 width=45)
                    ->  Seq Scan on app_user  (cost=0.00..3.00 rows=100 width=45)"

(fail) the indexes post reads go through > plans listGlobal and listByAuthor WITHOUT a sequential scan of post [170.54ms]

 17 pass
 1 fail
```

Restored; full file back to 18 pass / 0 fail. The new describe block `"the indexes post reads go
through"` also carries two `pg_indexes`-based existence/column-order assertions (matching
`drizzle-follow.repository.test.ts`'s "the indexes profile reads go through" shape) alongside the
`EXPLAIN` usage proof (matching `schema-phase5.test.ts`'s "the indexes Phase 5's hourly passes
read through" shape, which is the one that actually proves *usage* rather than mere existence —
the two established precedents cover different halves of this finding, so I used both).

### I2 (Important) — `desc(posts.id)` tiebreaker unasserted on both list paths

The existing "orders by id when two posts share a created_at" test (3 rows, ids assigned in
ascending insertion order, expecting descending output) turned out to pass BY COINCIDENCE even
with the id tiebreaker fully removed — a small top-N heapsort's tie handling happened to emit the
same order a real `ORDER BY id` would. Added a discriminating test instead: 24 posts sharing one
timestamp, ids assigned so rank 0 is numerically largest, but INSERTED in a shuffled permutation
(`(i * 7) % 24`) that matches neither ascending nor descending id order — so neither "preserve
insertion order" nor "reverse it" (the two ways a small sort's tie-break can coincidentally look
correct) can produce the exact expected sequence. One version added to the `page()`-backed
pagination describe block (exercised via `listGlobal`, which shares `page()` with `listByAuthor`),
one added to `listFollowing`'s own describe block, since that is a structurally separate call
site.

Mutation 1 — `page()`'s `orderBy` reduced to `sql\`${posts.createdAt} desc nulls last\`` only (id
dropped):

```
error: expect(received).toEqual(expected)
  [
-   "rank-0", "rank-1", "rank-2",
+   "rank-17", "rank-10",
    "rank-3",
-   "rank-4", "rank-5",
+   "rank-20", "rank-13",
    ... (17 mismatched positions total)
  ]
(fail) DrizzlePostRepository keyset pagination > breaks a WIDE same-timestamp tie strictly by id — page()'s own tiebreaker, not luck [34.86ms]

 17 pass
 1 fail
```

Restored (18/0). Mutation 2 — `listFollowing`'s `orderBy` reduced the same way — same failure
signature, same test name for its own describe block:

```
error: expect(received).toEqual(expected)
  [ ... identical 17-position mismatch pattern ... ]
(fail) DrizzlePostRepository.listFollowing > breaks a WIDE same-timestamp tie strictly by id — listFollowing's own tiebreaker, not luck [31.68ms]

 17 pass
 1 fail
```

Restored (18/0). Both went red independently.

### I3 (Important) — the post projection was defended on only 1 of 3 select sites

Added an explicit `Object.keys(row).sort()` assertion (matching the exact-key-set idiom the
`create()` test already used) to one row from each of `listGlobal`, `listByAuthor` and
`listFollowing` — the two the existing tests only ever inspected with `.map(row => row.body)` or
`toEqual([])`, neither of which can see an extra key.

Mutation — `page()`'s `select(postColumns)` widened to
`select({ ...postColumns, authorId: posts.authorId, deletedAt: posts.deletedAt, email: appUsers.email })`
(this is the SHARED helper behind both `listGlobal` and `listByAuthor`, so one mutation exercises
both):

```
error: expect(received).toEqual(expected)
@@ -3,8 +3,8 @@
    "authorHandle",
+   "authorId",
    "body",
    "createdAt",
+   "deletedAt",
    "editedAt",
+   "email",
    "id",
(fail) DrizzlePostRepository projection on every list path > listGlobal rows carry only the public post fields [13.83ms]
(fail) DrizzlePostRepository projection on every list path > listByAuthor rows carry only the public post fields [12.07ms]

 16 pass
 2 fail
```

Restored (18/0). Mutation — `listFollowing`'s own `select(postColumns)` widened the same way:

```
error: expect(received).toEqual(expected)
@@ -3,8 +3,8 @@
    "authorHandle",
+   "authorId",
    "body",
    "createdAt",
+   "deletedAt",
    "editedAt",
+   "email",
    "id",
(fail) DrizzlePostRepository projection on every list path > listFollowing rows carry only the public post fields [14.71ms]

 17 pass
 1 fail
```

Restored (18/0). All three list paths now independently caught a projection leak.

### I4 (Important) — `clampLimit` unasserted at `listFollowing`'s own call site

Added a test mirroring the existing `listGlobal(-1, null)` one, through `listFollowing` instead,
seeding exactly one followed post so an unclamped `-1` (which drizzle passes straight through,
silently dropping the `LIMIT` clause) returns that one row instead of `[]`.

Mutation — `listFollowing`'s `.limit(clampLimit(limit))` replaced with `.limit(limit)`:

```
error: expect(received).toEqual(expected)
- []
+ [
+   {
+     "authorDisplayName": "User 16",
+     "authorHandle": "user16",
+     "body": "satu juga",
+     "createdAt": 2026-08-17T23:16:16.612Z,
+     "editedAt": null,
+     "id": "c865893b-3501-470f-94dd-b586e82bf159",
+   },
+ ]
(fail) DrizzlePostRepository.listFollowing > also clamps a nonsensical limit rather than returning the whole table [15.20ms]

 17 pass
 1 fail
```

Restored (18/0).

### M5 (Minor) — `softDelete`'s comment contradicted its own code

The comment claimed "No `isNull` guard" while the `WHERE` clause on the very next lines has one.
Rewrote it to describe the actual (better) behaviour: the guard means a repeat call matches zero
rows and is a true no-op, leaving the ORIGINAL `deleted_at` untouched — not "re-stamping something
unobservable" as the old comment (copied verbatim from the brief) claimed. No test change; this
was a comment-only correction, verified by re-reading the method against the new comment's claims.

### Final verification after all five fixes

```
$ cd apps/api && bun test src/infrastructure/repositories/drizzle-post.repository.test.ts
 18 pass
 0 fail
 34 expect() calls
Ran 18 tests across 1 file. [843.00ms]
```

Root gates, from the repo root:

```
@diudara/shared test:  82 pass / 0 fail
@diudara/worker test:  38 pass / 0 fail
@diudara/web test:  514 pass / 0 fail
@diudara/api test:  1979 pass / 0 fail
```
Total **2613 pass / 0 fail** (was 2604 before this round; +9 new tests, 0 regressions,
0 count changes anywhere outside `apps/api`).

```
$ bun run --workspaces typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

### Housekeeping note

All C1 diagnostic queries (the 40k- and 10k-row bulk seeds used for manual `EXPLAIN` verification
against the shared dev Postgres, `infra-postgres-1`) were run inside `BEGIN;...ROLLBACK;` and
confirmed to leave no residue afterward (`select count(*) from app_user where handle like
'bulkpost%'` → 0, same for `post`). The in-suite bulk seed (100 authors / 10,000 posts) runs
against the per-test-run isolated database created by the test preload, and is cleared by the next
test file's `resetDatabase()` like everything else.

### Things not verified in this round

- Whether `post_author_created_idx`'s remaining `Incremental Sort` (the index doesn't carry `id`,
  so a per-author tie-break sort remains even after the fix) ever shows up as a measurable cost at
  production scale. Out of scope for C1 as stated — the finding asked to prove an Index Scan is
  used, not to eliminate every sort node — and the EXPLAIN evidence above shows the cost dropping
  by roughly 5x regardless (377 → 81).
- Not in scope, per the coordinator's message: the single test covering three soft-delete paths
  (Step 9, Task 1) still short-circuits on first failure. Recorded, not fixed.
