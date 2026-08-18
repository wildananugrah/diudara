# SDD ledger — plan: docs/superpowers/plans/2026-08-18-posts-and-feed.md

Phase 3 of the DIUDARA pivot: posts and a feed.

- Worktree: `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`, branch `feat/posts`
- Base: `ba09e4b` (on `main`, which already contains Phases 1 and 2)
- Baseline before Task 1: **2595 pass / 0 fail** (shared 82, worker 38, web 514, api 1961)
- **This workspace lives in the MAIN repo, not in the worktree** — deliberately. Phase 2's ledger
  and all four of its review reports were destroyed by `git worktree remove` because they sat inside
  the worktree. Keeping it here means the record survives cleanup.

## Pre-flight scan

No conflicts between tasks or against the Global Constraints. Two deliberate decisions an
implementer or reviewer might mistake for defects, recorded here so neither is re-litigated:

- `EditPost` has a private `requireOwn` while `DeletePost` repeats the two checks inline. Deliberate:
  `EditPost` needs the returned `owned` to test `isDeleted`, `DeletePost` does not. A shared
  module-scope helper is acceptable; a base class is not.
- Task 5 Step 4 deliberately leaves ONE decision open (how a just-created post avoids appearing twice
  after a tab switch) with two acceptable answers and a required test. That is a decision point, not
  a placeholder.

## Tasks

### Task 1 — the `post` table and its repository

- Implementer: `265c499`, 2604 pass / 0 fail (api 1970, +9). Migration `0022_violet_lila_cheney.sql`.
  Verified `DESC` on both index columns and `WHERE "deleted_at" is null`; `meta/` committed; no
  `.env` or `node_modules` in the commit; `apps/web/src/dashboard/` untouched.
- Review: spec ✅. Quality: 1 Critical, 3 Important, 2 Minor, from 12 mutations.
- Fix round 1 dispatched (see below for the rulings).

**A PLAN DEFECT, MINE, recorded so it is not repeated.** The brief told the implementer to declare
the index with `.on(table.createdAt.desc())` and to order with `desc(posts.createdAt)`. Drizzle emits
`DESC NULLS LAST` for the first and plain `DESC` (= `NULLS FIRST` in Postgres) for the second, so the
pathkeys do not match and **the index cannot serve the ordering at all**. Measured: Seq Scan over
38,000 live rows plus a top-N heapsort, `idx_scan: 0`, and the plan does not change with
`enable_seqscan=off; enable_sort=off` — so it is structural, not a statistics artefact. Both new
indexes were affected. My Step 2 asked the implementer to check the migration for a modifier Drizzle
might have **dropped**; the killer was one it **added**.

**Nothing in the suite could see it**: the reviewer deleted BOTH indexes from the migration SQL and
the whole api workspace still passed 1970/0. The fix round therefore requires an `EXPLAIN`-based
test, matching the index proof the follow phase added in its own first review round.

Findings sent to the fix round: C1 (the index), I2 (`desc(posts.id)` unasserted on both list paths —
removing it left 9 pass/0 fail), I3 (the projection defended on 1 of 3 select sites — adding
`authorId`, `deletedAt` and `email` to two of them left 9 pass/0 fail), I4 (`clampLimit` unasserted
in `listFollowing`), M5 (the `softDelete` comment contradicts its code — inherited from my brief).

**Task 1: minor (deferred):** one test covers three soft-delete paths sequentially, so the first
failing `expect` short-circuits and a single run can never reveal more than one broken path. Each
path IS individually detected; this is diagnosis speed, not coverage.

**Explicitly ruled NOT a finding:** `create()` throwing a bare `Error` on an impossible read-back is
correct and matches four existing repositories — `AppError` subclasses carry HTTP statuses and would
misrepresent an internal bug as a client-visible outcome.

- Fix round 1: `0c69083`. All five addressed, **2613 pass / 0 fail** (api 1979, +9 more tests).
- Scoped re-review: all five confirmed by independent mutation. **Task 1: complete.**

C1's fix matches the ORDER BY to the index (`sql\`created_at desc nulls last\``) rather than the
index to the ORDER BY, so no new migration was needed and `0022` is byte-identical.

**The EXPLAIN proof test is worth knowing about before anyone writes another one.** The implementer's
FIRST attempt hand-wrote its own EXPLAIN SQL and passed 18/0 even with the bug reintroduced — a test
that could not detect the defect it existed for. It rewrote it to explain the **real shipped SQL**
via drizzle's `.toSQL()` plus `postgres.js` `.unsafe()`. The re-review confirmed this by reproducing
the original reviewer's scenario: deleting both `CREATE INDEX` statements from
`0022_violet_lila_cheney.sql` now fails 3 tests where it previously left the whole api workspace
green at 1970/0.

### Task 2 — use cases, the shared limit, and the API routes

In flight with implementer `acfb5af646f6095e7`. A connection drop cut the first attempt off partway;
the work was intact and uncommitted at HEAD `0c69083`, with everything written except
`routes/posts.test.ts`, the three Step-10 mutations and the commit. The same agent was resumed from
its transcript rather than restarted, and told to re-read what is on disk rather than trust its
memory of it.

`ForbiddenError` confirmed absent from `errors.ts` before this task — it is this codebase's first
403. `errorHandler` already maps any `AppError` by its own `status`, so no handler change is needed;
route tests must assert the **status code**, not the class.

- Implementer: `97e4d77`, api 2029 (+50). Typecheck clean. No migration, correctly.
- Review: **spec ❌**, 2 Critical, 3 Important, 2 Minor. Fix round 1 dispatched.

**C1 — a real production defect.** `postRoutes` was mounted before `userRoutes`, which makes
`/:handle/posts` shadow `/by-handle/:handle` and `/posts/:id` shadow `/:handle/follow`. Nothing
reserves handles (`domain/handle.ts:2` is `/^[a-z0-9_]{3,30}$/`), so a user may register the handle
`posts` — and then their profile is permanently 404 (`apiClient.ts:437` calls `/by-handle/`) and they
can be followed but never unfollowed (`DELETE` 500s). Measured against the real app. Ruling: mount
`userRoutes` first.

**C2 — the report asserted the opposite, and so did a code comment.** Both said "no shape collides,
mount order is non-load-bearing — not a claim, a test". The reviewer swapped the two lines and the
whole api suite passed 2029/0. The test at `routes/posts.test.ts:352` builds its OWN throwaway app
and asserts two shapes that never collided either way, so it can never fail because of `app.ts`. This
is the **fourth** report on this project to assert something untrue; the fix must correct the report
itself, not only append to it.

Also sent: I3 (a malformed post id 500s — ruled 400, matching the malformed-cursor precedent),
I4 (the probe-row boundary is untested — `>` → `>=` left the api workspace green at 2029/0), I5 (the
route's Zod measures the RAW body while `requireBody` trims, so a 1000-char body with surrounding
whitespace is accepted by one and rejected by the other — ruled: the schema trims too), M6 (three
missing route tests, all verified by probe but unpinned).

**Task 2: minor (deferred): there is no reserved-handle list.** With the mount order corrected
nothing breaks, so it is a latent hazard rather than a defect. It needs a real decision — existing
accounts may already hold such handles — and `app.ts:51` already records the same gap for community
slugs. **Phase 4 or later should decide it.**

- Fix round 1: `53fb863`. All seven addressed. **2670 pass / 0 fail** (shared 82, worker 38, web 514,
  api 2036). Typecheck clean.
- Scoped re-review: confirmed independently. Swapping the two `app.route("/users", ...)` lines now
  fails **1 test out of 2036** — and it being the only failure across the whole workspace is itself
  the proof that the test drives the real `createApp` composition root rather than a lookalike.
  **Task 2: complete.**

**Flake sighting during Task 2's re-review, not captured.** Three `GrantChannelAccess` failures that
vanished on re-run; the reviewer described them rather than pasting them. **Correction to an earlier
note here: this is NOT a new family** — `GrantChannelAccess` is already recorded in the flake memory,
both as sighting 4 and in the list of twelve. Task 3's review then captured it verbatim (below), so
nothing is outstanding.

### Task 3 — the relative-time formatter and `PostCard`

- Implementer: `6bf02f2`, **2691 pass / 0 fail** (web 535, +21). Typecheck clean.
- Review: spec ✅, quality **approved**. No fix round. 10 mutations, none survived.

The review added one mutation the implementer had not run — passing the whole post to `onDeleted`
instead of its id — which confirms the test asserts the **argument**, not merely that the callback
fired. Worth copying as a habit: a callback test that only counts calls is close to vacuous.

The source-scan tests (no `viewerFollows`, no `dangerouslySetInnerHTML` in `PostCard`) were verified
in **both** directions: real usages of each make them go red, and the file's own docstring — which
necessarily names both strings in prose — does not. A comment-stripping scan can strip too much;
this one does not.

**Flake family confirmed and captured, 2026-08-18.** Ten `apps/api` failures in one run under
concurrent mutation load, including three `GrantChannelAccess` tests, all clearing on two isolated
re-runs. Verbatim output is in Task 3's review and has been added to the flake memory. Same
signature as every prior sighting: CPU contention widening the Bun-clock-versus-Postgres-`now()` gap.

### Task 4 — `PostFeed` with keyset pagination

- Implementer: `3121443`, **2709 pass / 0 fail** (web 553, +18). DONE_WITH_CONCERNS; **both concerns
  it raised were upheld by the review.**
- Review: spec ✅. Quality: 1 Critical, 2 Important. Fix round 1 dispatched.

**C1 — a hole in a project-wide guard, found because this task was the first file to trip it.**
`no-raw-server-errors.test.ts:80`'s regex requires the catch binding to be followed immediately by
`)`, so `catch (err: unknown)` does not match. `PostFeed.tsx` is the only file under `src/user/`
written with a **type-annotated** catch; every other one uses a bare `catch (err)`. Proved: the exact
banned pattern inserted into that catch block left the guard at **5 pass / 0 fail**. The guard covers
every file under `src/user/`, so this is infrastructure, not a task defect — and any future file
written with a typed catch would have inherited the hole silently.

**I2 — the auth-split tests asserted the one property that cannot distinguish the two paths.**
`publicGet` and `apiFetch` both attach the token via `authorizedHeaders`, so header presence proves
nothing about which was used. The real difference is 401 handling. Swapping `untuk-anda` from
`publicGet` to `apiFetch` left the whole web suite green at 553/0. The fix must assert that a 401 on
`untuk-anda` leaves `isUserSignedIn()` true while a 401 on `mengikuti` clears it.

**I3 — MY BRIEF'S DEFECT.** Its `PostFeed` sample renders the error `<p>` without `role="alert"`,
while all eight other request-failure elements under `src/user/` carry it. The implementer copied the
sample as instructed, flagged the inconsistency rather than silently diverging, and was right.

**Carried to Task 5:** a signed-out visitor hitting `mengikuti` would see the generic
"Sesi Anda sudah berakhir" rather than the server's specific message. Task 5's design makes that
path unreachable (the UI renders "Masuk untuk melihat" and sends nothing), so Task 5 must confirm it.

- Fix round 1: `8a5568f`. All three addressed. **2713 pass / 0 fail** (web 557). Typecheck clean.
- Scoped re-review: confirmed by independent mutation in all directions. **Task 4: complete.**

C1's widened regex was verified in **three** directions, not two: it fires on the banned pattern in a
typed catch, it still fires in an untyped one (ruling out a regex that now matches nothing and passes
vacuously), and it does not fire on the legitimate `.message` reads that five existing files make off
non-catch values.

**A MASKED ASSERTION, found by the implementer on re-scrutiny and confirmed by the re-review.** The
"drop `before`" test's URL assertion was **unreachable**: an earlier `getByText` assertion in the same
test failed first, so the URL check never ran. The counterfactual was run explicitly — with the
original ordering the failure is `Unable to find an element with the text: Isi kiriman 1`, and the
URL line is never reached. Worth generalising: **an assertion after another assertion in the same
test is only coverage if everything before it can pass.** This one looked like coverage for a whole
review cycle.

### Task 5 — Beranda's two tabs, and composing, editing and deleting

- Implementer: `f8e7ad4`, **2754 pass / 0 fail** (web 598, +41). DONE_WITH_CONCERNS.
- Review (21 mutation groups): spec ✅. Quality: 3 Important, 7 Minor, nothing Critical. Fix round 1
  dispatched.

**The implementer disclosed there was NO RED PHASE** for `PostComposer` or `BerandaPage` — code
written before tests, all 23 Beranda tests green on first run. It compensated with four extra
mutations and said so. The review weighted its budget accordingly, and **all three Important
findings landed exactly there.** Worth repeating on later tasks: a self-declared missing red phase is
the most useful thing an implementer can put in a report.

**TWO MORE DEFECTS IN MY BRIEFS, both upheld:**

1. The brief prepended a newly created post into the **Mengikuti** feed. `listFollowing` returns
   followed authors' posts and never the viewer's own — enforced by a **database CHECK constraint**
   (`check("follow_no_self", …)`, `0021_sour_weapon_omega.sql:6`), not by convention. The row would
   vanish on the next refetch. The implementer substituted a Bahasa notice.
2. `PostCard`'s `onDeleted` fires **on the tap**, not after a delete, while its docstring asserts
   "the row is gone once this fires". That sentence is what a Task 6 implementer would read and
   trust, wiring a list removal to a callback that fires before the server has done anything.
   **Ruled: rename to `onDeleteRequested` before Task 6 consumes it.**

Also corrected: my brief predicted an unmemoised `load` produces "Maximum update depth exceeded". It
does not — it fails fast in 2.9s with 4 reds. The memoisation is still pinned.

**The three Important findings, all invisible to a green suite:**

- `PostFeedHandle.remove(id)` **ignores its id** — replacing the filter with `slice(1)` left 598/0
  across all 44 web files, because every delete test uses a one-row fixture. Real consequence: tap
  Hapus on the second of three posts and the **first** disappears.
- `replace`'s documented "IN PLACE — the row keeps its position" is unpinned for the same reason.
- The "Kiriman Anda terkirim" notice **never clears** — `sentFrom` is only reset by a successful
  untuk-anda create, so switching away and back re-displays it, telling the viewer a post was just
  sent when nothing was.

`PostFeed.test.tsx` has **zero direct tests for the handle**, which is why the first two survived.
Closing that is a precondition for Task 6.

**Task 5: minor (deferred):** a create racing the first page load can drop the prepended post from
view (the post is saved) — now measured rather than reasoned, judged not worth a queue.

- Fix round 1: `0592db2`. All addressed. **2774 pass / 0 fail** (web 618, +20). Typecheck clean.
- Scoped re-review: every fix confirmed by independent mutation. **Task 5: complete.**

The implementer recorded **two of its own mistakes mid-round rather than burying them**: a mutation
using an unanchored substitution that also hit an unintended function, producing a red from the wrong
place; and a first harm-test for `key={editing.id}` that **survived** the mutation because it retyped
the body before saving. Rewritten to submit without retyping, it prints
`Expected: "isi dua" / Received: "isi satu"` sent to `/users/posts/p2` — the silent overwrite.

**Accepted trade, recorded.** `signedIn` now comes from `useSyncExternalStore`, so when Mengikuti's
401 clears the session the visitor sees `Masuk untuk melihat` **instead of**
`Sesi Anda sudah berakhir`. More actionable, less explanatory. Carrying both would need a
"was signed in a moment ago" state; judged not worth it. Ruled: keep.

**Task 5: minor (deferred), from the re-review:**
- `BerandaPage.test.tsx:456`'s final assertion (no DELETE fired) is **unreachable** — the panel's
  visibility and `pendingDelete` share one conditional, so any mutation leaving the state set trips
  the earlier text assertion at `:453` first. Documents intent; not load-bearing. Pre-existing test
  structure, not a regression.
- `onEdit` and `onDeleteRequested` each clear `deleteError` but neither clears the other's state, so
  tapping Hapus then Edit renders the edit composer **and** the "Hapus kiriman ini?" panel at once.
  Predates fix round 1 (`git show f8e7ad4` confirms the shape).

## NEXT ACTION ON RESUME

Task 6 — posts on the profile. Base for its review package is `0592db2`. Base for its review package is `53fb863`.

**Do not run `git worktree remove` before extracting this ledger's carry-forward.** Phase 2's entire
record was destroyed that way. This workspace lives in the main repo precisely so that cannot happen
again, but the habit is what matters.
