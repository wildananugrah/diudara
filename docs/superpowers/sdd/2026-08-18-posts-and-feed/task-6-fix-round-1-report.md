# Task 6, fix round 1 — report

**Base:** `af873f2` on `main`. **Files changed:** `apps/web/src/user/ProfilePage.tsx`,
`apps/web/src/user/ProfilePage.test.tsx`, `apps/web/src/user/BerandaPage.tsx`,
`apps/web/src/user/BerandaPage.test.tsx`, `apps/web/src/test/no-raw-server-errors.test.ts`. Nothing
else (`git status --short` confirmed before commit).

All seven findings from `task-6-findings.md` addressed: items 1–6 fixed and pinned by a test each;
item 7 deliberately left alone (no shared `useDeleteFlow` hook extracted).

Every gate run from the **repo root** as instructed (`bun run test`, `bun run typecheck`), never bare
`bun test`. Fast iteration used `cd apps/web && bun test src/user/ProfilePage.test.tsx` per the
brief.

---

## Item 1 — stale delete confirmation surviving a profile change

**Changed:** `ProfilePage.tsx:92-107` — a `useEffect` keyed on `[handle]` that resets
`pendingDelete`, `deleteError` (and, once item 2 landed, `editing`). Mirrors `BerandaPage.tsx:98-103`'s
own reset effect (keyed on `tab` there, on `handle` here).

**Test:** `ProfilePage.test.tsx:484` — `"drops a pending delete confirmation, so 'Ya, hapus' cannot
fire for a post from the last profile"`, in a new describe block at line 483. Added a `renderWithNav`
helper (`ProfilePage.test.tsx:63-74`) that puts `<Link>`s to `/@budi` and `/@wildan` alongside the
`/:handleParam` route — the same route element both URLs match, so React Router keeps the same
`ProfilePage` instance across the navigation, reproducing the reviewer's exact scenario.

**Red phase** (before the reset effect existed):
```
Expected: 0
Received: 1
(fail) ProfilePage — resets per-post state when the viewed profile changes > drops a pending delete
confirmation, so 'Ya, hapus' cannot fire for a post from the last profile [228.98ms]
 0 pass / 1 fail
```
(The received `1` was a real DELETE call for wildan's post, fired after navigating to Budi's profile
and clicking "Ya, hapus" there — exactly the reviewer's measured defect.)

**Implemented**, test went green (1 pass).

**Mutation — neutered the reset effect** (commented out both setters, kept the effect and its
`[handle]` dep so the shape looked unchanged):
```
(fail) ProfilePage — resets per-post state when the viewed profile changes > drops a pending delete
confirmation, so 'Ya, hapus' cannot fire for a post from the last profile [287.53ms]
 0 pass / 1 fail
```
Restored; re-ran green.

---

## Item 2 — the Edit button was a no-op

**Changed:** `ProfilePage.tsx` — imported `editPost`, `PostView`, `PostComposer`; added `editing`
state (line 75); `handleSaveEdit` (lines 109-119, deliberately **not** wrapped in try/catch, same
reasoning as `BerandaPage.handleSaveEdit`); `confirmDelete` now clears `editing` when the deleted
post was being edited (line 132); render adds the keyed `PostComposer` (lines 244-252,
`key={editing.id}`) and wires `onEdit`/`onDeleteRequested` on `PostFeed` (lines 287-302) so opening
one of Edit/Hapus closes the other (the parked Task-5 finding).

**Also fixed in `BerandaPage.tsx:223-238`** (the same parked finding, on the original file): `onEdit`
now also clears `pendingDelete`, `onDeleteRequested` now also clears `editing`.

**Tests added** (`ProfilePage.test.tsx`, describe block at line 528):
1. `:529` "opens the composer pre-filled with the post's body when Edit is tapped"
2. `:552` "saves an edit IN PLACE, keeping the row's position among the others, and shows 'diedit'" —
   three-row fixture, asserts the resulting order via a `bodies()` helper, and reads the `diedit`
   marker off `.post-card-meta` specifically (not `getByText(/diedit/)`, which also matched the edited
   body text "Sudah diedit" — caught and fixed during the red phase itself, see below).
3. `:607` "keeps the typed text in the composer when a save fails"
4. `:642` "re-fills the box when Edit is tapped on a SECOND post without cancelling the first" — the
   keyed-composer regression Beranda's own fix round 1 found.
5. `:672` "opening Edit closes an open delete confirmation, and requesting a delete closes an open
   edit composer"

Plus in `BerandaPage.test.tsx` (new test after line 810, in the existing "editing your own post"
describe): the mirror-image close-both-panels test.

**Red phase** (before any implementation — all 4 tests that exist without the key/render wiring):
```
Ignored nodes: comments, script, style
... Edit / Hapus buttons rendered, but no Simpan/composer anywhere ...
(fail) ProfilePage — editing your own post (Task 6, fix round 1 item 2) > opens the composer
pre-filled...
(fail) ... > saves an edit IN PLACE...
(fail) ... > keeps the typed text in the composer when a save fails
(fail) ... > opening Edit closes an open delete confirmation...
 0 pass / 4 fail
```
(The "re-fills the box on a SECOND edit" test was written and implemented together with the
`key={editing.id}` line — **disclosed**: that one line was not separately red/green cycled before the
test existed, only mutation-proven after the fact, below.)

One test-authoring bug caught during the red phase (not a production bug): the first draft of the
"in place" test used `screen.getByText(/diedit/)`, which after implementation matched **two**
elements (the `· diedit` meta marker AND the edited body "Sudah diedit"), throwing a
multiple-elements error rather than passing or failing cleanly. Fixed by reading `.post-card-meta`
elements specifically (`ProfilePage.test.tsx:562-563`).

**Implemented.** `bun test src/user/ProfilePage.test.tsx -t "editing your own post"`: 4 pass / 0 fail,
then after the body-selector fix: 4 pass, then all 6 (adding the SECOND-post test and the
close-both-panels test): confirmed together at 24 pass / 0 fail for the whole file.

**Mutations, each confirmed red then restored:**

1. Removed `key={editing.id}` from the composer:
   ```
   Expected: "isi dua"
   Received: "isi satu"
   (fail) ... re-fills the box when Edit is tapped on a SECOND post without cancelling the first
   ```
2. Swapped `postsFeed.current?.replace(updated)` for `postsFeed.current?.remove(updated.id)`:
   ```
   (fail) ... saves an edit IN PLACE, keeping the row's position among the others, and shows 'diedit'
   [1205.90ms]
   ```
   (row vanished instead of updating in place — `waitFor` timed out on the ordering assertion)
3. Wrapped `handleSaveEdit`'s body in a swallowing try/catch:
   ```
   (fail) ... keeps the typed text in the composer when a save fails [1228.15ms]
   ```
   (composer closed on failure instead of staying open with the alert — `waitFor` timed out)
4. Removed `setPendingDelete(null)` from `onEdit` (ProfilePage):
   ```
   Expected: 0
   Received: 1
   (fail) ... opening Edit closes an open delete confirmation...
   ```
5. Removed `setEditing(null)` from `onDeleteRequested` (ProfilePage), other direction:
   ```
   Expected: 0
   Received: 1
   (fail) ... opening Edit closes an open delete confirmation... [second half]
   ```
6. Same two mutations repeated against `BerandaPage.tsx`'s `onEdit`/`onDeleteRequested` (lines
   223-238), each confirmed red against `BerandaPage.test.tsx`'s new close-both-panels test, then
   restored. `bun test src/user/BerandaPage.test.tsx` after restoring: 33 pass / 0 fail.

All six mutations restored; `bun test src/user/ProfilePage.test.tsx`: 24 pass / 0 fail.

---

## Item 3 — nothing pinned the posts request to the profile being viewed

**Changed:** `ProfilePage.test.tsx:271-296` — the existing "renders that person's posts below the
profile header" test now records every request URL and asserts the posts request is exactly
`/users/budi/posts` (lines 291-296). No production code changed — `loadPosts` (line 90) was already
correct; only the test was blind to it.

Since the underlying behaviour was already correct, there is no "implementation" red phase for this
item — only the mutation the finding names.

**Mutation — the reviewer's own repro**, `listUserPosts(handle, before)` → `listUserPosts("orang-lain",
before)` at `ProfilePage.tsx:90`:
```
Expected: "/users/budi/posts"
Received: "/users/orang-lain/posts"
(fail) ProfilePage — posts (Task 6) > renders that person's posts below the profile header [120.34ms]
```
Restored; `bun test -t "renders that person's posts below the profile header"`: 1 pass / 0 fail.

---

## Item 4 — signed-out viewer treated as owner

**Changed:** `ProfilePage.test.tsx:298-320` — the existing "still renders the posts when signed out"
test now also asserts `queryAllByRole("button", { name: "Edit" }).length === 0` and the same for
`"Hapus"` (lines 314-319). No production change — `ownHandle = getSessionUser()?.handle ?? null` at
`ProfilePage.tsx:67` was already correct.

**Mutation — the reviewer's own repro**, `?? null` → `?? handle`:
```
Expected: 0
Received: 1
(fail) ProfilePage — posts (Task 6) > still renders the posts when signed out — listUserPosts goes
through publicGet [132.69ms]
```
(A signed-out visitor viewing Budi's profile, with a post authored by Budi, was suddenly treated as
"owning" that post — `ownHandle` defaulted to whichever profile was being viewed.) Restored; retest:
1 pass / 0 fail.

---

## Item 5 — failed delete on the profile untested

**Changed:** `ProfilePage.test.tsx:448-471` — new test "keeps the row and shows Bahasa copy when the
delete fails" in the "posts (Task 6)" describe block, copying `BerandaPage.test.tsx:571`'s shape
(delete returns a 500, asserts the exact `role="alert"` text
`"Gagal menghapus kiriman. Server sedang bermasalah. Coba lagi sebentar lagi."`, asserts the row is
still on screen, asserts the raw `"internal server error"` string never reaches the DOM). No
production change needed — `confirmDelete`'s catch block at `ProfilePage.tsx:133-134` was already
correct.

**Red phase:** none needed to write (behaviour already correct); test passed immediately (1 pass).

**Mutation — the reviewer's own repro**, `setDeleteError(...)` body → `void err`:
```
(fail) ProfilePage — posts (Task 6) > keeps the row and shows Bahasa copy when the delete fails
[1172.81ms]
```
(`waitFor` timed out waiting for the `role="alert"` paragraph — it never appeared.) Restored; retest:
1 pass / 0 fail.

---

## Item 6 — hole in the `no-raw-server-errors` guard

**Changed:** `apps/web/src/test/no-raw-server-errors.test.ts:106-124`. `readsMessageOffACaughtError`'s
regex widened from

```
`\\b${name}\\s*\\.\\s*message\\b`
```
to
```
`\\b${name}\\s*\\.\\s*message\\b|\\(\\s*${name}\\s+as\\s+[^()]+\\)\\s*\\.\\s*message\\b`
```

so a parenthesised `(<name> as <Type>).message` cast is matched alongside the original direct form.

**New unit test** at `no-raw-server-errors.test.ts:153-176` ("detects the banned pattern through an
`as` CAST between the binding and .message") — written before widening the regex.

**Red phase** (against the OLD regex):
```
Expected: true
Received: false
(fail) no raw server errors reach a member-facing screen > detects the banned pattern through an
`as` CAST between the binding and .message [1.32ms]
```

**Widened the regex; unit test suite green:** `bun test src/test/no-raw-server-errors.test.ts`: 7
pass / 0 fail.

**Verified in the three directions the finding requires, against the REAL file tree:**

**(a) Fires on `(err as Error).message`.** Mutated `ProfilePage.tsx:133-134`'s catch block to
`setDeleteError(\`${DELETE_FAILED_PREFIX} ${(err as Error).message}\`)`:
```
- []
+ [
+   "ProfilePage.tsx",
+ ]
(fail) no raw server errors reach a member-facing screen > no file under src/user reads .message off
a caught error
```
Restored; `bun test src/test/no-raw-server-errors.test.ts`: 7 pass / 0 fail.

**(b) Still fires on the plain `err.message` form.** Covered by the new unit test's `plainForm`
assertion (`try { go(); } catch (err) { setError(err.message); }` → `true`), part of the 7-pass run
above; also re-confirmed by the pre-existing "detects the hazardous pattern in both catch forms"
test, unchanged and still green.

**(c) Does NOT fire on legitimate `.message` reads off non-catch values, on the untouched tree.** The
guard's own first test, `"no file under src/user reads .message off a caught error"`, passed with
zero offenders once `ProfilePage.tsx` was restored — part of the same 7 pass / 0 fail run. The
existing "does NOT flag a component's own `.message` state field" test (unchanged) also still passes.

---

## Item 7 — deferred, not done

No `useDeleteFlow` (or similar) hook extracted. `ProfilePage.tsx` and `BerandaPage.tsx` keep their own
separate (now-both-correct) copies of the confirmation panel, `confirmDelete`, and
`DELETE_FAILED_PREFIX`, per the finding's explicit instruction.

---

## Disclosed: implementation written before its test

- The `key={editing.id}` line on `ProfilePage`'s edit composer (`ProfilePage.tsx:246`) was written in
  the same edit that wired up the rest of the Edit flow, before the dedicated
  "re-fills the box when Edit is tapped on a SECOND post" test (`ProfilePage.test.tsx:642`) existed.
  It was mutation-proven after the fact (see item 2, mutation 1) rather than red/green cycled first.
  Everything else in this round was written test-first.

---

## Final verification

No stray `bun test` processes before the run (`ps aux | grep "bun test"` — empty).

```
$ bun run test   (repo root)
@diudara/shared test:  82 pass / 0 fail  — Ran 82 tests across 4 files. [90ms]
@diudara/worker test:  38 pass / 0 fail  — Ran 38 tests across 3 files. [146ms]
@diudara/web test:    634 pass / 0 fail  — Ran 634 tests across 44 files. [19.12s]
@diudara/api test:   2036 pass / 0 fail  — Ran 2036 tests across 139 files. [212.13s]
$ echo $?
0
```

Total: **2790 pass / 0 fail** (82 + 38 + 634 + 2036) — exactly 9 more than the 2781 baseline, matching
the 9 new tests added (1 item-1 test, 5 item-2 tests on ProfilePage + 1 on BerandaPage, 1 item-5 test,
1 item-6 test). No `(fail)` lines anywhere, including none of the known `apps/api` clock-vs-`now()`
flakes (`GrantChannelAccess`, `ProcessRenewals`, `markPaid`, `markPastDue`, `touchProcessing`) this run.

```
$ bun run typecheck   (repo root)
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

`git status --short` before commit showed exactly the five intended files:
```
 M apps/web/src/test/no-raw-server-errors.test.ts
 M apps/web/src/user/BerandaPage.test.tsx
 M apps/web/src/user/BerandaPage.tsx
 M apps/web/src/user/ProfilePage.test.tsx
 M apps/web/src/user/ProfilePage.tsx
```
No route was added (`App.tsx`/`App.test.tsx` untouched), and `apps/web/src/dashboard/` was never
opened.

**Commit:** `3b71073` — conventional-commit subject
`fix(web): reset stale per-post state, wire Edit, and pin the posts request on a profile`.

---

# Fix round 2

**Base:** `3b71073`. **File changed:** `apps/web/src/user/ProfilePage.test.tsx` only — the round-1
production fix at `ProfilePage.tsx:103-107` was already correct; only the test coverage was missing.

## N1 — the `setEditing(null)` half of the reset effect was unpinned

A scoped re-review of the round-1 diff verified findings 1–7 addressed by independent mutation
(including the `key={editing.id}` line disclosed in round 1, pinned three ways). One open finding:
`ProfilePage.tsx:106`'s `setEditing(null)` — required by item 1 itself ("a reset effect keyed on
`handle`, clearing `pendingDelete`, `deleteError` — and `editing` once you add it in item 2") — had no
test exercising it. Deleting that single line left `ProfilePage.test.tsx` at 25 pass / 0 fail. The
re-reviewer's throwaway probe measured the harm: sign in as wildan, open Edit on wildan's post,
navigate to budi's profile, tap the surviving "Simpan" — a `PATCH /users/posts/p1` fires while budi's
profile is on screen.

**Added two tests** to the existing `"ProfilePage — resets per-post state when the viewed profile
changes"` describe block, right after the item-1 delete test:

1. `ProfilePage.test.tsx:527` — `"drops an open edit composer, so 'Simpan' cannot PATCH a post from
   the last profile"`. Opens Edit on wildan's own post, navigates via `renderWithNav`'s `<Link>` to
   `/@budi`, waits for budi's post to render, clicks whatever "Simpan" is still on screen (guarded —
   only if `queryByRole` finds one), and asserts on the **recorded request list**:
   `calls.filter((call) => call.init?.method === "PATCH").length` must be `0`. Deliberately does
   **not** rely on a DOM check for "Simpan absent" as the discriminating assertion — as the docstring
   at `:522-534` explains, `handleSaveEdit`'s own success path calls `setEditing(null)` regardless of
   the reset effect, so under the mutation the click still succeeds, the PATCH still fires, and the
   composer still disappears a moment later. A DOM-only assertion would have passed under this exact
   mutation, which is precisely the failure mode the coordinator flagged.
2. `ProfilePage.test.tsx:594` — `"drops a delete-error banner from the last profile too"`, covering the
   `setDeleteError(null)` half. Triggers a failed delete on wildan's own post (producing the `role="alert"`
   banner), navigates to budi's profile, and asserts `screen.queryAllByRole("alert").length` is `0`.
   This one IS a DOM assertion — appropriate here since a stale error string is a purely visual leftover
   with no request of its own to check.

**Reachability check (both tests):** each test has one guard assertion before the meaningful one (the
"Simpan" button exists right after opening Edit; the `role="alert"` exists right after the failed
delete). Both guards execute and pass under BOTH mutations below — confirmed empirically: each failing
run below reports `2 expect() calls` (not `0` or `1`), meaning the guard assertion ran and passed, and
the failure landed on the intended, later assertion, not a masked earlier one.

**Both tests green before any mutation:**
```
$ bun test src/user/ProfilePage.test.tsx -t "drops an open edit composer|drops a delete-error banner"
 2 pass
 25 filtered out
 0 fail
 4 expect() calls
Ran 2 tests across 1 file. [1138.00ms]
```

**Mutation 1 — deleted `setEditing(null)` from the reset effect** (`ProfilePage.tsx:106`), leaving
`setPendingDelete(null)` and `setDeleteError(null)` in place:
```
$ bun test src/user/ProfilePage.test.tsx -t "drops an open edit composer"
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/home/wildandev/repo/diudara/apps/web/src/user/ProfilePage.test.tsx:577:74)
(fail) ProfilePage — resets per-post state when the viewed profile changes > drops an open edit
composer, so 'Simpan' cannot PATCH a post from the last profile [261.06ms]
 0 pass / 1 fail
 2 expect() calls
```
The `Received: 1` is a real `PATCH /users/posts/p1`, fired while budi's posts are on screen — the
exact defect the re-reviewer measured.

**Mutation 2 — restored `setEditing(null)`, deleted `setDeleteError(null)`** (`ProfilePage.tsx:105`),
tested independently:
```
$ bun test src/user/ProfilePage.test.tsx -t "drops a delete-error banner"
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/home/wildandev/repo/diudara/apps/web/src/user/ProfilePage.test.tsx:613:51)
(fail) ProfilePage — resets per-post state when the viewed profile changes > drops a delete-error
banner from the last profile too [281.36ms]
 0 pass / 1 fail
 2 expect() calls
```

**Both lines restored; full file green:**
```
$ bun test src/user/ProfilePage.test.tsx
 27 pass
 0 fail
 66 expect() calls
Ran 27 tests across 1 file. [2.23s]
```
(25 baseline + 2 new tests.)

**Confirmed untouched, per the "do NOT do" list:** `confirmDelete`'s
`if (editing?.id === id) setEditing(null);` at `ProfilePage.tsx:132` — left exactly as it was, still
deferred to the whole-branch review. No shared hook extracted. The existing item-1 test's assertion
order (`ProfilePage.test.tsx:516-517`, "delete confirmation" test) was not touched.

## Final verification (round 2)

No stray `bun test` processes before the run (`ps aux | grep "bun test"` — empty).

```
$ bun run test   (repo root)
@diudara/shared test:  82 pass / 0 fail  — Ran 82 tests across 4 files. [109ms]
@diudara/worker test:  38 pass / 0 fail  — Ran 38 tests across 3 files. [159ms]
@diudara/web test:    636 pass / 0 fail  — Ran 636 tests across 44 files. [17.44s]
@diudara/api test:   2036 pass / 0 fail  — Ran 2036 tests across 139 files. [210.42s]
```
Total: **2792 pass / 0 fail** (82 + 38 + 636 + 2036) — exactly 2 more than the round-1-final baseline
of 2790, matching the 2 new tests added. No `(fail)` lines anywhere in the raw output (grepped
directly against the saved file, not piped through `tail`), including none of the known `apps/api`
clock-vs-`now()` flakes.

```
$ bun run typecheck   (repo root)
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

`git status --short` before commit showed only the one intended file:
```
 M apps/web/src/user/ProfilePage.test.tsx
```

**Commit:** see `git log -1` after this report is written — conventional-commit subject
`test(web): pin the setEditing/setDeleteError halves of ProfilePage's per-profile reset effect`.
