# Task 6 implementer report — `mediaIds` on create and edit, and the post projection

**Commit:** `f62ec77` — `feat(api): posts carry media, and an edit replaces the whole list`
**Branch:** `feat/images` (worktree `.worktrees/images`). Working tree clean.

---

## What I built

### The projection (`application/use-cases/post-views.ts`)

`PostView` gains `media: MediaView[]`, and `MediaView` is exactly `{ id, width, height }`.
The post's key set is now exactly `author, body, createdAt, editedAt, id, media`; a post with no
images gets `[]`, never a missing key, so the key set never varies.

`toPostView(row, media)` and `toFeedPage(rows, limit, media)` both take media as a **required**
argument rather than defaulting it to `[]`. A default would let a future call site forget it and
publish every post as image-less, which is indistinguishable in the response from a post that
genuinely has none.

`toFeedPage` does the grouping: it receives ONE flat media list for the whole page and maps it onto
the kept rows by `postId`. The caller fetches media for every row it asked the repository for —
including the probe row — because `toFeedPage` is the only thing that knows which rows survive the
slice, and it drops the probe's media along with the probe.

### Writing (`application/use-cases/write-post.ts`)

One shared helper, `requireAttachable(media, actorId, ids, ownPostId)`, because create and edit
differ by exactly one clause (§5.2). An id is accepted when it exists, belongs to the actor, and is
either unclaimed **or** already claimed by `ownPostId` — the post being edited, or `null` on create.
Refusals are `ValidationError` (400) in Bahasa:

- unknown id, or someone else's → `foto tidak ditemukan atau bukan milik Anda` (one message on
  purpose: a distinct "no such photo" would be an existence oracle for other people's ids)
- claimed by a different post → `foto sudah dipakai kiriman lain`
- the same id listed twice → `foto yang sama tidak boleh dipakai dua kali`

The duplicate check is mine, not the brief's, and the reason is in the code: one row holds one
`position`, so the same id twice would claim it once and hand back a post with fewer images than
were asked for — a silent disagreement between request and result, which is the exact thing the
complete-list semantics exist to rule out.

`CreatePost` validates **before** `posts.create`, so a refused `mediaIds` leaves no stray post.
`EditPost` validates after the ownership/deleted checks (a stranger still gets 403, not a media
error) and **before** `updateBody`, so a rejected image list leaves the body untouched too.

Both read the media back with `listForPost` after claiming, rather than echoing the ids: what the
client gets is what a reload would show, ordered by the `position` that was actually stored.

An image-only change sets `editedAt` because `updateBody` is called unconditionally and sets
`edited_at` itself (§5.3) — no special case was needed, and the behaviour is now pinned by a test.

### Reading (`application/use-cases/read-posts.ts`)

`ListFeed` and `ListUserPosts` take `MediaRepositoryPort`. One private module function,
`pageWithMedia`, does `listForPosts(rows.map(r => r.id))` — **one query per page, never per row.**
Pinned by two unit tests that assert `listForPosts` was called exactly once with exactly the page's
ids, and by a fake whose `listForPost` (singular) throws "a feed must never look media up one post
at a time".

### The routes (`routes/posts.ts`) and wiring (`bootstrap.ts`)

`postBodySchema` gains `mediaIds: z.array(z.string().uuid()).optional()`. The `.optional()` is
load-bearing (see below). Uuid-shape validation here keeps a malformed id out of a uuid column, the
same defect `:id` params were already fixed for; ownership is decided in the use case.

`bootstrap.ts` constructs `mediaRepository` up with `postRepository` (it needs nothing but `db`) and
passes it to `createPost`, `editPost`, `listFeed` and `listUserPosts`. `uploadMedia` keeps the same
instance further down.

---

## One decision the brief and spec did not settle: omitted vs empty `mediaIds`

`PATCH` distinguishes them:

- `mediaIds: []` — the caller asking for **no images**. Every row is unclaimed.
- **field omitted** — the caller saying nothing about images at all: a text-only edit. The post's
  images are left exactly as they were, and `claim` is not called.

I chose this because every pre-existing `PATCH` test in `posts.test.ts` sends `{ body }` alone, and
an API where omitting a field wipes data is a trap. Spec §7 says the edit composer always sends the
resulting list, so a real client never relies on the omitted case — but a partial request must not
destroy data. Both behaviours are pinned by named tests at both layers, and the mutation that
collapses the distinction reddens two of them.

---

## Red phase

I did not need stubs: the signature changes are type-level only (bun strips types), so every new
test loaded and ran, and every one failed on **its own assertion** rather than on a load error.

`bun test src/routes/posts.test.ts src/application/use-cases/post-views.test.ts
src/application/use-cases/write-post.test.ts src/application/use-cases/read-posts.test.ts`

```
 54 pass
 35 fail
 153 expect() calls
Ran 89 tests across 4 files. [27.39s]
```

Representative failures — all assertion failures, no load errors:

```
error: expect(received).toEqual(expected)
@@ -6,3 +6,3 @@
    "id",
-   "media",
  ]
(fail) toPostView > returns EXACTLY the wire keys, with the author nested

expect("media" in view).toBe(true);   Expected: true   Received: false
(fail) toPostView > gives a post with no images an EMPTY media array, never a missing key

TypeError: undefined is not an object (evaluating 'page.posts[0].media.map')
(fail) toFeedPage > groups a flat media list onto the right posts, each in its own order
```

The full red list (35): 6 in `post-views.test.ts`, 12 in `write-post.test.ts`, 3 in
`read-posts.test.ts`, 14 in `posts.test.ts` (13 new + the widened projection test).

---

## The two pre-existing projection tests

Both were **widened, not deleted or weakened** — the closed projection is a global constraint and
these two are what enforce it.

- `apps/api/src/application/use-cases/post-views.test.ts:18` —
  `["author","body","createdAt","editedAt","id"]` → the same list plus `"media"`. I also added a
  companion test asserting each media entry's keys are exactly `["height","id","width"]` and that
  the entry equals `{id, width, height}` — so `ownerId`, `postId`, `position` and `byteSize`, all of
  which a `MediaRow` carries, are pinned as absent.
- `apps/api/src/routes/posts.test.ts:94` — same widening, plus `expect(body.media).toEqual([])`, so
  the no-images case is asserted at the route as well. A second route test
  ("keeps the projection closed") asserts both levels on a post that actually has an image.

---

## The cross-post `claim` test (Task 1's deferred finding)

`posts.test.ts` → "editing one post never disturbs another post's media".

One author creates post A holding `[a1, a2]` and post B holding `[b1, b2]`, then edits A down to
`[a1]`. The test asserts, through a `DrizzleMediaRepository` over the same database:

- `listForPost(B)` is still `[b1, b2]`, in order,
- `a2`'s row is `postId: null` (unclaimed, not deleted),
- and B's images still appear on `GET /users/wildan/posts`.

**Both posts belong to the same author on purpose.** No ownership check stands between them, so the
only thing protecting B is `claim`'s release clause `WHERE post_id = $1`. I verified this closes the
finding by mutating that clause away (`.where(...)` removed, unclaiming every post's media): the
test goes red by name. It was green under that mutation before this task.

The sibling rule — "cannot steal another PERSON'S post's media" (§11) — is a separate test: it
asserts the 400 **and** that the victim's row still points at her post and her post still shows the
image, because a check that rejected after already unclaiming would satisfy only the first half.

## Unclaim, proven at both layers (§11)

- **Route test** (`posts.test.ts`): after removing an image, `mediaRepo().findById(second)` is
  `{ postId: null }` and the kept image still points at the post. Asserted against the database,
  because route tests build the app via `createApp(bootstrap())` and hold no handle on its storage.
- **Use-case test** (`write-post.test.ts`): a `FakeMediaStorageAdapter` is injected directly, and
  after the edit `storage.get(removed, "full")` and `"thumb"` both still return bytes, the row is
  `postId: null`, and `media.deletes` is empty. The in-memory media fake there implements `claim`'s
  real contract (release, then re-attach in order) — a recording-only double would let this pass
  with no state ever changing.

---

## Mutation testing (run after committing, against a clean HEAD)

| Mutation | Result |
|---|---|
| Drop the "or already claimed by this same post" clause | 6 fail, incl. `an edit may keep the post's OWN existing media` |
| Accept media claimed by any post (`if (false)`) | 3 fail, incl. `refuses media already claimed by a DIFFERENT post`, `an edit cannot steal media out of another PERSON'S post` |
| Drop the owner check | 3 fail, incl. `refuses media that belongs to someone else` |
| Widen `claim`'s release `WHERE` to unconditional | 2 fail: `editing one post never disturbs another post's media`, `media reach the feed too` |
| `claim` unconditionally even when `mediaIds` omitted | 2 fail: `a PATCH without mediaIds leaves the post's images alone`, `leaves the images alone when mediaIds is omitted entirely` |
| Hand every post the whole page's media (no grouping) | 6 fail across all three layers |
| Drop the duplicate-id check | 1 fail: `refuses the same image listed twice` |

Working tree verified clean after each revert.

---

## Test counts

| | before | after |
|---|---|---|
| The four covering files | 54 | 89 (+35) |
| Full api suite | 2100 | **2135 pass, 0 fail**, 5721 expect() calls, 145 files, 237.88s |

`bunx tsc --noEmit` in `apps/api` is clean. `bootstrap.test.ts` needed its two hand-built
`Dependencies` literals updated for the new constructor arities — it already had a
`fakeMediaRepository`, which I reused and whose docstring I updated.

---

## Things I am not certain about

1. **`MAX_POST_IMAGES` is not enforced here.** `progress.md` assigns it to Task 7
   (`resolveMaxPostImages` in `bootstrap.ts`, `.env.example`, `GET /users/limits`), and my brief
   does not mention it, so `mediaIds` currently accepts an array of any length. If Task 7 is
   expected to find the route-schema hook already in place, it is not — `postBodySchema` will need
   `.max(maxPostImages)` wired from bootstrap, which means `postRoutes` gaining that dependency.
2. **A post still requires a non-empty body.** `requireBody` is unchanged, so an image-only post
   with no text is a 400. Nothing in §5.2/§7 asked for it and I did not want to relax an existing
   rule uninstructed — but if the composer is meant to allow "just a photo", that is a deliberate
   change someone has to make, not an oversight to inherit.
3. **`apps/web/src/user/apiClient.ts`'s `PostView` does not declare `media`.** Extra JSON keys are
   harmless at runtime and the web is Task 8/9's, so I left it alone.
4. **Order within `listForPosts`.** It orders by `position` only, globally, so rows of different
   posts interleave; grouping preserves each post's own relative order because a post's positions
   are distinct. Correct as written, but it relies on that, and a reviewer may prefer an explicit
   `orderBy(postId, position)`.
