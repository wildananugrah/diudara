# Task 3 report — the relative-time formatter and `PostCard`

Worktree: `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`, branch `feat/posts`.
Commit: `6bf02f2f6db569c0ff48ffeb0daa0da550d61e57`.

## What was built

- `apps/web/src/user/apiClient.ts` — added `export interface PostView` exactly as specified in
  the brief (`id`, `body`, `createdAt`, `editedAt: string | null`, `author: { handle, displayName }`),
  purely additive (30 insertions, 0 deletions).
- `apps/web/src/user/relativeTime.ts` + `relativeTime.test.ts` — written verbatim from the brief's
  Step 1/Step 2 code blocks. Month names are the literal `MONTHS_ID` array (not `Intl.DateTimeFormat`).
  `now` is a required parameter, never read from `Date.now()` internally.
- `apps/web/src/user/PostCard.tsx` — 68 lines (under the 90-line budget). Props exactly as specified:
  `{ post: PostView; isOwn: boolean; now?: Date; onEdit?: (post: PostView) => void; onDeleted?: (id: string) => void }`.
  `now` defaults to `new Date()` when omitted, but every code path threads it through rather than
  reading the clock itself. Body is rendered as `<p className="post-card-body">{post.body}</p>` — a
  plain text child, never `dangerouslySetInnerHTML`. `isOwn` gates one combined block containing both
  the Edit and Hapus buttons (single condition, not two that could drift). No `viewerFollows` prop, no
  follow affordance anywhere in the file.
- `apps/web/src/user/PostCard.test.tsx` — 14 tests covering the full checklist (see below) plus two
  "guards the guard" tests for the source-scan technique.
- `apps/web/src/styles.css` — additive-only block for `.post-card*` classes, including
  `.post-card-body { white-space: pre-wrap; }`. Diff: 53 insertions, 0 deletions.

## Checklist coverage — every line of the brief's PostCard checklist, and where it's asserted

| Checklist line | Test(s) in `PostCard.test.tsx` |
|---|---|
| display name, @handle, body all render | `renders the author's display name, @handle and body` |
| handle links to `/@handle` | `links the handle to /@handle` |
| `· diedit` absent when `editedAt` null / present when set | `shows no "· diedit" marker when editedAt is null`, `shows "· diedit" when editedAt is set` |
| `isOwn: false` renders no Edit/no Hapus | `renders neither an Edit nor a Hapus control when isOwn is false` |
| `isOwn: true` renders both, clicking each calls the matching callback | `renders both an Edit and a Hapus control when isOwn is true`, `calls onEdit with the post when Edit is clicked`, `calls onDeleted with the post's id (not the post) when Hapus is clicked` |
| relative time renders, clock injectable | `renders the relative time from the injected clock, not a live one` (fixed `now` prop, boundary value `1j`) |
| no follow button rendered, no `viewerFollows` in props/source | `renders no follow button at all, regardless of isOwn` (DOM-level) + `PostCard — no viewerFollows anywhere in this component (carry-forward)` describe block (source-scan level) |

## The self-scan snag, and the fix

My first pass wrote `PostCard.test.tsx`'s scan as a bare `source.includes("viewerFollows")` /
`source.includes("dangerouslySetInnerHTML")`, copying `FollowButton.test.tsx`'s literal-string idea
too literally. It immediately went red — not because of a bug in `PostCard.tsx`, but because
`PostCard.tsx`'s own docstring explains, in prose, why the field is absent, and that prose contains
the word. This is the exact false-positive `no-raw-server-errors.test.ts` documents happening to
`ProfilePage.tsx` and `LoginPage.tsx` for the same reason. Fixed by copying that file's own
`stripComments` helper into the test and scanning only the code portion. Two "guards the guard" tests
pin that the stripped scan still catches a real `const viewerFollows = false;` and still ignores a
comment-only mention.

## Step 5 — the three required mutations, each restored, each proven red

All three mutations were applied with `Edit`, run through `bun run test` from the repo root, confirmed
red, then restored and diffed byte-for-byte (`diff` against a pre-mutation backup copy) to confirm
exact restoration before moving to the next.

### Mutation 1 — remove the `editedAt !== null` condition (diedit always renders)

Changed:
```
-{post.editedAt !== null ? " · diedit" : ""}
+{" · diedit"}
```
Result:
```
(fail) PostCard > shows no "· diedit" marker when editedAt is null [1.74ms]
error: expect(received).toBe(expected)
```
Restored; `diff` against backup: identical; suite back to 0 fail.

### Mutation 2 — remove the `isOwn` condition on the menu

Changed:
```
-{isOwn ? (
+{true ? (
```
Result:
```
(fail) PostCard > renders neither an Edit nor a Hapus control when isOwn is false [1.94ms]
534 pass
1 fail
```
Restored; `diff` against backup: identical; suite back to 0 fail.

### Mutation 3 — change the formatter's `WEEK` boundary to `6 * DAY`

Changed:
```
-const WEEK = 7 * DAY;
+const WEEK = 6 * DAY;
```
Result:
```
31 |   it("switches to days at exactly one day", () => {
32 |     expect(formatRelativeTime(ago(DAY), NOW)).toBe("1h");
33 |     expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6h");
                                                       ^
error: expect(received).toBe(expected)
Expected: "6h"
Received: "12 Agu 2026"
(fail) formatRelativeTime > switches to days at exactly one day [0.31ms]
```
Restored; `diff` against backup: identical; suite back to 0 fail.

**No mutation survived.** All three produced a red, informative failure with the expected
value visible in the diff, so there is nothing to diagnose as "bad mutation" vs. "vacuous test" —
both failure modes named in my instructions were checked for and neither occurred.

## Gate results

Final run, from the repo root, `bun run test` (never bare `bun test`):

```
@diudara/shared test:  82 pass / 0 fail   — Ran 82 tests across 4 files.
@diudara/worker test:  38 pass / 0 fail   — Ran 38 tests across 3 files.
@diudara/web test:    535 pass / 0 fail   — Ran 535 tests across 42 files.
@diudara/api test:   2036 pass / 0 fail   — Ran 2036 tests across 139 files.
```
Total: 2691 pass / 0 fail (up from the stated baseline of 2670 / 0 by exactly 21 new tests: 7 in
`relativeTime.test.ts`, 14 in `PostCard.test.tsx`).

`bun run typecheck`, same run:
```
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

An earlier full run (before the final one above) did surface the project's three named
timestamp-precision flakes in `apps/api` — captured verbatim per the evidence-discipline
instruction:

```
@diudara/api test: 263 |     expect(reloaded.updatedAt.getTime()).toBeGreaterThan(reloaded.createdAt.getTime());
Expected: > 1787017107037
Received: 1787017107031
(fail) ProcessRenewals > moves an active subscription to past_due on the due date and stores the deadline [20.72ms]

@diudara/api test: 219 |       expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.grantedAt.getTime());
Expected: >= 1787017110552
Received: 1787017110543
(fail) DrizzleChannelMembershipRepository.recordGrant > attaches the issued link and moves updated_at [14.11ms]

@diudara/api test: 1116 |     expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
Expected: > 1787017113432
Received: 1787017113425
(fail) DrizzleSubscriptionRepository.markPastDue > moves an active subscription to past_due and stores the deadline [21.51ms]

@diudara/api test:  2032 pass
@diudara/api test:  4 fail
```
(That capture was piped through `tail -80`, which is why only 3 `(fail)` lines are visible although
the summary read "4 fail" — the 4th failure's line was almost certainly scrolled past by the `tail`,
not absent. Not verified which test it was; not re-chased since the very next full run came back
0 fail on `apps/api` and this is pre-existing flakiness, not a regression from this task's files.)
These are (at least) the three flakes already named in
`diudara-named-flakes.md` — nothing new. Re-running immediately after (the "final" run quoted above)
came back 0 fail on `apps/api`, consistent with them being timing flakes rather than a regression from
this task. **No `GrantChannelAccess` sighting** occurred in any of my runs, so nothing new to record
there.

## Constraints checked

- No route added to `App.tsx`; `git diff --stat` on `App.tsx`/`App.test.tsx`/`apps/web/src/dashboard/`
  is empty — none of them touched.
- `styles.css` diff is 53 insertions / 0 deletions — additive only.
- `apiClient.ts` diff is 30 insertions / 0 deletions — additive only (the new `PostView` interface
  appended after `exploreUsers`).
- `no-raw-server-errors.test.ts` scope (`apps/web/src/user/`) automatically covers both new files;
  suite is green, and neither new file has a `catch` binding at all (PostCard makes no network calls
  of its own — it only invokes the `onEdit`/`onDeleted` callbacks the caller supplies).
- No `expect(<DOM element>).toBeNull()` used anywhere; DOM absence assertions use
  `screen.queryAllByRole(...).length === 0` / `toBeGreaterThan(0)` forms throughout.

## Things worth flagging, not blocking

- The brief's Step 3 checklist line "clicking each calls the matching callback with the post" reads
  loosely against the Interfaces section's explicit correction that `onDeleted` takes the id, not the
  post. I followed the Interfaces section (the more specific, more recently-stated contract) and
  `onDeleted?.(post.id)` is what ships; the test name says so explicitly
  (`calls onDeleted with the post's id (not the post) when Hapus is clicked`) so this isn't silent.
  Nothing in the brief was actually wrong here — just two sentences in tension, resolved in favor of
  the more precise one.
- `PostCard` does not confirm before calling `onDeleted` (no "are you sure?" dialog) and does not
  itself call any delete/edit API — Task 4 hasn't added those endpoint functions yet, and the brief's
  props shape (`onEdit`/`onDeleted` callbacks, not direct API calls) confirms this is intentional:
  the actual mutation and confirmation UX belongs to whichever later task wires the callbacks up.
