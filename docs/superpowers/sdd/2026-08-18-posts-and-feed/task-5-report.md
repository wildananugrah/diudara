# Task 5 report — Beranda's two tabs, and composing, editing and deleting

**Status:** DONE_WITH_CONCERNS
**Branch:** `feat/posts` in `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`
**Commits:** `f8e7ad4` (task) → `0592db2` (fix round 1)
**Gates as of fix round 1:** `bun run test` → **2774 pass / 0 fail** (shared 82, worker 38, web 618, api 2036).
`bun run typecheck` → all four workspaces exit 0.

Baseline before this task, measured in the same worktree, was 2713 pass / 0 fail — matching the figure in the brief
exactly. The task commit landed 2754/0; fix round 1 added 20 web tests.

> **Everything from here to `# Fix round 1` is the original task report.** Two of its claims were wrong and are
> corrected in place, each marked with a **CORRECTED** block: the `sentFrom` claim under "Two defects found in the
> brief", and the auth-split claim under "four things, item 2". Names have moved too — `onDeleted` is now
> `onDeleteRequested` (R4), and `sentFrom: Tab | null` is now `postSent: boolean` (I3); the original names are left
> standing below where they describe what was true at the time.

---

## Files

| | |
|---|---|
| Created | `apps/web/src/user/PostComposer.tsx`, `apps/web/src/user/PostComposer.test.tsx` |
| Rewritten | `apps/web/src/user/BerandaPage.tsx` (was an 18-line placeholder), `apps/web/src/user/BerandaPage.test.tsx` |
| Modified | `apps/web/src/user/PostFeed.tsx` (adds `PostFeedHandle` — see the decision below), `apps/web/src/styles.css` (additive only), `apps/web/src/App.test.tsx` (one test, explained below) |

No route was added. `App.tsx` is untouched, and no shell-partition `toEqual([...])` array in `App.test.tsx` was edited.

### Why `App.test.tsx` had to change

`routing — the app shell > resolves /beranda inside the shell, with Beranda's empty-state copy` asserted
`Belum ada kiriman untuk ditampilkan.` **synchronously**. That string was the placeholder's static text; it is now
`PostFeed`'s `emptyMessage`, which only appears once a first page resolves. The test now mocks `fetch` and awaits with
`findByText`, copying verbatim the idiom the `/jelajah` test beside it already uses (and for the reason that test's own
comment gives — an unmocked `fetch` there updated state outside `act`). Same assertion, same copy, same route; only the
`await` and the mock are new.

---

## The decision the brief left open: `prepended`

**Chosen: lift the list into `PostFeed` behind an imperative handle.** `PostFeedHandle` exposes `prepend`, `replace`
and `remove`; `BerandaPage` holds a `useRef<PostFeedHandle>` and calls them. React 19.2.8 passes `ref` to function
components as an ordinary prop, so this is a `ref?: Ref<PostFeedHandle>` entry in `Props` plus a `useImperativeHandle`
with empty deps — no `forwardRef` (deprecated in 19).

**Why, and it is not primarily about the duplicate.** The brief frames the choice as "clear `prepended` on a tab change,
or lift the list" — as if both fully solve the problem and only differ in tidiness. They do not, and the reason is in
Task 4's code:

- `PostFeed` owns `posts` as internal state, set **only** by `fetchPage`.
- `onEdit` / `onDeleted` are forwarded straight to `PostCard` and raised on the tap. `PostFeed` does not act on them.

So a page holding its own `prepended` array can add rows *above* the feed, but has **no way whatsoever to remove or
rewrite a row the feed itself loaded**. Step 3's own checklist requires both — "`Hapus` … on confirm removes the row"
and "`Edit` … saving updates the row in place". With a parallel list those two items are only satisfiable for posts
created in the current session; a post that arrived from the server could be deleted on the API and still sit on screen
until a manual refetch. Clearing `prepended` on a tab change fixes the duplicate and leaves that gap wide open.

The handle closes both at once, and closes the duplicate *structurally* rather than by remembering to clear something:
`PostFeed`'s existing `useEffect` already resets `posts` whenever `load` changes identity, so a tab switch cannot leave
a stale copy behind. One list, one owner.

**Pinned by:** `BerandaPage.test.tsx` → `shows a just-created post exactly once after switching tabs and back`. It
posts, switches to Mengikuti, switches back, and asserts `getAllByText("kiriman baru").length === 1`. The
untuk-anda refetch deliberately **does** return the new post (which is what a real server does by then) — that is what
makes a second copy possible at all, and a mock that omitted it would make the test pass under either design.

That test was then verified against the brief's literal design — see mutation E4 below, which reproduces the brief's
`prepended` list and gets `Expected: 1 / Received: 2`.

---

## Two defects found in the brief

### 1. The brief's `BerandaPage` prepends a new post into the **Mengikuti** feed, where it can never belong

The brief renders `{prepended.map(...)}` unconditionally, above whichever tab is showing. But `mengikuti` is defined
server-side as *posts by people you follow, **never the viewer's own***. That is not inference — it is the name of an
existing test:

```
apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts:188
  DrizzlePostRepository.listFollowing > "returns only followed authors' posts, never the viewer's own"
```

So posting while on Mengikuti would show your post in a list that the very next refetch silently removes it from. That
is the same class of lie the tab-switch duplicate is, one layer down.

**Resolved as:** on Mengikuti a successful create does not touch the list; the page says
`Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.` The composer stays available on both tabs — refusing to
let someone post because of which tab they are on would be worse — but the feedback is honest about where the post went.
Pinned by `does not add a new post to the Mengikuti list, and says where it went`.

> **CORRECTED in fix round 1 (I3).** This paragraph originally continued: *"State is `sentFrom: Tab | null` rather than
> a boolean, so switching tabs hides the notice for free, with no effect and nothing to clear by hand."* The claim was
> wrong in the way that matters. Comparing `sentFrom === tab` during render **hid** the notice on the other tab; it
> never **cleared** it. Post from Mengikuti → switch to Untuk Anda → switch back, and the notice was on screen again,
> telling the viewer a post had just been sent when nothing had. The state is now a plain `postSent: boolean` cleared
> by a `useEffect` on `[tab]`. See `## Fix round 1 → I3`.

### 2. `PostCard`'s `onDeleted` fires on the **tap**, not after a delete

Nothing in the brief says who calls `deletePost`. `PostCard.tsx` raises `onDeleted?.(post.id)` directly from the Hapus
button's `onClick`, so despite the past-tense name nothing has been deleted when it fires. `BerandaPage` therefore
treats it as "delete requested": it sets `pendingDelete`, and the confirmation and the `deletePost` call both live in
the page. Recorded here because the name will mislead Task 6's profile posts tab in exactly the same way.

**The confirmation is an inline panel, not `window.confirm`** — `Hapus kiriman ini?` with `Ya, hapus` / `Tidak jadi`.
`window.confirm` under happy-dom is not something I was willing to depend on, it cannot be styled, and it cannot carry
Bahasa copy that matches the rest of the screen. The decline button is `Tidak jadi` rather than `Batal` specifically
because the edit composer's cancel is already `Batal`, and two buttons sharing one accessible name is an ambiguity both
a screen-reader user and `getByRole` have to resolve by position.

---

## The four things named as deciding whether this is right

**1. Signed out, `Mengikuti` renders `Masuk untuk melihat` and fires NO request.** The test counts requests, and the
count is asserted *first*:

```ts
fireEvent.click(tabButton("Mengikuti"));
await settle();
expect(calls.filter((call) => call.url.includes("tab=mengikuti")).length).toBe(0);
expect(calls.length).toBe(1);
const link = screen.getByRole("link", { name: "Masuk untuk melihat" });
expect(link.getAttribute("href")).toBe("/masuk");
expect(screen.queryAllByText(/Sesi Anda sudah berakhir/).length).toBe(0);
```

The path is genuinely unreachable, not merely unlikely: `signedIn` is read during render, so the branch is decided
before `PostFeed` would mount, and `PostFeed` is the only thing that calls `load`. Mutation M1 below removes the guard
and this is the assertion that goes red — the request-count line, not the text line. Task 4's carry-forward note is
also pinned directly: the last assertion confirms `Sesi Anda sudah berakhir` never appears on a page nobody was signed
in to.

**2. `Untuk Anda` still loads signed out.** `still loads Untuk Anda, because /beranda is a publicly reachable route`
asserts the post renders and the URL is `/users/feed?tab=untuk-anda`.

> **CORRECTED in fix round 1.** This item originally claimed the same test proved the **auth split**, via
> `new Headers(calls[0].init?.headers).has("Authorization") === false` — "the part that proves the auth split rather
> than just the happy path". It does not. Signed out there is no token to attach, so that assertion passes whether
> `untuk-anda` is routed through `publicGet` **or** through `apiFetch`; the reviewer confirmed all 23 BerandaPage tests
> stayed green with `listFeed` sending `untuk-anda` down `apiFetch`. What this test actually proves is that the
> signed-out **happy path** works and sends no stale credential. **The split itself is pinned elsewhere** — by Task 4's
> `apiClient.test.ts`, whose 401 tests are what distinguish `publicGet` (does not clear the session) from `apiFetch`
> (does). Beranda's own contribution to the split is the request-count test in item 1, which proves `mengikuti` is
> never *reached* signed out.

**3. The tab lives in the URL, asserted against the URL.** A `LocationProbe` renders `pathname + search` into a
`data-testid`, so every tab assertion reads the real location rather than what rendered. Four tests: clicking Mengikuti
produces `/beranda?tab=mengikuti`; clicking Untuk Anda clears it back to `/beranda`; opening on
`/beranda?tab=mengikuti` (a shared link — nothing was clicked, so component state could not have produced it) shows
Mengikuti current *and* sends `tab=mengikuti`; and a real `createMemoryRouter` history where `router.navigate(-1)`
restores the previous tab. Mutation M3 takes seven of these red.

**4. A failed post keeps the text.** `PostComposer` clears the box only after `await onSubmit(...)` resolves, so a
rejection leaves `setBody("")` unreached. Asserted three ways — in `PostComposer.test.tsx` for a create, and in
`BerandaPage.test.tsx` for both a failed create and a failed *edit* (`keeps the edited text and leaves the row alone
when the save fails`). `BerandaPage.handleSaveEdit` is deliberately **not** wrapped in try/catch for this reason: the
rejection has to reach the composer, and swallowing it in the page would clear the box on a failed save.

---

## Step 5 — mutations

All restored. `git diff` against the pre-mutation copy was byte-identical each time, and `packages/shared/` shows no
diff after the constant was put back.

### M1 — make the signed-out `Mengikuti` tab fetch instead of showing `Masuk untuk melihat`

`{tab === "mengikuti" && !signedIn ? (` → `{false ? (`

```
bun test v1.3.11 (af24e281)

src/user/BerandaPage.test.tsx:
215 |
216 |     fireEvent.click(tabButton("Mengikuti"));
217 |     await settle();
218 |
219 |     // Asserted FIRST, so it cannot be skipped by a later assertion failing.
220 |     expect(calls.filter((call) => call.url.includes("tab=mengikuti")).length).toBe(0);
                                                                                    ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/BerandaPage.test.tsx:220:79)
(fail) BerandaPage — signed out > fires NO request for Mengikuti and offers a link to /masuk [38.34ms]

 22 pass
 1 fail
 64 expect() calls
Ran 23 tests across 1 file. [1293.00ms]
```

It failed on the **request-count** assertion, which is the one that matters — not on the link text.

### M2 — render the composer when signed out

`{signedIn ? (` → `{true ? (`

```
bun test v1.3.11 (af24e281)

src/user/BerandaPage.test.tsx:
244 |     mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));
245 |
246 |     renderBeranda();
247 |     await screen.findByText("Belum ada kiriman untuk ditampilkan.");
248 |
249 |     expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
                                                                         ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/web/src/user/BerandaPage.test.tsx:249:68)
(fail) BerandaPage — signed out > renders no composer at all [17.26ms]

 22 pass
 1 fail
 66 expect() calls
Ran 23 tests across 1 file. [848.00ms]
```

### M3 — drop the `?tab=` URL sync in favour of component state

`useSearchParams` replaced with `useState<Tab>("untuk-anda")`, both `setParams(...)` calls replaced with `setTab(...)`,
`useSearchParams` dropped from the import. The full failure log is 20 000+ characters of happy-dom DOM dumps; the
per-test lines and the totals, unfiltered by `tail`:

```
(fail) BerandaPage — the two tabs > puts ?tab=mengikuti in the URL when Mengikuti is tapped [1027.73ms]
(fail) BerandaPage — the two tabs > clears ?tab= from the URL when Untuk Anda is tapped again [1005.05ms]
(fail) BerandaPage — the two tabs > opens on Mengikuti when the URL already carries ?tab=mengikuti [1005.45ms]
(fail) BerandaPage — the two tabs > restores the previous tab on a browser Back [1021.53ms]
(fail) BerandaPage — the two tabs > shows Mengikuti's own empty message, which points at an empty follow graph [1006.79ms]
(fail) BerandaPage — signed in > sends the viewer's token on Mengikuti [1003.25ms]
(fail) BerandaPage — signed in > does not add a new post to the Mengikuti list, and says where it went [1004.34ms]
 16 pass
 7 fail
Ran 23 tests across 1 file. [8.80s]
```

The load-bearing one, verbatim from the same run:

```
128 |     await waitFor(() => {
129 |       expect(url()).toBe("/beranda?tab=mengikuti");
                          ^
error: expect(received).toBe(expected)

Expected: "/beranda?tab=mengikuti"
Received: "/beranda"
```

Note that the *tab still renders correctly* under this mutation — the DOM dump in that failure shows
`aria-current="true"` on Mengikuti and Mengikuti's own empty message on screen. Only the URL is wrong. A test written
against component state would have passed this mutation completely.

### M4 — `MAX_POST_BODY_LENGTH` 1000 → 999 in `packages/shared`

This is Task 2's Step-10 mutation re-run, and Task 5 is the first point at which the **cross-workspace** bite can be
proven, because until now only `apps/api` read the constant.

**`apps/web` — 9 failures, all new this task:**

```
(fail) PostComposer — what may be sent > disables the submit button when the box holds only whitespace [1.67ms]
(fail) PostComposer — what may be sent > disables the submit button when the body is over the limit — LITERAL 1001 [0.56ms]
(fail) PostComposer — what may be sent > enables the submit button at EXACTLY the limit — LITERAL 1000 [0.39ms]
(fail) PostComposer — the limit is bounded twice > shows 0/1000 initially — the LITERAL 1000, never the constant [0.13ms]
(fail) PostComposer — the limit is bounded twice > sets maxLength on the textarea to the LITERAL 1000 [0.56ms]
(fail) PostComposer — the limit is bounded twice > clamps a programmatically-set over-long value to 1000 characters [0.83ms]
(fail) PostComposer — the limit is bounded twice > counts the TRIMMED length, matching what the server validates [0.69ms]
(fail) PostComposer — submitting > clears the box on a successful submit [3.20ms]
(fail) PostComposer — the edit shape > pre-fills the box from initialBody and counts it [1.10ms]
 589 pass
 9 fail
Ran 598 tests across 44 files. [4.39s]
```

**`apps/api` — 3 failures:**

```
(fail) POST /users/posts > accepts a body of exactly 1000 characters [164.30ms]
(fail) POST /users/posts > accepts exactly 1000 characters plus surrounding whitespace — the route and the use case must agree [150.01ms]
(fail) CreatePost > refuses a body over the limit — asserted against the LITERAL 1000 [0.72ms]
 2033 pass
 3 fail
Ran 2036 tests across 139 files. [90.73s]
```

Red in both workspaces from one constant. That is the whole point of the constant being shared, and it is now measured
rather than assumed.

---

## Four extra mutations, because the Beranda tests had no red phase

I wrote `PostComposer.tsx` before `PostComposer.test.tsx`, against Step 1's ordering. And every one of the 23
`BerandaPage` tests passed on its first run, so neither file has a genuine red-then-green history. Stating that plainly
rather than implying a TDD cycle I did not perform. The compensating evidence is mutation, which is the stronger signal
anyway — these four target the Step-3 checklist items that M1–M4 do not reach.

**E1 — `feed.current?.replace(updated)` removed, so an edit no longer updates the row in place**

```
(fail) BerandaPage — editing your own post > opens the composer pre-filled, saves in place, and shows the diedit marker [13.41ms]
 22 pass
 1 fail
```

**E2 — `feed.current?.remove(id)` removed, so a confirmed delete no longer removes the row**

```
(fail) BerandaPage — deleting your own post > asks for confirmation before sending anything, then removes the row on confirm [1040.26ms]
 22 pass
 1 fail
```

**E3 — the confirmation skipped: `onDeleted` calls `deletePost(id)` straight away**

```
(fail) BerandaPage — deleting your own post > asks for confirmation before sending anything, then removes the row on confirm [5.28ms]
(fail) BerandaPage — deleting your own post > sends nothing and keeps the row when the confirmation is declined [11.35ms]
(fail) BerandaPage — deleting your own post > keeps the row and shows Bahasa copy when the delete fails [10.78ms]
 20 pass
 3 fail
```

**E4 — the brief's literal `prepended` design, reproduced**

A `const [prepended, setPrepended] = useState<PostView[]>([])` in `BerandaPage`, rendered as bare `PostCard`s above the
feed, never cleared on a tab change — exactly the code in the brief. `handleCreate` fills it instead of calling
`feed.current?.prepend`.

```
(fail) BerandaPage — signed in > shows a just-created post exactly once after switching tabs and back [18.35ms]
 22 pass
 1 fail
```

```
341 |
342 |     fireEvent.click(tabButton("Untuk Anda"));
343 |     await screen.findByText("kiriman lama");
344 |
345 |     expect(screen.getAllByText("kiriman baru").length).toBe(1);
                                                             ^
error: expect(received).toBe(expected)

Expected: 1
Received: 2
```

`Received: 2` is the brief's own predicted duplicate, measured. The decision test discriminates between the two
answers rather than merely passing under mine.

---

## Global constraints, checked

- **Bahasa Indonesia throughout.** New user-visible strings: `Apa yang terjadi?`, `Kirim`, `Simpan`, `Batal`,
  `Untuk Anda`, `Mengikuti`, `Jenis beranda`, `Masuk untuk melihat`, `Belum ada kiriman dari orang yang Anda ikuti.`,
  `Hapus kiriman ini?`, `Ya, hapus`, `Tidak jadi`, `Konfirmasi hapus`,
  `Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.`, `Kiriman gagal disimpan.`,
  `Gagal menghapus kiriman.`
- **No raw server errors.** Both new failure paths compose their own Bahasa prefix and append
  `describeRequestFailure(err)`. `no-raw-server-errors.test.ts` passes over both new files — including the
  Task-4-widened typed-catch rule, which matters because both new `catch` bindings are written
  `catch (err: unknown)`. Three tests assert positively that the server's own string never reaches the screen
  (`internal server error`, `body must be at most 1000 characters`, `Failed to fetch`).
- **`role="alert"`** on both new request-failure paragraphs (`.post-composer-error`, Beranda's `.feed-error`), matching
  every other one under `src/user/`. The "sent, but not on this tab" notice is `role="status"`, not `alert` — it is
  not a failure.
- **No `expect(<DOM element>).toBeNull()`** anywhere; every absence is a `queryAll…().length` count.
  `no-hanging-dom-assertions.test.ts` passes.
- **`apps/web/src/dashboard/` untouched.** `styles.css` is additive only — 101 lines appended between the Task 4 block
  and the existing `@media (min-width: 768px)` block; no existing rule edited or deleted.
- **No route added.** `App.tsx` untouched.
- **`load` is memoised** on `tab` alone, per `PostFeed`'s contract.

---

## Concerns

1. **`signedIn` is read synchronously, not subscribed.** `BerandaPage` calls `isUserSignedIn()` during render, as the
   brief's code does, rather than `useSyncExternalStore(subscribeToUserAuth, ...)` the way `AppShell` does. Consequence:
   if a signed-in visitor's token expires and the `mengikuti` feed 401s, `apiFetch` clears the session and `PostFeed`
   shows `Sesi Anda sudah berakhir. Silakan masuk kembali.`, but Beranda does not re-render into the signed-out branch
   until something else re-renders it — so the composer stays on screen next to a dead session, and its next submit
   would 401 too. The error message is correct and actionable, and `AppShell`'s nav *does* update (it subscribes), so
   the state is untidy rather than misleading. I followed the brief here rather than diverging; switching to
   `useSyncExternalStore` is a two-line change if you want it. **Not verified against a real expired token** — only
   reasoned from `apiRequest`'s 401 branch.

2. **A create racing the first page load can lose the new post from view.** `PostFeed.fetchPage(null)` replaces `posts`
   wholesale, so if a first page resolves *after* a `prepend`, the prepended post is dropped from the list. The post is
   saved — only its display is lost until the next refetch. Reaching this needs someone to type and submit before the
   first page returns, which is milliseconds against seconds of typing; I judged a queue not worth the complexity.
   Recorded rather than fixed. **Not verified** — I did not construct the race.

3. **Nothing was run in a real browser.** All evidence is happy-dom under `bun test`. The `styles.css` additions in
   particular (the `.feed-tabs` underline, the composer layout, `.delete-confirm`'s wrap behaviour at narrow widths)
   are **not verified** visually at any viewport.

4. **`PostFeedHandle` is new public surface on a component Task 6 also consumes.** The profile posts tab will render
   `PostFeed` too, and will hit exactly the same "the page cannot remove a row it did not load" wall this task hit. The
   handle is there for it; if Task 6's brief still describes a page-held list, that brief needs the same correction.

5. **Two of my `settle()`-based absence assertions rely on a single macrotask tick.** `settle()` awaits
   `setTimeout(..., 0)` inside `act`. That is enough for the promise chains in these tests (it is the same idiom
   `PostFeed.test.tsx` already uses for its "exactly one request" test), but it is a timing assumption rather than a
   guarantee, and it is the shape most likely to become a flake if these tests ever run under contention. These are
   `apps/web` tests, so per the standing rule a failure there is real until proven otherwise — but this is where I would
   look first.

6. **The `restores the previous tab on a browser Back` test uses `createMemoryRouter` + `router.navigate(-1)` inside
   `act`**, which is a different rendering path from every other test in this repo (all `MemoryRouter`). It passed on
   every run, including as one of the seven reds under M3, so it is doing real work. Flagged only because it is
   unfamiliar shape for this codebase.

---

# Fix round 1

**Commits**

| SHA | |
|---|---|
| `f8e7ad4db399203417f14095fa598391fd3c9559` | `feat(web): Beranda's two tabs, and composing, editing and deleting` — the original task |
| `0592db28e8e8fe0928cf50e50e2e01706e6f95bb` | `fix(web): review round 1 — multi-row handle tests, one-shot notice, tab-change resets, onDeleteRequested` |

**Gates after the fix:** `bun run test` → **2774 pass / 0 fail** (shared 82, worker 38, web **618**, api 2036).
`bun run typecheck` → all four workspaces exit 0. Web grew by 20 tests: 618 − 598.

Two claims in the body above were **corrected in place** rather than only appended to — the `sentFrom` claim under
"defects found in the brief" (I3) and the auth-split claim under "four things, item 2". Both now carry a marked
CORRECTED block.

---

## Disposition

| # | Finding | Disposition |
|---|---|---|
| I1 | `remove(id)` ignores its id | **Fixed** — 6 direct multi-row `PostFeedHandle` tests added |
| I2 | `replace`'s "in place" unpinned | **Fixed** — same suite, order asserted |
| I3 | Sent notice returns forever | **Fixed** — `postSent` boolean + `useEffect` on `[tab]`; report corrected in place |
| R4 | `onDeleted` misnamed, docstring false | **Fixed** — renamed to `onDeleteRequested` across 5 files, docstring rewritten, contract pinned |
| Minor | `if (!canSubmit) return;` deletable | **Fixed** — 4 tests submitting the FORM, bypassing `disabled` |
| Minor | `key={editing.id}` deletable | **Fixed** — 2 two-post tests |
| — | Pending delete / edit composer survive a tab switch | **Fixed** — same `[tab]` effect; 4 tests |
| — | Concern 3, `signedIn` read once per render | **Fixed** — `useSyncExternalStore`, matching `AppShell` |
| Dead | `setFirstPageLoaded(true)` in `prepend` | **Deleted** |
| Dead | `setSentFrom(null)` on the untuk-anda create path | **Deleted** |
| Dead | `setDeleteError(null)` in `onEdit` / `onDeleteRequested` | **Pinned** — behaviour is right; 2 tests |
| — | Create racing the first page load | Recorded, not fixed, per the review |
| — | `createMemoryRouter` back-navigation test | Kept — confirmed sole catcher of a broken history push |

---

## I1 and I2 — the multi-row proof

`PostFeedHandle` had **zero** direct tests; every exercise of it went through `BerandaPage.test.tsx`'s one-row
fixtures. `PostFeed.test.tsx` gains a `describe("PostFeed — PostFeedHandle")` block of six tests, all on **three**
rows, all asserting the rendered bodies as an **ordered array** rather than membership:

```ts
function bodies(): string[] {
  return screen
    .getAllByRole("article")
    .map((article) => article.querySelector(".post-card-body")?.textContent ?? "");
}
```

Each test starts from a shared `renderThreeRows()` that asserts the fixture is three rows before returning — without
that guard, "the MIDDLE one" would mean nothing if the fixture ever shrank.

### I1 — `remove` → `current.slice(1)` (the reviewer's exact mutation)

Previously **598 pass / 0 fail**. Now:

```
(fail) PostFeed — PostFeedHandle > remove drops the post with THAT id, not whichever row happens to be first [9.73ms]
(fail) PostFeed — PostFeedHandle > remove leaves the list untouched for an id that is not on screen [7.52ms]
(fail) PostFeed — PostFeedHandle > keeps the handle usable across a refetch, still targeting the right row [45.84ms]
 615 pass
 3 fail
Ran 618 tests across 44 files. [4.42s]
```

```
310 |   it("remove drops the post with THAT id, not whichever row happens to be first", async () => {
311 |     const handle = await renderThreeRows();
312 |
313 |     act(() => handle.current!.remove("2"));
314 |
315 |     expect(bodies()).toEqual(["Isi kiriman 1", "Isi kiriman 3"]);
                           ^
error: expect(received).toEqual(expected)
```

The third failure is a bonus the fix round added on its own: `keeps the handle usable across a refetch` loads a first
page, clicks "Muat lebih banyak", then removes an id from the appended page — pinning that the stable handle and the
replaced `posts` array stay connected.

### I2 — `replace` → `[...current.filter(...), post]` (the reviewer's exact mutation)

Previously **598 pass / 0 fail**. Now:

```
(fail) PostFeed — PostFeedHandle > replace swaps a post IN PLACE — the row keeps its position [8.12ms]
(fail) PostFeed — PostFeedHandle > replace leaves the list untouched for a post that is not on screen [4.61ms]
 616 pass
 2 fail
Ran 618 tests across 44 files. [4.90s]
```

The in-place failure prints the exact user-visible consequence — the edited post jumping to the bottom of the feed:

```
error: expect(received).toEqual(expected)

@@ -2,5 +2,5 @@
    "Isi kiriman 1",
-   "Isi kiriman 2 (diubah)",
    "Isi kiriman 3",
+   "Isi kiriman 2 (diubah)",
  ]

- Expected  - 1
+ Received  + 1
```

...and the second, that a `replace` for a post which is not on screen must not **append** it:

```
@@ -4,3 +4,3 @@
    "Isi kiriman 3",
+   "tidak ada di sini",
  ]
```

---

## I3 — the notice is now one-shot

`sentFrom: Tab | null` compared against `tab` during render is gone. It is a plain `postSent: boolean`, cleared by a
new `useEffect` on `[tab]`. An **effect** rather than the two tab buttons' `onClick` because the tab also changes on
back/forward and on a shared link, neither of which goes through those handlers — that is the same reason the tab
lives in the URL in the first place.

Mutation — drop `setPostSent(false)` from the effect, restoring the old behaviour:

```
(fail) BerandaPage — a tab change clears what belonged to the old tab > does NOT show the sent notice again after leaving Mengikuti and returning [32.92ms]
 31 pass
 1 fail
```

The test walks the reviewer's exact path: post from Mengikuti → notice → Untuk Anda (notice gone) → **back to
Mengikuti** → notice must still be gone.

---

## The tab-change survivors

The same `useEffect` clears `editing`, `pendingDelete` and `deleteError`. Both survivors were worse than the notice:
`Hapus kiriman ini?` stayed on screen with zero articles behind it and `Ya, hapus` still fired a DELETE for a post
that was no longer rendered; an open edit composer's `Simpan` could still PATCH a post from the other tab.

Mutation — restore only `deleteError`/`postSent` clearing, letting `editing` and `pendingDelete` survive:

```
(fail) BerandaPage — a tab change clears what belonged to the old tab > drops a pending delete confirmation, so 'Ya, hapus' cannot fire for an unrendered post [34.17ms]
(fail) BerandaPage — a tab change clears what belonged to the old tab > closes an open edit composer, so Simpan cannot write to an unrendered post [11.03ms]
 30 pass
 2 fail
```

The delete test asserts the absence of the DELETE itself
(`calls.filter((call) => call.init?.method === "DELETE").length === 0`), not merely that the panel is gone.

> **Process note.** My first attempt at this mutation used
> `perl -pi -e 's/^    setEditing\(null\);\n//'`, which matched that line **everywhere** it appeared at that
> indentation — including inside `handleSaveEdit`. It produced two reds, one of them from the wrong place. Recorded
> because it is precisely the "a mutation surviving because the mutation was bad" failure mode named in the original
> brief, in its mirror form: a mutation *failing* for a reason other than the one being tested. Redone with an exact
> anchored replacement of the effect body alone, which is the run quoted above.

---

## R4 — `onDeleted` → `onDeleteRequested`

Renamed across `PostCard.tsx`, `PostFeed.tsx`, `BerandaPage.tsx`, `PostCard.test.tsx` and `PostFeed.test.tsx`
(17 occurrences; `grep -rn "onDeleted\b" apps/web/src/` now returns nothing). `PostCard.tsx`'s docstring previously
asserted *"the row is gone once this fires"*, which was false in both halves; it now opens
**"Raised on the TAP of `Hapus`, BEFORE anything has been deleted"** and states plainly what a consumer who trusted
the old sentence would build.

Because a docstring is not a test, the true half is now pinned:

```ts
it("does NOT remove the row itself when Hapus is tapped — the caller decides", ...)
```

Mutation — make `PostFeed` behave as the old docstring claimed, removing the row on the tap:

```
(fail) PostFeed > does NOT remove the row itself when Hapus is tapped — the caller decides [3.76ms]
 16 pass
 1 fail
```

---

## The two Minors

### `if (!canSubmit) return;`

Deletable at 598/0 because every path to `handleSubmit` went through a button carrying `disabled`. Four new tests
submit the **form** directly via a `submitForm(container)` helper, which is the only way a test reaches the guard — and
is what a real browser does on Enter and on `form.requestSubmit()`.

Mutation — delete the guard:

```
(fail) PostComposer — submitting > sends nothing when the FORM is submitted with an empty box [5.17ms]
(fail) PostComposer — submitting > sends nothing when the FORM is submitted with a whitespace-only box [3.32ms]
(fail) PostComposer — submitting > sends nothing when the FORM is submitted again mid-flight [3.57ms]
(fail) PostComposer — submitting > sends nothing when the FORM is submitted with an over-limit body [3.02ms]
 21 pass
 4 fail
```

### `key={editing.id}`

Two tests. The first pins the state — tap Edit on A, then Edit on B, and B's box must hold B's body. The second pins
the **harm**, and is the one worth having: nothing is retyped, the box is submitted exactly as the second Edit left it.

Mutation — delete the key:

```
(fail) BerandaPage — editing your own post > re-fills the box when Edit is tapped on a SECOND post without cancelling the first [5.77ms]
(fail) BerandaPage — editing your own post > saves the SECOND post's own text, never the first post's, when Edit is tapped twice [6.47ms]
 30 pass
 2 fail
```

```
790 |     expect(JSON.parse(String(calls[1]!.init?.body)).body).toBe("isi dua");
                                                                ^
error: expect(received).toBe(expected)

Expected: "isi dua"
Received: "isi satu"
```

`Received: "isi satu"` sent to `/users/posts/p2` is the silent overwrite, measured.

> **Honesty note.** My first version of that second test retyped the body before saving, and it **survived** the
> missing-key mutation — it was pinning the PATCH *target*, not the key. It was rewritten to submit without retyping,
> which is both the real user path and what makes it bite. Flagged because a test that survives the mutation it was
> written for is exactly the vacuous-assertion failure mode this branch keeps paying for, and I nearly shipped one
> while fixing a finding about the same thing.

---

## Concern 3 — `signedIn` is now subscribed

```tsx
const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);
```

The same pattern `AppShell` uses, and the reason `isUserSignedIn` returns a boolean rather than the token — a stable
snapshot. Mutation back to `isUserSignedIn()`:

```
(fail) BerandaPage — a session that expires mid-browse > drops the composer when Mengikuti's 401 clears the session [1007.00ms]
 31 pass
 1 fail
```

**One consequence worth stating, because it is a trade rather than a pure win.** When the 401 clears the session on
Mengikuti, `PostFeed` unmounts and the signed-out branch takes over — so the visitor sees the `Masuk untuk melihat`
link **instead of** `Sesi Anda sudah berakhir. Silakan masuk kembali.`, which `PostFeed` would otherwise have shown.
The link is the more actionable of the two and it goes to the right place, but the explanation is lost. Carrying both
would mean tracking "was signed in a moment ago" as its own state; I judged that not worth the extra state and have
recorded the trade rather than made it silently. The test asserts the composer, the `Kirim` button and the textarea are
all gone and that `getUserToken()` is null.

---

## Dead resets

- **`setFirstPageLoaded(true)` inside `prepend` — deleted.** The empty state renders on
  `firstPageLoaded && posts.length === 0 && !loading`; a prepend guarantees ≥ 1 row, so the second conjunct is already
  false and the line could not change the outcome its comment claimed to protect. `prepend` is now a one-line updater.
- **`setSentFrom(null)` on the untuk-anda create path — deleted.** `postSent` can only ever be set from Mengikuti, and
  the `[tab]` effect clears it on the way to Untuk Anda, so this was a third state nothing owned.
- **`setDeleteError(null)` in `onEdit` and `onDeleteRequested` — kept and pinned.** The behaviour is right: a failure
  about the *last* delete must not sit under the confirmation panel for the *next* one, where it reads as a failure
  that has already happened to the post you are about to confirm. Mutation (both call sites removed):

```
(fail) BerandaPage — deleting your own post > clears a previous delete failure when another delete is requested [12.17ms]
(fail) BerandaPage — deleting your own post > clears a previous delete failure when an edit is started instead [9.13ms]
 30 pass
 2 fail
```

---

## Standing constraints, re-checked after the fix

- Every mutation above was restored; `grep -c MUTATED` returns 0 in all three source files, and the final gates were
  run from the restored tree.
- New user-visible copy: none. The rename, the effect and the subscription are all invisible to a reader; the only
  copy touched is the notice, whose text is unchanged.
- `role="alert"` unchanged on both failure paragraphs. The new `role="status"` notice is still not an alert.
- No `expect(<DOM element>).toBeNull()`; the new `getUserToken() === null` assertion is a token string, not a DOM node,
  and is written in the safe `=== null).toBe(true)` form regardless.
- `apps/web/src/dashboard/` untouched. `styles.css` untouched this round.
- No route added; `App.tsx` untouched.

## Concerns after this round

1. **The lost expiry explanation**, described under Concern 3 above. It is a deliberate trade, and the one thing in
   this round I would most expect a reviewer to want the other way.
2. **`renderThreeRows()` asserts inside a helper.** A failure there reports at the helper's line rather than the
   caller's, so a broken fixture will name the wrong test first. Accepted because the alternative — repeating the
   three-row guard in six tests — is what let the one-row fixtures go unnoticed in the first place.
3. **Still nothing run in a real browser.** Unchanged from the original report: the `styles.css` additions are **not
   verified** visually at any viewport.
