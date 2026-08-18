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

**Commit:** see `git log -1` after this report is written — conventional-commit subject
`fix(web): reset stale per-post state, wire Edit, and pin the posts request on a profile`.
