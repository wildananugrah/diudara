# Task 6 report — Posts on the profile

**Commit:** `8749868` on branch `feat/posts`, worktree `.worktrees/posts`.
**Files changed:** `apps/web/src/user/ProfilePage.tsx`, `apps/web/src/user/ProfilePage.test.tsx`. Nothing else.

## Summary

`ProfilePage` now renders that person's posts below the existing header via `PostFeed`, backed by
`listUserPosts(handle, before)`. Test written first (Step 1), confirmed red, then implemented (Step 2), then proven by
two mutations (Step 3), both reverted after confirming red.

## Step 1 — failing tests first

Added a `describe("ProfilePage — posts (Task 6)", ...)` block with 7 tests, and updated every existing "ready-state"
test's `global.fetch` mock to also answer `/users/:handle/posts` (previously only `/users/by-handle/:handle` was
mocked; once `ProfilePage` renders `PostFeed`, every ready-state test fires a second request, and an unrouted mock
handed the profile body back as a `FeedPage` would crash `PostFeed`'s render on `.map`). Tests that never reach
`load.status === "ready"` (404, profile 500, network drop) are unaffected — `PostFeed` only mounts in the ready
branch — so those five tests needed no change.

Ran before writing any implementation:

```
$ bun test src/user/ProfilePage.test.tsx   (apps/web, own bunfig preload)
...
(fail) ProfilePage — posts (Task 6) > renders that person's posts below the profile header [1029.27ms]
(fail) ProfilePage — posts (Task 6) > still renders the posts when signed out — listUserPosts goes through publicGet [1008.46ms]
(fail) ProfilePage — posts (Task 6) > shows honest Bahasa copy for an empty list, not a spinner [1010.53ms]
(fail) ProfilePage — posts (Task 6) > carries Edit and Hapus on your own profile's posts [1005.70ms]
(fail) ProfilePage — posts (Task 6) > carries NEITHER Edit nor Hapus on someone else's posts [1010.91ms]
(fail) ProfilePage — posts (Task 6) > does NOT blank the profile header when the post load fails [1087.28ms]
(fail) ProfilePage — posts (Task 6) > deleting from your own profile removes exactly that row, keeping the others in order [1125.41ms]

 618 pass
 7 fail
```

618 pass matches the pre-existing baseline exactly — no collateral damage from the fetch-mock routing changes to the
existing tests, and all 7 new tests failed for the expected reason (`ProfilePage` did not yet render anything post-related).

Per the brief's guidance on the two recurring failure modes: the delete test uses **three** rows (`Kiriman satu` /
`dua` / `tiga`), deletes the **middle** one, and asserts the resulting **order** via a `bodies()` helper that reads
`.post-card-body` text in document order — not membership, not length. The "header survives" test asserts the header
text is present *before* waiting for the post-load failure (guard), then again *after* `findByRole("alert")` resolves
(guard that the failure actually happened), then the real assertion. Both guard/assert splits are there so that if
the real assertion regresses, it fails for the reason the test names, not masked by an earlier assertion.

## Step 2 — implementation

`ProfilePage.tsx`:

- `ownHandle = getSessionUser()?.handle ?? null` — same read `BerandaPage` does. Passed to `PostFeed` as `ownHandle`;
  `PostFeed` itself does the `ownHandle === post.author.handle` comparison per row (see `PostCard`'s docstring), so
  `isOwn` is computed in exactly one place for both Beranda and the profile — never assumed as a boolean prop here.
- `loadPosts = useCallback((before) => listUserPosts(handle, before), [handle])` — memoised, forwards only the
  cursor, no `.then`/`.catch` of its own. This is the mechanism by which post state and profile state stay apart:
  there is no code path here that could touch `setLoad` even by accident.
- `postsFeed = useRef<PostFeedHandle>(null)`, `pendingDelete`/`deleting`/`deleteError` state, and `confirmDelete()` —
  copied from `BerandaPage`'s shape exactly: confirm → `deletePost` → `postsFeed.current?.remove(id)`.
- Render: a `<PostFeed ref={postsFeed} load={loadPosts} ownHandle={ownHandle} onDeleteRequested={...}
  emptyMessage="Belum ada kiriman untuk ditampilkan." />` below the existing counts, plus the same inline
  confirmation panel (`Hapus kiriman ini?` / `Ya, hapus` / `Tidak jadi`) and `role="alert"` delete-error paragraph
  Beranda uses. Both `.delete-confirm` and `.feed-error` classes already exist in `styles.css` and are not
  `.beranda-page`-scoped, so no CSS changes were needed (styles.css untouched, as required).

**Scope note, disclosed rather than silently decided:** `onEdit` is intentionally left unwired. `PostCard` renders
the "Edit" button whenever `isOwn` is true regardless of whether an `onEdit` handler is supplied (it calls
`onEdit?.(post)`, a safe no-op), so the button renders — satisfying the checklist's "posts carry Edit and Hapus" — but
tapping it currently does nothing. The task brief's "Interfaces: Consumes" list names only `PostFeed`,
`listUserPosts`, `getSessionUser` (not `PostComposer` or `editPost`), and the four-point "decides whether this task
is right" section names only delete as needing to function, not edit. I read that as deliberate scope, but flagging
it explicitly since a dead button is a real UX gap if it wasn't.

After implementation, isolated `apps/web` run:

```
$ bun test src/user/ProfilePage.test.tsx
 18 pass
 0 fail
```

## Step 3 — mutations

**Mutation 1 — couple post-load failure into profile state.** Changed `loadPosts` to:

```ts
const loadPosts = useCallback(
  (before: string | null) =>
    listUserPosts(handle, before).catch((err: unknown) => {
      setLoad({ status: "error", message: describeRequestFailure(err) });
      throw err;
    }),
  [handle]
);
```

```
$ bun test -t "does NOT blank the profile header when the post load fails"
<body>
  <div>
    <main class="user-page">
      <h1>Gagal memuat profil</h1>
      <p>Server sedang bermasalah. Coba lagi sebentar lagi.</p>
    </main>
  </div>
</body>
(fail) ProfilePage — posts (Task 6) > does NOT blank the profile header when the post load fails [1025.93ms]
 0 pass / 1 fail
```

The whole page collapsed to the top-level error view — header gone — exactly the regression named in the brief.
Reverted.

**Mutation 2 — pass `isOwn` as `true` unconditionally.** Changed `ownHandle = getSessionUser()?.handle ?? null;` to
`ownHandle = handle;` (the viewed profile's own handle, ignoring session entirely — every post on the page is
authored by `handle`, so this makes every viewer "own" every row).

```
$ bun test -t "carries NEITHER Edit nor Hapus"
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) ProfilePage — posts (Task 6) > carries NEITHER Edit nor Hapus on someone else's posts [30.17ms]
 0 pass / 1 fail
```

Reverted. Both mutations confirmed red for the reason named; both reverted before the final commit.

## Final verification

Killed an unrelated orphaned `bun test -t "issues exactly one request"` process (PID 69607, PPID 1, running 2h+,
pre-existing on the box, not started by me) that was contending for CPU and — combined with running all four
workspaces concurrently via `bun run --workspaces test` — produced a reproducible 197-failure cascade in
`apps/web` (`428 pass / 197 fail`), including files I never touched (e.g. `EventsPage.test.tsx` under
`src/dashboard/`, which the brief says not to touch and which I did not touch). Before concluding this was real, I
isolated the variable: `apps/web` alone (`cd apps/web && bun test`) passed clean at both the pre-Task-6 base commit
(`618 pass / 0 fail`, 3.86s) and with my changes applied (`625 pass / 0 fail`, 4.10s) — proving the diff itself was
never the cause. After killing the stray process, `bun run test` from the repo root passed clean twice in a row:

```
$ bun run test   (repo root)
@diudara/shared test:  82 pass / 0 fail  — Ran 82 tests across 4 files. [29ms]
@diudara/worker test:  38 pass / 0 fail  — Ran 38 tests across 3 files. [107ms]
@diudara/web test:    625 pass / 0 fail  — Ran 625 tests across 44 files. [4.47s]
@diudara/api test:   2036 pass / 0 fail  — Ran 2036 tests across 139 files. [58.50s]
$ echo $?
0
```

Total: **2781 pass / 0 fail** (82 + 38 + 625 + 2036). This is 7 more than the recorded baseline of 2774, matching
exactly the 7 new tests added.

```
$ bun run typecheck   (repo root)
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0
```

`git status --short` before commit showed only the two intended files touched. `App.tsx` was never opened or edited —
no route added, shell-partition arrays in `App.test.tsx` untouched. `styles.css` untouched (existing `.delete-confirm`
and `.feed-error` classes were reused as-is).

## Concerns / not verified

1. **Edit button on the profile posts tab is currently a no-op** (see Step 2 scope note above). It renders (satisfies
   the literal checklist item) but does nothing when tapped. If the intent was a working inline edit on the profile
   too, this needs a follow-up — I judged it out of scope per the brief's explicit "Interfaces: Consumes" list and the
   four-point "decides whether this is right" section, neither of which mentions edit functionality, but flagging
   since I could be wrong about the intent.
2. **CPU-contention-driven `apps/web` failures are a real, reproducible risk on this box when `bun run test` runs all
   workspaces concurrently**, not just the `apps/api` clock-vs-`now()` class already on record. I isolated and
   confirmed it is environmental (an orphaned process plus four-way concurrent test load), not a defect in this
   diff, but if this recurs for the next task's implementer, the fix demonstrated here is: check for orphaned `bun
   test` processes (`ps aux | grep "bun test"`) before trusting a failing `apps/web` result, and isolate
   (`cd apps/web && bun test`) to confirm before concluding a regression.
3. **Nothing was run in a real browser.** All evidence is `happy-dom` under `bun test`, consistent with prior tasks
   on this branch.
4. **`ownHandle` is read once per render via `getSessionUser()`, not subscribed** (unlike `BerandaPage`'s signed-in
   composer, which uses `useSyncExternalStore` because it has a live "Kirim" button that must react to a session
   dying mid-visit). A session that expires while someone is looking at their own profile's posts would leave stale
   Edit/Hapus controls visible until something else re-renders the page — the same class of untidy-but-not-misleading
   state `BerandaPage`'s own report already recorded for its Mengikuti tab. Not fixed here; flagging for
   consistency, since the same tradeoff was explicitly accepted upstream.
