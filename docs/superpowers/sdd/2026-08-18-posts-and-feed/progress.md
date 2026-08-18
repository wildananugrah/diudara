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

---

# CONTINUATION ON A NEW MACHINE — 2026-08-18, picked up from HANDOFF.md

Resumed at `655ba26` on `main`. **Per the user's explicit instruction this continuation works
directly on `main`, not in a worktree** — recorded because it departs from how Tasks 1-6 were built.

## Environment: 14 failures, two causes, neither of them the recorded flake family

`bun run test` was red at **2022 pass / 14 fail** on the first run here, stable across runs. The
handoff's §8 warns about the `apps/api` clock flakes and orphaned processes; **it was neither**.
Capturing the `(fail)` lines verbatim before re-running — the handoff's own advice — is what
separated them.

**Cause 1 (13 of 14) — a real hole in the test preload, of a class it already closes.** This
machine's `apps/api/.env` carries real `TELEGRAM_BOT_TOKEN` and `FONNTE_API_TOKEN` (it drives a local
bot). `test-env-preload.ts` already deletes the five `MEDIAMTX_*`/`STREAM_*` variables, arguing in
its own docstring that no test's `bootstrap()` may depend on what `.env` happens to hold — but the
messaging credentials were never added. With both set, `selectMessagingProviders` returns
`TelegramBotAdapter` + `FonnteWhatsAppAdapter`: the branch whose startup line reads *"real invites
will be issued and real messages sent"*, while `bootstrap.ts:578` states the invariant plainly —
*"the whole suite depends on the fake adapter."* Nothing enforced it. The 13 failures were the
harmless half; the same configuration hands a live bot token to any bare `bootstrap()` in 139 files.

**Ruling:** close it at the cause, in the preload, exactly as the streaming five were closed. Added
`TELEGRAM_BOT_TOKEN`, `FONNTE_API_TOKEN`, `XENDIT_SECRET_KEY`, `XENDIT_SPLIT_RULE_ID`.
`XENDIT_CALLBACK_TOKEN` deliberately EXCLUDED — it authenticates inbound webhooks and selects no
adapter, so deleting it would newly exercise the payments-disabled branch rather than close a hazard.
*Cost if wrong:* a test wanting a real adapter must now set it explicitly, which is what
`bootstrap.test.ts`'s `withEnv` already does.

**Cause 2 (the 14th) — a box-speed race, not a defect.** `routes/users.test.ts`'s "defaults to 50
rows" signs up 61 real users; each signup pays for an argon2id hash. Measured here: **224ms per hash,
3590ms for 60 concurrent** — over Bun's 5000ms default on its own, and the test failed at a
suspiciously exact ~5026ms every run. **Ruling:** an explicit 30s timeout on that one test. The
assertion is untouched. *Cost if wrong:* a genuinely slow regression in that endpoint surfaces later.

Both fixed in `af873f2`. Gate restored to **2781 pass / 0 fail** with NO environment workarounds.

## Task 6 — reviewed at last, and it was not clean

**Review (`8749868`, base `0592db2`).** Spec ❌. Three Important findings, all found by mutation:

1. **A stale delete confirmation fires a DELETE on the wrong profile.** `ProfilePage` is one route
   element, so `/@wildan` → `/@budi` keeps the instance and the "Hapus kiriman ini?" panel with it.
   Measured: clicking "Ya, hapus" on Budi's profile fired `DELETE /users/posts/p1` — wildan's post.
   `BerandaPage` fixed this exact bug at `:98-103`; Task 6 copied the panel but not the reset.
2. **`Edit` rendered but did nothing.**
3. **The task's headline claim was untested.** Replacing `listUserPosts(handle, …)` with a hardcoded
   stranger's handle left **625 pass / 0 fail** across the entire web suite.

Two further mutations survived and were classed Minor: a signed-out viewer could be treated as the
owner, and a swallowed delete error was wholly untested. A sixth finding: `(err as Error).message`
**evades** the project-wide `no-raw-server-errors` guard.

**RULING — the Edit button must be wired** (the decision HANDOFF §3.1 said was owed first). The
implementer argued scope from the plan's narrow "Consumes" list. The spec is the authority over the
plan: §7 makes the Edit/Hapus menu a property of `PostCard` **on your own posts**, not of one page,
and the goal sentence is "see someone's posts on their profile, **and edit or delete your own**". A
rendered control that does nothing is the worst of the three options. *Cost if wrong:* some
duplicated edit wiring on `ProfilePage`.

**RULING — Minors 4, 5 and 6 folded into the fix round** rather than deferred. 4 and 5 close
mutation-proven holes in the exact tests being rewritten, so the marginal cost is near zero and
deferring means a second pass over the same file. 6 is infrastructure with direct precedent: Task 4's
C1 was a hole in *this same guard*, found the same way, fixed immediately. *Cost if wrong:* a more
permissive regex — mitigated by requiring the three-direction proof Task 4 used.

**RULING — extracting a shared `useDeleteFlow` hook is DEFERRED.** Two consumers, not three;
premature abstraction is its own finding. Carry to the whole-branch review.

- Fix round 1: `3b71073`. All 7 addressed. **2790 pass / 0 fail** (+9). Typecheck clean.
- Scoped re-review: all 7 confirmed ADDRESSED by independent mutation — including the
  `key={editing.id}` line the implementer **disclosed it had written before its test**. The reviewer
  proved it three ways and found it genuinely pinned, and pinned *upstream* of the harm. The
  disclosure is what aimed the budget there; it keeps earning its keep.
- **New finding N1 from that re-review:** the `setEditing(null)` half of the new reset effect was
  unpinned — deleting the line left 25 pass / 0 fail. Harm measured, not reasoned: an edit composer
  surviving a profile change PATCHes the *previous* profile's post. Production code was correct; only
  the test was missing.
- Fix round 2: `685d07a`, **test-only** (+2 tests, no production change). **2792 pass / 0 fail.**

**Task 6: complete** (commits `8749868`..`685d07a`).

## Task 8 — the gate, run EARLY and out of order, in a real browser

Run against `3b71073`'s production code (round 2 changed only tests, so the result stands for
`685d07a`). **This is the first time anything in Phase 3 has been rendered outside happy-dom.**

**Result: 50/50 checks passed, 0 failed.** Harness in the session scratchpad (`gate.mjs`), driving
Chromium 151 via Playwright.

Environment notes for whoever runs this next:

- **Port 3000 on this machine is Grafana.** `apps/api/.env` sets `PORT=3004`, but `vite.config.ts`
  hardcodes `localhost:3000` in **8** places with no env override. The repo is internally consistent
  (`.env.example` says `PORT=3000`) — this is a LOCAL collision, not a defect, and must not be
  "fixed" by editing the real config. The gate used an untracked `apps/web/vite.gate.config.ts`
  (listed in `.git/info/exclude`) that imports the real config and rewrites only the proxy TARGET,
  leaving the proxy TABLE exactly as shipped — the table being the thing worth gating.
- **The gate API ran on 3005 with the messaging tokens blanked**, forcing `FakeMessagingAdapter` for
  both gating and notification. The pm2 instance holds live Telegram and Fonnte credentials, and a
  gate that signs up accounts must not be able to message a real person.
- **Signup returns `{"ok":true}` with no token** — you log in separately. The login response DOES
  carry the user's `id`; `/users/me` does not. That asymmetry is exactly why Task 7 must drop `id`.

What the gate proved that no unit test had:

- The Vite proxy genuinely forwards `/users/*` to the API and returns JSON, not `index.html` — the
  precise class of bug that killed six pages in the previous phase's gate.
- A post composed in a browser appears immediately AND survives a reload.
- `maxLength` is the literal 1000, typing 1001 clamps to 1000, and **no POST fires** while over.
- Pagination: exactly 20 rows on the first page, "Muat lebih banyak" exhausts correctly and
  disappears, and **53 rows / 53 distinct** — no post rendered twice across pages.
- Signed out: Untuk Anda loads, the composer is absent, and Mengikuti reads "Masuk untuk melihat"
  while firing **zero** feed requests — proven by recording actual network traffic, not by reading
  the DOM. This is §5.1, the whole reason the auth split exists.
- Edit saves, `· diedit` appears, and a delete vanishes from Beranda AND the profile AND stays gone
  after a reload. **The Edit wiring the ruling above required works end to end.**
- A visitor sees no Edit/Hapus while the owner sees 20 of each — the negative check carries a
  **positive control**, because on the gate's first run it passed *vacuously*: the account blob was
  written without `id`, `getSessionUser()` requires `id` today, so no owner controls rendered at all
  and "no Edit for a visitor" looked like a pass. Worth remembering: an absence check without a
  presence control is close to vacuous.
- Narrow (390px) shows `.bottom-nav` and hides `.side-rail`; wide (1440px) the reverse; all four nav
  destinations render at both. The CSS had never been exercised at any viewport.
- The creator dashboard still loads and is untouched.
- **The wire projection**, signed out, on both `/users/feed` and `/users/:handle/posts`: keys are
  exactly `author, body, createdAt, editedAt, id` and the author exactly `displayName, handle`. No
  `authorId`, no `deletedAt`, no `email`, no user `id`.
- **The delete is genuinely soft**: after deleting through the API the row is still in `post` with
  `deleted_at` set, absent from both read paths, and a second DELETE returns 200 — idempotent.

## Parked findings — updated

- **Reserved-handle list — SHARPENED, and the window to act is now.** The collision set is exactly
  five registerable handles: `posts`, `feed`, `signup`, `login`, `explore`. `me` (2 chars),
  `by-handle` and `password-reset` (hyphens) are **already impossible** under
  `^[a-z0-9_]{3,30}$`. The local database holds **0 `app_user` rows**, and production has no
  personal-account code deployed at all — so there is **nothing to grandfather**. This converts the
  finding from "needs a product decision that may strand existing users" into "free to do now, and
  strictly harder later." Still a product decision; carry to the whole-branch review.
- `if (editing?.id === id) setEditing(null)` in `confirmDelete` is now **dead on both pages**
  (`onDeleteRequested` clears `editing` first). Harmless; candidate for removal at whole-branch
  review. Deliberately NOT removed in the fix rounds.
- The `no-raw-server-errors` guard still cannot see `(err as any)!.message`, `(<Error>err).message`
  or `(err satisfies Error).message`. The C1-class widening keeps accreting.
- Earlier parked items from Tasks 1-5 stand as recorded above.

## Task 7 — repairing the split session

- Implementer: `e2b3a44`. **2799 pass / 0 fail** (web 643). Typecheck clean. Report `61d4f21`.

**The implementer disclosed TWO things, and both paid off.**

1. **No red phase** for the implementation — it transcribed the brief's code before writing tests, then
   recovered a red phase by reverting only the implementation files while keeping the tests. The
   review reproduced that reconstruction byte-for-byte and confirmed it honest. It also drew out a
   qualification the report did not: because `apiClient.test.ts` failed to *load* in that state, the
   four `repairSplitSession` tests never failed for their own reasons — the red phase proved the
   export was missing, not that each test discriminates. Five separate mutations closed that gap.
2. **One of the brief's prescribed mutations is a TRUE NO-OP.** `isUserSignedIn()` is
   `getUserToken() !== null`, and `repairSplitSession` re-checked `token === null` two lines later, so
   deleting the `!isUserSignedIn()` clause alone is behaviourally identical code — **unfalsifiable**.
   Confirmed independently. This is a defect in MY BRIEF, inherited from the plan.

**RULING — drop the dead clause**, keep the `token === null` return (load-bearing: it narrows
`string | null` for `setUserSession`), and comment that the token read IS the signed-in check.
*Reason:* a dead condition is not neutral — it already misled one cycle by making a prescribed
mutation unfalsifiable, and the next reviewer to mutate it would see green and wrongly conclude the
test was vacuous. *Cost if wrong:* nil; behaviour is identical and the remaining guard is pinned
(removing it reddens exactly 2 tests).

**Review: IMPORTANT 1 — the fix repaired `localStorage` but NOT the SCREEN.** The task's whole
purpose survived it. `setUserSession` calls `notify()`, but the three `getSessionUser()` consumers
are unsubscribed render-time reads, and the `useSyncExternalStore` subscribers snapshot
`isUserSignedIn()`/`getUserToken()` — **unchanged by the repair**, since the token was already there
and stays byte-identical. So every snapshot compares equal, React re-renders nothing, and the stale
`session === null` render stands. React runs child effects before parent effects, so `ProfilePage`'s
fetch is always issued first. Measured, not reasoned:

```
CONTROL (repair disabled)                → IKUTI BUTTONS: 1     ← the Phase-2 bug
REPAIR, /users/me resolves immediately   → IKUTI BUTTONS: 0
REPAIR, /users/me 40 ms slower           → IKUTI BUTTONS: 1     ← STILL BROKEN
                                            (storage correctly repaired in this case)
```

Two authenticated round-trips landing within 40 ms of each other is a coin flip, not an edge case.
**Invisible to every Task 7 test**, because all of them assert on `fetch` or `localStorage` and none
on the DOM. Fixed at the cause — one call site, a root-level state change on completion; the three
consumer screens were NOT patched, which is the explicit condition Phase 2's review attached.

- Fix round 1: `86d5668` (+ `de84e4a`). **2801 pass / 0 fail** (web 645). Typecheck clean.
- Scoped re-review: all findings + the ruling **ADDRESSED**, each by independent mutation on a named,
  reachable assertion.

**Two things from that re-review worth copying as habits:**

- **A test-integrity mutation.** Ungating `/users/me` so it resolves fast made the new test's GUARD
  fail — because with fast ordering the stale "Ikuti" never appears at all. That proves the test's
  pass depends entirely on the slow ordering and cannot silently degrade into the fast case that was
  already passing before the round. Gating on a captured `resolve`, never a `setTimeout`, is what
  makes it deterministic.
- **No harness.** The implementer rendered the REAL `App` and solved happy-dom's `about:blank`
  problem with `happyDOM.setURL`, rather than reconstructing `App`'s effect in a lookalike. Reverting
  production `App.tsx` reddens the test — which a self-contained harness could never detect. When a
  harness is avoidable, avoid it.

**Task 7: complete** (commits `e2b3a44`..`de84e4a`).

**Task 7: minor (deferred), from the re-review:** `setBrowserPath`'s `afterEach` resets the shared
happy-dom URL to `/` rather than to the original `about:blank`, so the leak is narrowed, not closed.
Nothing breaks today, but `WatchPage.tsx:62` and `dashboard/format.ts:308` both branch on
`window.location.origin`, and that branch's COVERAGE is now file-order-dependent. One-line fix.

## Task 8 — the gate, RE-RUN against the final code

**59/59 checks passed, 0 failed**, across all 13 stages at `de84e4a` — including a new
`splitsession` stage written specifically to verify Task 7 end to end:

- token present, account blob absent — the real divergent state;
- **no `.follow-button` and no button named exactly "Ikuti" on your own profile**;
- the blob rebuilt from `/users/me` with the right handle AND the right display name (not a copy of
  the handle), and **no `id` field**;
- a POSITIVE control (the profile actually rendered) and a NEGATIVE control (the same selector DOES
  find a follow control on someone else's profile).

**A false positive I created and caught, recorded because the lesson generalises.** The stage's first
locator was `:has-text("Ikuti")`, which in Playwright is a case-insensitive SUBSTRING match — it hit
the profile header's `0 Mengikuti` count link and reported the bug as still live when it was fixed.
A probe printing every matching element settled it in one run. **When an assertion about absence
fails, print what actually matched before believing it.**

## NEXT ACTION ON RESUME

The whole-branch review — the last step. Run it on the most capable model available and point it at
the parked-findings list above, including the sharpened reserved-handle decision.

**Do not run `git worktree remove` before extracting this ledger's carry-forward.** Phase 2's entire
record was destroyed that way.
