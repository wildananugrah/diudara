# Task 1 review: the `post_media` table and its repository

Reviewed commit `5389990` (`663a359..5389990`), against `.superpowers/sdd/2026-08-18-images/task-1-brief.md` and `task-1-report.md`.

## Verdict 1: Spec compliance — ✅

Everything the brief's ten steps asked for is present, and I could not find anything extra beyond what the brief's own file list and port interface require.

- **Step 1 (schema.ts):** `postMedia` table added at `apps/api/src/db/schema.ts:892-926`, character-for-character identical to the brief's code block — columns, types, nullability, defaults, both index definitions and their comments.
- **Step 2 (migration):** `apps/api/drizzle/0023_deep_supernaut.sql` — read it directly. `post_id` carries no `NOT NULL` (nullable, correct). Both indexes present. The partial index reads `WHERE "post_media"."post_id" is null` — exactly the predicate the brief demanded, no stray `DESC NULLS LAST` or other unrequested modifier anywhere in the file. This is the one place the project previously lost a day to drizzle output, and it is correct here.
- **Step 3 (test-helpers.ts):** `postMedia` added to the truncate list at `apps/api/src/db/test-helpers.ts:97-99`, positioned before both `posts` and `appUsers` (it FKs to both), with a rationale comment matching the file's existing style.
- **Step 4 (test file):** all four tests from the brief's sketch are present in `apps/api/src/infrastructure/repositories/drizzle-media.repository.test.ts`, adapted with local `createUser`/`createPost`/`backdate` helpers as instructed. `createUser` follows `drizzle-post.repository.test.ts`'s `seedUser` shape.
- **Step 5 (red phase):** see Task quality below — present and honestly reported, with one methodological caveat (Minor).
- **Step 6 (port):** `apps/api/src/application/ports/media-repository.port.ts` is a verbatim copy of the brief's interface.
- **Step 7 (implementation):** `apps/api/src/infrastructure/repositories/drizzle-media.repository.ts` implements every port method; `claim()` follows the brief's required "release, then claim, in one transaction" order.
- **Steps 8-9 (test runs):** I independently re-ran the focused file — `4 pass, 0 fail, 8 expect() calls` — matching the report. I did not re-run the full 140-file/2049-test suite (per instructions, to avoid duplicating the report's evidence); the report's claimed baseline-plus-4 pass count is consistent with everything else I verified and I have no reason to doubt it.
- **Step 10 (commit):** single commit `5389990`, message and file scope (`apps/api/src/db`, `apps/api/drizzle`, `apps/api/src/application/ports`, `apps/api/src/infrastructure/repositories`) match the brief exactly. Nothing unrelated is staged.

Nothing extra: `findManyByIds`, `listForPosts`, and `deleteById` exist because the brief's own Step 6 port interface requires them, not because the implementer added scope. The empty-array short-circuits in `findManyByIds`/`listForPosts` are defensive one-liners inside methods the brief already required, not new surface area.

## Verdict 2: Task quality — approved, with two Minor findings and one adjudication

### The constructor deviation — adjudicated: correct, and better-grounded than the brief's own sketch

The implementer changed `DrizzleMediaRepository` from the brief's implied no-arg constructor to `constructor(private readonly db: DatabaseExecutor)`. I checked this against the actual codebase rather than taking the claim at face value:

- `apps/api/src/infrastructure/repositories/drizzle-follow.repository.ts:25`: `constructor(private readonly db: DatabaseExecutor) {}`
- `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts:65`: same.
- `apps/api/src/infrastructure/repositories/drizzle-user.repository.ts:54`: same.
- Every existing repository test instantiates with `new Drizzle...Repository(db)` (e.g. `drizzle-follow.repository.test.ts:13`, `drizzle-post.repository.test.ts:10`, `drizzle-user.repository.test.ts:12`).
- `apps/api/src/db/client.ts:16-25`: `DatabaseExecutor`'s own docstring reads *"What a repository should accept in its constructor: either the pooled client `db`, or an open transaction handle from `db.transaction(...)`... That is what lets several repositories be composed into ONE atomic unit of work... without any repository knowing it is inside a transaction."*

The codebase is unanimous, and the type's own docstring names this exact constructor shape as the house convention. This is not a harmless deviation from a brief that was otherwise right — the brief's no-arg sketch is the outlier, and the implementer's choice is the one consistent with every existing repository and with `DatabaseExecutor`'s documented purpose. Correct call.

### Mutation testing on `claim()` — the behaviour the brief most cared about is genuinely covered

I did not trust the report's test-pass claim at face value for the highest-risk method. I made two live mutations to `drizzle-media.repository.ts`, ran the focused test file against each, then reverted:

1. **Deleted the release statement** (`postId: null` update) from `claim()`, leaving only the per-id claim loop. Result: `unclaims rows that a post no longer holds` failed at `drizzle-media.repository.test.ts:79` (`listForPost` returned the stale second row) — confirms the release-before-claim ordering is load-bearing, not decorative.
2. **Replaced the release step with a "sync" pattern** that `DELETE`s rows attached to the post but absent from the new `ids` list (the exact plausible bug the brief's own test comment warns about — "asserting only its absence from the post would pass equally well against an implementation that deleted it"). Result: failed specifically at `drizzle-media.repository.test.ts:83`, the `orphan?.postId` assertion — confirming that assertion, and not just the `listForPost` check on line 79, is doing real work.

Both mutations were caught. The `claim` test is not tautological; it fails for the reasons the brief cares about. File restored to its committed state afterward, confirmed via `diff` against a backup and `git status` showing no working-tree changes.

### Findings

1. **Minor — Step 5's red-phase evidence is a single shared failure mode, not four independent ones.** The report's red-phase output shows all four tests failing because each one's *first* call is to `create()`, which throws `not implemented` — so all four fail for literally the same reason (the stub), just at four different line numbers. This satisfies the brief's actual bar (ruling out a load failure masquerading as red — each test genuinely reaches its own code in the file and fails there), but it does not by itself demonstrate that, say, `listUnclaimedBefore`'s cutoff comparison or `claim`'s position math could fail on its own terms — those paths were never stubbed-and-observed independently since `create()` always throws first. I verified this gap is closed in substance by the mutation testing above (finding above), but the report's red-phase section alone does not establish it. Not a blocker; the report is honest about the mechanism rather than overclaiming.

2. **Minor — no test exercises `claim()` across two different posts.** The release step is `where(eq(postMedia.postId, postId))`, scoped to the target post, which is correct. But every test in this file only ever creates one post, so nothing would catch a regression where the release step's `WHERE` clause was accidentally widened (e.g., to release unconditionally) in a way that happens to still pass the single-post tests. Given this repository's blast radius (a post's `claim` call must never touch another post's rows), a fifth test claiming media onto two posts and asserting the first post's rows are untouched would close this gap. Low priority since the current `WHERE` clause is correct and the single-post case is the one enumerated in the brief's sketch.

No Critical or Important findings. The migration SQL, schema, port, test-helpers ordering, and the constructor deviation are all correct and verified directly rather than taken on the report's word.
