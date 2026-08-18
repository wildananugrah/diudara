# Task 4 report — `PostFeed`, keyset pagination, and the client functions

Worktree: `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`, branch `feat/posts`.

## What was built

- `apps/web/src/user/apiClient.ts` — added `FeedPage`, `listFeed`, `listUserPosts`,
  `createPost`, `editPost`, `deletePost`, placed after the existing `PostView`
  interface (which sits right after `listFollowers`/`listFollowing`/`exploreUsers`
  in this file). Copied verbatim from the brief, including its docstrings.
- `apps/web/src/user/apiClient.test.ts` — added a `describe("apiClient — posts and
  the feed (Task 4)")` block: the three brief-specified auth-split pins for
  `listFeed`, plus URL/method/body coverage for `listFeed`'s `before` handling,
  `listUserPosts`, `createPost`, `editPost`, `deletePost`.
- `apps/web/src/user/PostFeed.tsx` — new file, copied verbatim from the brief:
  four separate state slots (`posts`, `nextCursor`, `loading`, `error`), a
  `useCallback`-memoised `fetchPage`, and the effect that resets and refetches
  when `load`'s identity changes.
- `apps/web/src/user/PostFeed.test.tsx` — new file, 9 tests covering the full
  Step 3 checklist (see below).
- `apps/web/src/styles.css` — additive only. Added `.post-feed .empty` (spacing),
  `.post-feed .feed-error` (red, matches `.form-error`'s color/size convention),
  and `.post-feed > button` (centers "Muat lebih banyak"). `.post-card*` already
  existed from Task 3; the bare `button` element already has baseline/disabled
  styling project-wide, so no new button-specific rule was needed beyond
  positioning.

## Design choice: `PostFeed.test.tsx` uses real `apiClient` functions as `load`, with `global.fetch` mocked

`PostFeed` takes `load: (before) => Promise<FeedPage>` as a prop — it never
calls `fetch` itself. The brief's Step 3 nonetheless says "Cover, with
`global.fetch` replaced" and asks for assertions like "passes
`before=<cursor>`", which only makes sense against a URL. So every test's
`load` prop is a **module-level, stable** function that calls the real
`listFeed("untuk-anda", before)`, with `global.fetch` mocked underneath —
matching `FollowButton.test.tsx`/`PostCard.test.tsx`'s idiom exactly (real
functions, mocked `fetch`, never module mocking) and exercising the actual
apiClient → fetch → URL path rather than a bespoke stand-in.

## Step 3 checklist coverage (verbatim from the brief)

All six bullet points, plus the separately-called-out "load must be
memoised" pin, map to these tests in `PostFeed.test.tsx`:

1. "an empty first page renders `emptyMessage` and no button" →
   `renders emptyMessage and no 'Muat lebih banyak' button for an empty first page`
2. "a page with `nextCursor` renders the button; clicking it appends and
   passes `before=<cursor>`" →
   `renders the button when nextCursor is present; clicking it appends posts and sends before=<cursor>`
3. "when the second page returns `nextCursor: null` the button disappears" →
   `hides the button once a page comes back with nextCursor: null`
4. "a failed load more keeps the posts already on screen and shows Bahasa
   copy" →
   `keeps posts already on screen when a 'load more' fails, and shows Bahasa error copy`
5. "the error text comes from `describeRequestFailure`, never the server's
   string" →
   `never renders the server's own error text — describeRequestFailure only`
   (asserts the rendered text equals `describeRequestFailure`'s 500 sentence
   AND that the raw `"internal server error"` string sent by the mock server
   is absent from the DOM)
6. "clicking Muat lebih banyak twice quickly does not fire two requests" →
   `clicking "Muat lebih banyak" twice quickly fires only one extra request`
   (three rapid clicks, only 2 total requests: page 1 + one load-more)
7. "load must be memoised... pin it with a test that renders, waits, and
   asserts exactly one request" →
   `issues exactly one request for a stable, memoised load prop`

Two extra tests beyond the checklist, covering `ownHandle`/`onDeleted` wiring
that Step 4's props table implies but the checklist doesn't enumerate:
`passes isOwn=true only for posts whose author handle matches ownHandle` and
`calls onDeleted with the post's id when Hapus is clicked on an owned post`.

`no-raw-server-errors.test.ts` and `vite-proxy-coverage.test.ts` were run
explicitly (not just as part of the full suite) since the brief calls out
both by name:

```
$ bun run test -t "no raw server errors"
 5 pass / 0 fail — Ran 5 tests across 43 files.

$ bun run test -t "vite proxy coverage"
 3 pass / 0 fail — Ran 3 tests across 43 files.
```

`/users` was already in `vite.config.ts`'s proxy table (from Task 2/3); no
proxy change was needed, confirmed rather than assumed.

## Step 5 — mutation testing, each restored, output pasted

**Mutation 1 — error branch replaces `posts` with `[]`:**

```diff
       } catch (err: unknown) {
         setError(describeRequestFailure(err));
+        setPosts([]);
       } finally {
```

```
$ bun run test -t "PostFeed"
...
error: expect(received).toBe(expected)
...
(fail) PostFeed > keeps posts already on screen when a 'load more' fails, and shows Bahasa error copy [12.61ms]

 8 pass
 1 fail
Ran 9 tests across 43 files. [582.00ms]
error: script "test" exited with code 1
```
Caught, as expected. Reverted.

**Mutation 2 — render the button unconditionally:**

```diff
-      {nextCursor !== null ? (
-        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
-          {loading ? "Memuat..." : "Muat lebih banyak"}
-        </button>
-      ) : null}
+      <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
+        {loading ? "Memuat..." : "Muat lebih banyak"}
+      </button>
```

```
$ bun run test -t "PostFeed"
...
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) PostFeed > renders emptyMessage and no 'Muat lebih banyak' button for an empty first page [26.84ms]
...
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) PostFeed > hides the button once a page comes back with nextCursor: null [8.35ms]

 7 pass
 2 fail
Ran 9 tests across 43 files. [504.00ms]
error: script "test" exited with code 1
```
Caught by two tests. Reverted.

**Mutation 3 — drop `before` from the second request** (the "load more"
button's `onClick` calls `fetchPage(null)` instead of `fetchPage(nextCursor)`,
so the request PostFeed actually issues on "load more" loses the cursor):

```diff
-        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
+        <button type="button" disabled={loading} onClick={() => void fetchPage(null)}>
```

```
$ bun run test -t "PostFeed"
...
TestingLibraryElementError: Unable to find an element with the text: Isi kiriman 1.
...
(fail) PostFeed > renders the button when nextCursor is present; clicking it appends posts and sends before=<cursor> [20.48ms]

 8 pass
 1 fail
Ran 9 tests across 43 files. [676.00ms]
error: script "test" exited with code 1
```
Caught — `before === null` on the second call restarts the feed at page 1
(`fetchPage`'s own `before === null ? page.posts : [...current, ...page.posts]`
branch), so post 1 is gone and the assertion for "still on screen" fails
before the URL assertion is even reached. Not vacuous: the test failed for a
real, on-point reason. Reverted.

All three mutations were caught by tests that failed for the right reason
(not a coincidental unrelated assertion) — no survivors, nothing to flag
under "a mutation that survives."

## Final verification (repo root, worktree)

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts && bun run typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0

$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts && bun run test
@diudara/shared test:  82 pass / 0 fail — Ran 82 tests across 4 files. [29.00ms]
@diudara/worker test:  38 pass / 0 fail — Ran 38 tests across 3 files. [107.00ms]
@diudara/web test:    553 pass / 0 fail — Ran 553 tests across 43 files. [3.81s]
@diudara/api test:   2036 pass / 0 fail — Ran 2036 tests across 139 files. [61.62s]
```

Total: 2709 pass / 0 fail (82 + 38 + 553 + 2036), matching the pre-task
baseline of 2691 plus the 18 new web tests (9 in `apiClient.test.ts`'s new
describe block, 9 in `PostFeed.test.tsx`) — 535 → 553. No test outside
`apps/web` was touched.

Some `apps/api` output lines look alarming (`[payments] ALERT:`, `[gating]
LEAKED INVITE LINK:`, etc.) — these are intentional log lines from existing
tests exercising failure paths, not new failures; every one of those tests is
in the `pass` count and the run exited 0. No `(fail)` lines appear anywhere in
the `apps/api` output. No flake (of the known clock-vs-`now()` family or
otherwise) was observed in this run.

## Things I did not change and why

- No route was added to `App.tsx`; `App.test.tsx`'s shell-partition arrays
  were not touched, per the brief.
- Nothing under `apps/web/src/dashboard/` was touched.
- `run.sh` and `test.http` (untracked files already present in the worktree
  before this task started, per the initial `git status`) were left alone —
  not part of this task's scope.

## Concerns / things worth a second look

- **CSS was not explicitly requested by the brief's file list** (only
  `apiClient.ts`, `PostFeed.tsx`, `PostFeed.test.tsx` are named), but Task 3's
  own history in `styles.css` (see the "Task 3: PostCard" comment block)
  establishes the precedent of styling a task's new classes even when the
  brief's file list didn't name `styles.css`, and the global constraints
  explicitly permit additive changes there. Added three small, additive
  rules (`.post-feed .empty`, `.post-feed .feed-error`, `.post-feed > button`)
  rather than leaving the feed error text and load-more button entirely
  unstyled. This is a judgment call, flagged in case the reviewer wanted
  `styles.css` left untouched for this task.
- The brief's `PostFeed` component (copied verbatim) renders the feed error
  as `<p className="feed-error">{error}</p>` with **no `role="alert"`**, even
  though every other error paragraph in `apps/web/src/user/` (`FollowButton`,
  `LoginPage`, `SignupPage`, `SettingsPage`, `JelajahPage`, both reset pages)
  uses `role="alert"` on its error text. I implemented the brief exactly as
  given rather than silently adding the role, since the brief says to use its
  code "verbatim" — but this is a real inconsistency with the rest of the
  codebase's accessibility convention and may be worth a follow-up fix.
- `listFeed`'s `mengikuti` branch, when the server answers 401 with
  `{"error":"masuk untuk melihat kiriman yang Anda ikuti"}` (the API's actual
  behavior per `apps/api/src/routes/posts.ts`, confirmed by reading it), goes
  through `apiFetch` → `apiRequest`, which on ANY 401 clears the session and
  throws `UserApiError(SESSION_EXPIRED_MESSAGE, 401)` — discarding that
  specific server message in favor of the generic "sesi berakhir" copy. This
  matches the brief's stated design exactly ("a 401 there means the token is
  dead and clearing it is right") and is consistent with how every other
  `apiFetch` caller behaves, but it does mean a signed-in user who simply
  isn't following anyone yet would need the UI layer (Beranda, Task 5) to
  distinguish "no session" from "empty following list" some other way if that
  distinction ever matters — not this task's concern, but worth Task 5's
  implementer knowing the exact shape.

## Fix round 1

Review verdict: spec ✅, quality — one Critical (C1), two Important (I2, I3).
Both concerns raised in the original report were upheld. All three fixed
below, each mutation-proved and reverted.

### C1 — `no-raw-server-errors` didn't match a type-annotated `catch` binding

`STATEMENT_CATCH` in `apps/web/src/test/no-raw-server-errors.test.ts` was
`/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g` — it required the identifier to be
followed immediately by `)`. `PostFeed.tsx` writes `catch (err: unknown)`,
which no other file under `src/user` does, and the annotation broke the
match, so the guard silently didn't cover the one new file this task added.

Fix — widened the regex with the same optional-annotation group
`CALLBACK_CATCH` already uses for the arrow-function form:

```diff
-const STATEMENT_CATCH = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
+const STATEMENT_CATCH = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)/g;
```

Added a dedicated test, `detects the banned pattern inside a
TYPE-ANNOTATED statement-form catch — PostFeed.tsx's own shape`, covering
both directions: the banned pattern in a typed catch (and a typed catch with
a union type) must be flagged, and a typed catch that never reads `.message`
off the binding (the actual, fixed shape of `PostFeed.tsx`) must NOT be
flagged.

**Mutation proof — reproduced the reviewer's exact repro against the real file**,
temporarily changing `PostFeed.tsx:49-50` to:

```ts
} catch (err: unknown) {
  setError(err instanceof Error ? err.message : describeRequestFailure(err));
```

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "no raw server errors"
bun test v1.3.11 (af24e281)

src/test/no-raw-server-errors.test.ts:
118 |       .sort();
119 | 
120 |     // Printed as file names, so this fails in milliseconds and names the file.
121 |     // The fix is always the same: compose your own Bahasa context sentence and
122 |     // append `describeRequestFailure(err)` from `user/errorCopy.ts`.
123 |     expect(offenders).toEqual([]);
                            ^
error: expect(received).toEqual(expected)

- []
+ [
+   "PostFeed.tsx",
+ ]

- Expected  - 1
+ Received  + 3

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/test/no-raw-server-errors.test.ts:123:23)
(fail) no raw server errors reach a member-facing screen > no file under src/user reads .message off a caught error [52.74ms]

 5 pass
 548 filtered out
 1 fail
 14 expect() calls
Ran 6 tests across 43 files. [2.05s]
error: script "test" exited with code 1
```

Now goes red, naming the exact file. Reverted. Re-ran the whole web suite
after the regex fix to confirm the widened pattern didn't turn any other
legitimate file under `src/user` into a new offender:

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test
bun test v1.3.11 (af24e281)

 554 pass
 0 fail
 1206 expect() calls
Ran 554 tests across 43 files. [6.26s]
```

### I2 — the auth-split tests only pinned the one thing identical between the two helpers

`publicGet` and `apiFetch` both call `authorizedHeaders(_, getUserToken())`,
so a test asserting only header presence/absence cannot tell which helper
`listFeed`'s `untuk-anda` branch actually calls. The real difference is 401
handling: `apiRequest` (under `apiFetch`) clears the session on any 401;
`publicGet` never does.

Added two tests to `apiClient.test.ts`, alongside the existing header pins
(kept — they still guard the real Phase 2 regression):

- `listFeed('untuk-anda') leaves the session intact on a 401 — publicGet never clears it`
- `listFeed('mengikuti') clears the session on a 401 — apiFetch always does`

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "posts and the feed"
bun test v1.3.11 (af24e281)

 11 pass
 545 filtered out
 0 fail
 23 expect() calls
Ran 11 tests across 43 files. [3.55s]
```

**Mutation proof — reproduced the reviewer's exact repro**, temporarily
changing `listFeed`'s `untuk-anda` branch in `apiClient.ts` from `publicGet`
to `apiFetch`:

```diff
   return tab === "mengikuti"
     ? apiFetch<FeedPage>(path)
-    : publicGet<FeedPage>(path, "gagal memuat kiriman");
+    : apiFetch<FeedPage>(path);
```

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "posts and the feed"
bun test v1.3.11 (af24e281)

src/user/apiClient.test.ts:
931 |       jsonResponse({ error: "invalid or expired token" }, 401)
932 |     ) as unknown as typeof fetch;
933 | 
934 |     await listFeed("untuk-anda").catch(() => {});
935 | 
936 |     expect(isUserSignedIn()).toBe(true);
                                   ^
error: expect(received).toBe(expected)

Expected: true
Received: false

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/apiClient.test.ts:936:30)
(fail) apiClient — posts and the feed (Task 4) > listFeed('untuk-anda') leaves the session intact on a 401 — publicGet never clears it [12.69ms]

 10 pass
 545 filtered out
 1 fail
 23 expect() calls
Ran 11 tests across 43 files. [1.88s]
error: script "test" exited with code 1
```

Also re-ran the FULL web suite under the same mutation, matching the
reviewer's own framing ("swapping `listFeed`'s `untuk-anda` branch ... left
the whole web suite at 553 pass / 0 fail"):

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test
...
error: expect(received).toBe(expected)
Expected: true
Received: false
      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/apiClient.test.ts:936:30)
(fail) apiClient — posts and the feed (Task 4) > listFeed('untuk-anda') leaves the session intact on a 401 — publicGet never clears it [53.58ms]

 555 pass
 1 fail
 1208 expect() calls
Ran 556 tests across 43 files. [6.13s]
error: script "test" exited with code 1
```

Whole-suite proof: the mutation that used to leave the suite fully green now
fails 1/556. Reverted `apiClient.ts` back to `publicGet`.

### I3 — `PostFeed`'s error paragraph was missing `role="alert"`

Confirmed across the tree that every other top-level request-failure element
under `src/user` carries `role="alert"`
(`FollowButton.tsx:154`, `JelajahPage.tsx:178,189`, `LoginPage.tsx:119`,
`ResetCompletePage.tsx:76`, `ResetRequestPage.tsx:67`, `SettingsPage.tsx:207`,
`SignupPage.tsx:140`). `PostFeed.tsx`'s did not, because the brief's own code
sample omitted it and Task 4 was told to copy it verbatim.

Fix:

```diff
-      {error !== null ? <p className="feed-error">{error}</p> : null}
+      {/* `role="alert"` matches every other top-level request-failure element
+          under src/user (FollowButton, LoginPage, SignupPage, ...) — a screen
+          reader must announce this the same way it announces theirs. */}
+      {error !== null ? (
+        <p className="feed-error" role="alert">
+          {error}
+        </p>
+      ) : null}
```

Added a dedicated test, `exposes the feed error as role=alert, matching
every other error paragraph under src/user`, and switched the two existing
error-copy tests from `screen.getByText(...)` to `screen.getByRole("alert").textContent`
so they too depend on the role being present (matching `FollowButton.test.tsx`'s
own idiom).

**Mutation proof** — removed `role="alert"` again:

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "PostFeed"
bun test v1.3.11 (af24e281)

src/user/PostFeed.test.tsx:
...
TestingLibraryElementError: Unable to find role="alert"
...
(fail) PostFeed > keeps posts already on screen when a 'load more' fails, and shows Bahasa error copy [1010.56ms]
...
(fail) PostFeed > never renders the server's own error text — describeRequestFailure only [1008.79ms]
...
(fail) PostFeed > exposes the feed error as role=alert, matching every other error paragraph under src/user [1006.22ms]

 8 pass
 546 filtered out
 3 fail
 13 expect() calls
Ran 11 tests across 43 files. [3.77s]
error: script "test" exited with code 1
```

All three error-copy tests go red without the role, not just the dedicated
one. Reverted.

### Re-scrutinizing the two Step-5 mutations the reviewer verified by reading only

**"Drop `before` from the second request" was weaker than it looked.** The
original test's assertions ran in this order:

```ts
expect(screen.getByText("Isi kiriman 1")).toBeTruthy();      // ran first
expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-a"); // never reached
```

Under the mutation (`onClick={() => void fetchPage(null)}`), the
`before === null` branch in `fetchPage` REPLACES `posts` instead of
appending, so the first assertion already failed and the test never actually
executed the URL check its own name promises ("...and sends
`before=<cursor>`"). The mutation was still caught — correctly, for a real
and related reason (append-vs-replace) — but the specific claim "the URL
carries `before=`" was unproven by this test as originally ordered, only by
coincidence of a shared root cause.

Fixed by reordering the assertions so the URL check runs first:

```diff
     await screen.findByText("Isi kiriman 2");
-    // The first page's post is still there — appended, not replaced.
-    expect(screen.getByText("Isi kiriman 1")).toBeTruthy();
-    expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-a");
+    expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-a");
+    // The first page's post is still there — appended, not replaced.
+    expect(screen.getByText("Isi kiriman 1")).toBeTruthy();
```

Re-ran the mutation with the reordered test:

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "PostFeed"
bun test v1.3.11 (af24e281)

src/user/PostFeed.test.tsx:
79 |     // logic keyed off `before === null`, a mutation that drops the cursor
80 |     // (calling `fetchPage(null)` on click) makes posts get REPLACED rather
81 |     // than appended, which would otherwise fail the assertion below first and
82 |     // mask the fact that the URL itself never carried `before=` at all. This
83 |     // line is the one that actually proves the cursor was forwarded.
84 |     expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-a");
                          ^
error: expect(received).toBe(expected)

Expected: "/users/feed?tab=untuk-anda&before=cursor-a"
Received: "/users/feed?tab=untuk-anda"

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/PostFeed.test.tsx:84:22)
(fail) PostFeed > renders the button when nextCursor is present; clicking it appends posts and sends before=<cursor> [60.65ms]

 10 pass
 546 filtered out
 1 fail
 18 expect() calls
Ran 11 tests across 43 files. [1273.00ms]
error: script "test" exited with code 1
```

Now the URL assertion itself is what fails — the test proves what it claims
to prove. Reverted the mutation.

**"Render the button unconditionally" re-verified and is not weak.** Re-ran
it fresh against the current file (after the `role="alert"` change):

```diff
-      {nextCursor !== null ? (
-        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
-          {loading ? "Memuat..." : "Muat lebih banyak"}
-        </button>
-      ) : null}
+      <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
+        {loading ? "Memuat..." : "Muat lebih banyak"}
+      </button>
```

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web && bun run test -t "PostFeed"
bun test v1.3.11 (af24e281)

src/user/PostFeed.test.tsx:
55 |     global.fetch = mock(async () => jsonResponse({ posts: [], nextCursor: null })) as unknown as typeof fetch;
56 | 
57 |     renderFeed();
58 | 
59 |     expect(await screen.findByText("Belum ada kiriman.")).toBeTruthy();
60 |     expect(screen.queryAllByRole("button", { name: "Muat lebih banyak" }).length).toBe(0);
                                                                                       ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/PostFeed.test.tsx:60:83)
(fail) PostFeed > renders emptyMessage and no 'Muat lebih banyak' button for an empty first page [29.25ms]
 97 |     renderFeed();
 98 |     const button = await screen.findByRole("button", { name: "Muat lebih banyak" });
 99 |     fireEvent.click(button);
100 | 
101 |     await screen.findByText("Isi kiriman 2");
102 |     expect(screen.queryAllByRole("button", { name: "Muat lebih banyak" }).length).toBe(0);
                                                                                        ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/PostFeed.test.tsx:102:83)
(fail) PostFeed > hides the button once a page comes back with nextCursor: null [10.42ms]

 9 pass
 546 filtered out
 2 fail
 19 expect() calls
Ran 11 tests across 43 files. [1.exit
[trimmed]
```

Both failures fire directly on the exact assertion the test's name claims
(button count), with no masking by an unrelated failure. This one holds up.
Reverted.

### Final verification, fix round 1

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts && bun run typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0

$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts && bun run test
@diudara/shared test:  82 pass / 0 fail — Ran 82 tests across 4 files.
@diudara/worker test:  38 pass / 0 fail — Ran 38 tests across 3 files.
@diudara/web test:    557 pass / 0 fail — Ran 557 tests across 43 files.
@diudara/api test:   2036 pass / 0 fail — Ran 2036 tests across 139 files.
```

Total: 2713 pass / 0 fail (82 + 38 + 557 + 2036). Web went 553 → 557 (+4: two
for I2, one for C1, one for I3).

**One flake observed, unrelated to this task's files.** The FIRST full-suite
run of this fix round produced:

```
@diudara/api test: (fail) GET /users/:handle/followers and GET /users/:handle/following > defaults to 50 rows with no ?limit=, even when more than 50 people follow the target [5040.16ms]
@diudara/api test:   ^ this test timed out after 5000ms.
@diudara/api test:
@diudara/api test: # Unhandled error between tests
@diudara/api test: -------------------------------
...
@diudara/api test: 665 |     expect(rows).toHaveLength(50);
@diudara/api test:                        ^
@diudara/api test: error: expect(received).toHaveLength(expected)
@diudara/api test:
@diudara/api test: Expected length: 50
@diudara/api test: Received length: 0
```

This is `apps/api/src/routes/users.test.ts` — a followers/following list
test that has nothing to do with this task's files, timing out under the
same CPU contention already on record for this branch. Re-ran `apps/api`
alone (no concurrent workspace contention):

```
$ cd /Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api && bun run test
 2036 pass
 0 fail
Ran 2036 tests across 139 files. [70.18s]
```

...and re-ran the full root `bun run test` a second time, which came back
fully clean (the 2713/0 figures quoted above are from that second, clean
run). Not adding this to the named-flakes list myself since it's outside
this task's scope to curate that list, but the failing test name and the
exact captured output are here in full per the "capture any `(fail)` line
verbatim" instruction, in case it's useful corroboration.

### Commits

- `312144311716501b2ae39c0276a496949f028601` — `feat(web): PostFeed with keyset pagination` (original Task 4 submission)
- `8a5568fd872efbe53c29d18d8991285431f6a1eb` — `fix(web): review round 1 — typed-catch guard, real 401 auth-split proof, role=alert` (this fix round)

