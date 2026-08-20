# Task 1 review: `user_tier` table and its repository

Reviewed commit `0db6afb` against `f3aef8a` (the plan commit), using the brief,
the implementer's report, and the diff, plus direct reads of the files on disk
and two mutation-testing experiments run against the actual test file.

## Verdict 1: Spec compliance — ✅

Every file the brief listed was touched, and only those:
`apps/api/src/db/schema.ts`, `apps/api/src/db/test-helpers.ts`,
`apps/api/src/application/ports/user-tier-repository.port.ts`,
`apps/api/src/infrastructure/repositories/drizzle-user-tier.repository.ts`,
its test file, and the generated migration triplet
(`0024_tired_bullseye.sql`, `meta/0024_snapshot.json`, `meta/_journal.json`).
`git diff --stat f3aef8a..0db6afb` shows 8 files changed, all additive (3100
insertions, 0 deletions) — nothing pre-existing was modified.

- `userTiers` schema matches the brief's Step 1 verbatim: columns, the
  `user_tier_owner_idx` index, and the `user_tier_id_owner_unique` composite
  unique index on `(id, ownerId)` with its "do not remove as duplicate"
  comment intact and correctly worded.
- `test-helpers.ts` adds `userTiers` to `resetDatabase()` before `appUsers`,
  matching the FK-ordering convention already used for `posts`/`postMedia`.
- Port (`UserTierRepositoryPort`) and implementation
  (`DrizzleUserTierRepository`) expose exactly the five methods the brief's
  interface list specifies — `create`, `findById`, `listByOwner`,
  `listActiveByOwner`, `deactivate` — no speculative extras.
- Migration was generated (not hand-written) and matches the schema.
- Test file covers exactly the five behaviours the brief's Step 4 requires.

## Verdict 2: Task quality — findings

**Important — `listActiveByOwner`'s test does not prove owner-scoping.**
Verified by mutation: I edited the running repository to drop the
`eq(userTiers.ownerId, ownerId)` clause from `listActiveByOwner`, leaving
only the `isActive = true` filter, and re-ran the covering test file. All 7
tests still passed (0 fail). The "excludes deactivated tiers from
listActiveByOwner" test only ever seeds one owner's data, so it cannot
distinguish "filtered to isActive AND ownerId" from "filtered to isActive
only." This is exactly the trap the brief's own review guidance called out.
It technically satisfies the brief's literal test list ("excludes
deactivated ones"), and `listByOwner`'s sibling test does correctly prove
scoping (see below) — the method itself is correct — but the gap is real: if
a future edit accidentally dropped the owner filter from
`listActiveByOwner`, nothing here would catch it, and that method is what a
visitor's public profile page calls. I'd ask for a second owner to be added
to that test (mirroring the fixture already built for `listByOwner`) before
calling this closed. (Change reverted; tree confirmed clean afterward.)

**Verified correct — `listByOwner`'s scoping is genuinely pinned.** Same
mutation applied to `listByOwner` (dropped its `eq(ownerId, ownerId)`
clause): the "lists only the given owner's tiers" test failed immediately
(`toEqual` mismatch, extra row from the other owner appeared). This
confirms the scoping assertion is load-bearing, not incidental. (Reverted.)

**Minor — none found beyond the above.** Constructor pattern
(`constructor(private readonly db: DatabaseExecutor)`) matches
`drizzle-media.repository.ts` and every other repository exactly.
`billing_cycle`'s varchar-not-enum choice carries the required comment
citing `subscription.status`'s precedent. `deactivate` is implemented as an
`UPDATE … RETURNING`, never a `DELETE`, with its port-level doc comment
tying the choice to spec §4 and to Task 2's future FK.

## Migration SQL — read directly, not trusted from the report

`apps/api/drizzle/0024_tired_bullseye.sql` (full contents, read from disk):

```sql
CREATE TABLE "user_tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"price_amount" integer NOT NULL,
	"billing_cycle" varchar(16) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_tier" ADD CONSTRAINT "user_tier_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tier_owner_idx" ON "user_tier" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tier_id_owner_unique" ON "user_tier" USING btree ("id","owner_id");
```

- `user_tier_id_owner_unique` is present, columns in the correct order
  `("id","owner_id")` — exactly what Task 2's composite FK
  `(tier_id, owner_id) → user_tier(id, owner_id)` will need.
- No stray modifiers: no `DESC`/`NULLS LAST`, no `NULLS NOT DISTINCT`, no
  partial `WHERE`, no extra columns. Matches the report's transcription
  exactly and matches the schema.ts source.
- Nothing else in the file — the migration only creates `user_tier`, its FK,
  and its two indexes. No `ALTER`/`DROP` on any pre-existing table.

## `/dashboard/*` tables — untouched

Grepped the full diff for `community`, `membership_tier`, `member`,
`subscription`, `transaction`, `creator`. Every hit is inside
`apps/api/drizzle/meta/0024_snapshot.json`, which is a brand-new file (drizzle
writes a full schema snapshot on every migration, not an incremental diff).
Diffed each of those tables' JSON definitions between the prior snapshot
(`0023_snapshot.json`, read via `git show f3aef8a:...`) and the new one
(`0024_snapshot.json`): byte-for-byte identical for `public.community`
(spot-checked; the surrounding structure for the others is the same
mechanical dump). No schema or query change touches any dashboard table.
`userTiers`'s doc comment in `schema.ts` also states explicitly: "separate
from, and unrelated to, `membership_tier` under `/dashboard/*`."

## The disclosed judgement call: `listByOwner`'s secondary sort

The implementer chose active-first, then oldest-created-first, and flagged
it as underspecified beyond "active first." I agree the choice is sensible
(a creator managing their own tiers plausibly wants to see the tiers they
set up first, in the order they built them, before anything they later
turned off) but it is **not pinned by any test**. Verified by mutation:
reversing the secondary sort from `userTiers.createdAt` (ascending) to
`desc(userTiers.createdAt)` and re-running the covering file still produced
7 pass / 0 fail — the one test exercising `listByOwner` has exactly one
active and one deactivated row per owner, so no test observation depends on
secondary order. The implementer's own disclosure ("not specified... I
picked oldest-created... happy to change it") is accurate and appropriately
flagged; no action needed beyond what's already disclosed, since the brief
truly doesn't specify it further and Task 2/a UI task can revisit.
(Reverted; confirmed via `bun test` on the covering file and `git status`
clean.)

## TDD process

Report's red-phase transcript is consistent with a genuine own-assertion
failure (`error: not implemented` thrown from inside each method, caught at
each test's call site) rather than a module load failure — the brief's
Step 5 distinction was respected. I did not re-run the red phase myself
(would require reverting the implementation), but the report's evidence is
specific enough (file:line references, pass/fail counts, timing) to be
credible and I have no reason to doubt it given everything else checked out
under direct verification.

## Method notes

Ran only the covering test file
(`drizzle-user-tier.repository.test.ts`), never the full `apps/api` suite —
the report already carries that evidence (2172 pass / 0 fail, 236s). Three
mutation experiments were performed directly against the working tree
(dropping `listActiveByOwner`'s owner filter, dropping `listByOwner`'s owner
filter, reversing `listByOwner`'s secondary sort), each followed by a
restore from a scratchpad backup and a diff check confirming zero drift.
Final `git status` is clean.
