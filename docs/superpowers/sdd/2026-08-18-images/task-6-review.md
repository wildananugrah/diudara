# Task 6 review — `mediaIds` on create and edit, and the post projection

**Commit reviewed:** `f62ec77` (diff `a007525..f62ec77`, 1,140 insertions / 76 deletions across 10 files)
**Branch:** `feat/images`, worktree `.worktrees/images`.
**Method:** every semantic below was verified by mutating the implementation and observing which
named tests redden. The report was not trusted as evidence. The full api suite was not re-run.

---

## Verdicts

**1. Spec compliance (§5.2, §8): ✅**
**2. Task quality: approved, with 4 Minor findings.** No Critical, no Important.

---

## Baseline

```
bun test src/application/use-cases/post-views.test.ts \
         src/application/use-cases/read-posts.test.ts \
         src/application/use-cases/write-post.test.ts \
         src/routes/posts.test.ts
 89 pass  0 fail  207 expect() calls  [27.47s]
```

`bunx tsc --noEmit` in `apps/api`: clean (exit 0). `src/bootstrap.test.ts` + `src/routes/media.test.ts`:
175 pass, 0 fail.

---

## Mutation testing — every semantic, verified

Each row is a mutation I applied to a clean HEAD, ran, and reverted (`git checkout --`), confirming
`git status` clean after each.

| # | Mutation | Result |
|---|---|---|
| 1 | `requireAttachable`: drop the "or already claimed by this same post" clause (`row.postId !== null && row.postId !== ownPostId` → `row.postId !== null`) | **2 unit fail**: `EditPost > may keep the post's OWN existing media`, `EditPost > removing an image unclaims its row…`. **4 route fail**, incl. `an edit may keep the post's OWN existing media` |
| 2 | Widen the rule to accept media claimed by any post (`if (false as boolean)`) | **2 unit fail**: `CreatePost > refuses media already claimed by another post`, `EditPost > refuses media claimed by a DIFFERENT post`. **1 route fail**: `refuses media already claimed by a DIFFERENT post — 400` |
| 3 | Drop the owner check (`row === undefined \|\| row.ownerId !== actorId` → `row === undefined`) | **2 unit fail**, **1 route fail**: `refuses media that belongs to someone else — 400, and no post is created` |
| 2+3 | Both guards removed together | **3 route fail**, incl. `an edit cannot steal media out of another PERSON'S post` — confirming that test is not vacuous, it is the belt-and-braces one that only falls when both clauses do |
| 4a | `claim`'s release step deletes instead of nulling (`tx.delete(...).where(eq(postMedia.postId, postId))`) | **5 route fail**, incl. `removing an image UNCLAIMS it rather than deleting it` |
| 4b | Precise inline-delete: delete only rows on this post **not in** `ids` (the exact implementation §11 warns about) | **3 route fail**: `removing an image UNCLAIMS it rather than deleting it`, `an explicit empty mediaIds strips every image, unclaiming each row`, `editing one post never disturbs another post's media` |
| 5 | `updateBody` sets `edited_at` only when the body actually changed (`case when "post"."body" = $2 then "post"."edited_at" else now() end`) | **exactly 1 route fail**: `an image-only change still sets editedAt` |
| 6 | Add `bucket: "diudara"` to the post projection and `postId` to each media entry | **3 unit fail** (`toPostView > returns EXACTLY the wire keys`, `toPostView > returns EXACTLY id, width and height per image…`, `ListFeed > hands each post its own images`); **2 route fail** (`201s for a signed-in caller, with EXACTLY the wire keys`, `keeps the projection closed — the post's keys and each image's keys`) |
| 7 | Widen `claim`'s release `WHERE` to unconditional (`tx.update(postMedia).set({ postId: null })`) | **2 route fail**: `editing one post never disturbs another post's media`, `media reach the feed too, each post with its own images in order` |
| 8 | `claim` unconditionally even when `mediaIds` is omitted | **1 unit fail** `EditPost > leaves the images alone when mediaIds is omitted entirely`; **1 route fail** `a PATCH without mediaIds leaves the post's images alone` |
| 9 | Collapse the other direction: treat `[]` as omitted | **1 unit fail** `EditPost > an explicit empty mediaIds removes every image`; **1 route fail** `an explicit empty mediaIds strips every image, unclaiming each row` |
| 10 | Drop the duplicate-id check | **1 unit fail**: `CreatePost > refuses the same image listed twice` |
| 11 | `pageWithMedia` loops `listForPost` per row instead of one `listForPosts` | **3 unit fail**: both `fetches the page's media in a SINGLE listForPosts call` tests plus `hands each post its own images` (the fake's `listForPost` throws "a feed must never look media up one post at a time") |

**Every semantic the brief named is pinned by a named test at the layer where it lives, and in most
cases at both layers.**

---

## The specific things I was asked to confirm

### Editing replaces the whole list
`EditPost.execute` passes `input.mediaIds` straight to `MediaRepositoryPort.claim(postId, ids)`,
whose Drizzle implementation releases everything currently on the post and re-attaches `ids` in
array order, both inside one transaction. No add/remove/move verbs anywhere. Reordering is exercised
(`attaches media to a new post, in the order given` sends `[second, first]`).

### The ownership rule differs from POST by exactly one clause
`requireAttachable(media, actorId, ids, ownPostId)` is shared; `ownPostId` is `null` on create and
the post id on edit. Both directions verified — mutations 1 and 2 above.

### Removed images are UNCLAIMED, not deleted
`apps/api/src/routes/posts.test.ts:702` asserts the **intermediate state** through a
`DrizzleMediaRepository` over the same database: `findById(second)` is `{ postId: null }` and
`findById(first)` still points at the post. Mutation 4b (delete only the removed rows — the exact
implementation §11 says a weak test would pass against) reddens it. `write-post.test.ts:409` asserts
`media.deletes` is empty at the use-case layer.

### An image-only change still sets `edited_at`
`updateBody` is called unconditionally in `EditPost`; mutation 5 reddens exactly one named test.

### The projection stays closed
`toPostView` builds an object literal with exactly six keys; `toMediaView` with exactly three.
Mutation 6 reddens five tests across both layers. No bucket key, no URL, no `ownerId`, no `postId`,
no `position`, no `byteSize` anywhere in the view types.

### One query per page
`read-posts.ts`'s private `pageWithMedia` does `listForPosts(rows.map(r => r.id))`, once, for both
`ListFeed` (both tabs) and `ListUserPosts`. The unit fakes record every call and assert
`forPostsCalls` equals exactly one array of exactly the page's ids, and the fake's `listForPost`
(singular) throws on sight. Mutation 11 reddens all three. `listForPosts([])` short-circuits in the
repository, so an empty page issues no query at all.

### The two pre-existing projection tests were widened, not weakened
Confirmed by reading the diff hunks, not the report:

- `apps/api/src/application/use-cases/post-views.test.ts:18` (`returns EXACTLY the wire keys`) —
  `["author","body","createdAt","editedAt","id"]` → the same five plus `"media"`. The
  `Object.keys(...).sort()` equality is intact; nothing was relaxed to `toContain` or `toMatchObject`.
  Three further tests were **added** around it (empty-array-never-missing-key, the media entry's
  exact three keys, order preservation).
- `apps/api/src/routes/posts.test.ts:94` (`201s for a signed-in caller, with EXACTLY the wire keys`)
  — same widening, plus `expect(body.media).toEqual([])` so the no-image case is asserted at the
  route too. A second route test (`keeps the projection closed`) asserts both key sets on a post
  that actually carries an image.

No projection test was deleted or downgraded.

### `bootstrap.ts` / `bootstrap.test.ts` are additive wiring
`mediaRepository` moved up to sit beside `postRepository` (it depends on nothing but `db`) and is
passed to `createPost`, `editPost`, `listFeed`, `listUserPosts`. The **same instance** still reaches
`UploadMedia` and the delivery routes — verified by reading, and `routes/media.test.ts` +
`bootstrap.test.ts` are 175 pass / 0 fail. `bootstrap.test.ts`'s only change is the two hand-built
`Dependencies` literals gaining the already-present `fakeMediaRepository` for the new constructor
arities. Nothing behaviour-changing for other code.

### Soft-deleted posts still never appear on any read path
This task changed no `WHERE` in `drizzle-post.repository.ts`. All three list methods still carry
`isNull(posts.deletedAt)` (`listGlobal:112`, `listByAuthor:116`, `listFollowing:127`), `readOne`
carries it, and `EditPost` keeps its `owned.isDeleted → NotFoundError`. Media is fetched **from the
ids the post repository already returned**, so it cannot widen the row set — `listForPosts` is a
lookup keyed on rows that already survived the filter. The existing route test `a deleted post is
absent from GET /users/feed?tab=untuk-anda AND from GET /users/:handle/posts` still passes.
§9's named biggest risk does not materialise here.

### Tests assert literal values, never the constants they check
No new test imports `MEDIA_NOT_YOURS_MESSAGE`, `MEDIA_TAKEN_MESSAGE`, `MEDIA_DUPLICATE_MESSAGE`,
`MAX_POST_BODY_LENGTH` or the view types' key lists. Key sets are written out as literal string
arrays; ids are literal uuids; dimensions are the literal `1600`/`900` the fixture row carries.

---

## Task 1's inherited finding — closed

`routes/posts.test.ts:773` — `editing one post never disturbs another post's media`. One author
creates post A `[a1, a2]` and post B `[b1, b2]`, edits A down to `[a1]`, then asserts through a real
`DrizzleMediaRepository` that `listForPost(B)` is still `[b1, b2]` in order, that `a2`'s row is
`postId: null`, and that B's images still render on `GET /users/wildan/posts`.

**Both posts belong to the same author**, so no ownership check stands between them — the only thing
protecting B is `claim`'s release clause `WHERE post_id = $1`. I widened that clause to
unconditional (mutation 7) and the test **reddens by name**, along with `media reach the feed too`.
The finding is genuinely closed, and closed in the way the reviewer specified.

---

## The three rulings — verified

**Ruling 1 — omitted `mediaIds` leaves images alone; explicit `[]` strips them. Upheld, and correctly
implemented.** The distinction is pinned by four tests, two per layer:

| | omitted | explicit `[]` |
|---|---|---|
| use case | `EditPost > leaves the images alone when mediaIds is omitted entirely` (`write-post.test.ts:368`) | `EditPost > an explicit empty mediaIds removes every image` (`write-post.test.ts:384`) |
| route | `a PATCH without mediaIds leaves the post's images alone` (`posts.test.ts:735`) | `an explicit empty mediaIds strips every image, unclaiming each row` (`posts.test.ts:717`) |

Collapsing the distinction in **either** direction reddens a named test at **both** layers
(mutations 8 and 9). The route schema's `.optional()` is what carries it — Zod strips unknown keys,
so the field must be declared for absent and empty to remain distinguishable at all, and the
implementer documented exactly that. The `bio`-on-`updateProfileSchema` precedent holds: this is the
same shape. On `POST`, absent and empty correctly mean the same thing (there is nothing to keep),
and that is stated in the input type's docstring.

I agree with the ruling. A literal reading of "the COMPLETE desired list" applied to an absent field
would have silently wiped photos on every text-only edit, including every pre-existing `PATCH` test
in the file.

**Ruling 2 — the duplicate-id refusal stands. Upheld.** Implemented as
`if (new Set(ids).size !== ids.length) throw new ValidationError(MEDIA_DUPLICATE_MESSAGE)` at the top
of `requireAttachable`, before any repository call. Pinned by `CreatePost > refuses the same image
listed twice` (`write-post.test.ts:252`); dropping the check reddens exactly that test and nothing
else. It cannot reject a legitimate request: it fires only on an exact repeat **within a single
list**, and no legitimate whole-list request repeats an id (reordering, keeping and adding all
produce distinct ids). Empty and single-element lists short-circuit or pass trivially. The rationale
is sound — one row holds one `position`, so a repeat would return fewer images than requested, which
is precisely the request/result disagreement the whole-list semantics exist to prevent.

**Ruling 3 — an image-only post stays a 400. Upheld, and the task did not change it.** The diff to
`write-post.ts` touches `requireBody` only by hoisting its result into a `const`; the function body
(`trim`, then empty check, then length check) is byte-identical, and it runs **unconditionally before**
any `mediaIds` handling on both create and edit. `rejects an empty body with 400` still passes. No
route or schema change relaxes it (`postBodySchema` deliberately has no `.min(1)`, unchanged). Nothing
was quietly moved in either direction.

---

## Findings

### Minor 1 — the `FakeMediaStorageAdapter` half of the unclaim test cannot fail

`apps/api/src/application/use-cases/write-post.test.ts:409` (`removing an image unclaims its row and
leaves the bytes in storage`) constructs a `FakeMediaStorageAdapter`, puts bytes in it, and after
the edit asserts `storage.get(SECOND_IMAGE, "full")` and `"thumb"` are not null. **`EditPost` holds
no storage port** — its constructor is `(posts, media)` — so nothing it could ever do would remove
those bytes. The assertion is unconditionally true and provides no mutation coverage; any change
that made it fail would first have to change `EditPost`'s constructor, which would break the test's
compilation anyway.

The rule it is reaching for *is* genuinely covered: `expect(media.deletes).toEqual([])` in the same
test is real (a repository `deleteById` would be recorded), and the route test asserts the surviving
row against the real database. So nothing is unproven — the storage lines are decoration, not a hole.
Worth either dropping them or converting the comment to say they document intent rather than assert it.

### Minor 2 — none of the three new Bahasa refusal messages is asserted anywhere

`MEDIA_NOT_YOURS_MESSAGE`, `MEDIA_TAKEN_MESSAGE` and `MEDIA_DUPLICATE_MESSAGE` are distinguished
carefully in the code and explained at length in the docstring, but every test asserts only
`ValidationError` / status `400`. A change that collapsed all three to one string, or — more to the
point — that **split** the shared unknown/not-yours message into a distinct "foto tidak ditemukan",
would leave the suite green while re-introducing exactly the existence oracle the docstring says the
shared message exists to prevent.

This is a deviation from the codebase's own convention: `routes/media.test.ts:89`,
`join-requests.test.ts:252,306` and `communities.test.ts:254` all assert their user-facing Bahasa
strings verbatim. The cheap fix is one test asserting that an unknown id and another person's id
return the **same** message body.

### Minor 3 — the duplicate refusal is pinned only at the use-case layer

`refuses the same image listed twice` lives in `write-post.test.ts`. There is no route-level
equivalent, and no `EditPost` equivalent either. The check sits in the shared helper so both paths do
get it, and the schema does not dedupe, so the coverage is adequate — but every other rule in this
task is pinned at both layers, and this one is the odd one out.

### Minor 4 — the report's mutation table misnames one reddened test

The report's row *"Accept media claimed by any post (`if (false)`) → 3 fail, incl. `refuses media
already claimed by a DIFFERENT post`, `an edit cannot steal media out of another PERSON'S post`"* is
wrong on its second name. I reproduced the mutation: 3 tests fail, but they are the two unit tests
plus one route test — `an edit cannot steal media out of another PERSON'S post` **stays green**,
because the victim's media is caught first by the *owner* clause, not the claimed-by-another-post
clause. Same for the drop-the-owner-check row: that test stays green there too, caught by the
claimed clause.

The property is fully covered (I verified the test reddens when **both** clauses are removed, so it
is not vacuous — it is the belt-and-braces test) and the reviewer's required mutation does redden a
named test. This is an accuracy defect in the report's evidence, not in the code or the tests. Worth
recording because the report's mutation table is what a later reader will trust.

---

## Observations (not findings)

- **`MAX_POST_IMAGES` is not enforced**, so `mediaIds` accepts an array of any length today —
  including one long enough to build a very large `IN (...)`. Spec §5 requires the refusal, but the
  Task 6 brief does not mention it and `progress.md:482-483` explicitly carries it to Task 7
  (`postBodySchema` will need `.max()`, which means `postRoutes` gaining that dependency). Correctly
  scoped out; flagged here only so Task 7's reviewer does not assume the hook already exists.
- **No transaction spans `updateBody` and `claim`** in `EditPost`, nor `posts.create` and `claim` in
  `CreatePost`. A failure between them leaves the body edited but the images not, or a post created
  with no images. The ordering chosen (validate everything first, write last) minimises the window,
  and the repository's `claim` is itself transactional. Consistent with how the rest of this codebase
  handles multi-step writes; not worth changing here.
- **A time-of-check/time-of-use window exists** between `requireAttachable` and `claim`: two
  concurrent requests by the same author naming the same media id would both validate, and the second
  `claim` would silently move the image off the first post. Requires a user racing themselves, and the
  outcome is a lost image rather than a leak. Noting for completeness only.
- **`listForPosts` orders by `position` alone**, globally, so rows of different posts interleave in
  the flat list. Grouping still preserves each post's own order because a post's positions are
  distinct — correct as written, and the implementer flagged the reliance honestly. An explicit
  `orderBy(postId, position)` would make it robust without relying on that argument.
- **`apps/web/src/user/apiClient.ts`'s `PostView` does not declare `media`.** Extra JSON keys are
  harmless at runtime and the web is Tasks 8/9's; correctly left alone.

---

## Hygiene

Every mutation above was reverted with `git checkout --` and the working tree confirmed clean
between runs. Final state:

```
$ git status --porcelain
(no output)
$ git diff --stat
(no output)
$ bun test <the four covering files>
 89 pass  0 fail  207 expect() calls
```

The tree is clean at `f62ec77`. Nothing was left applied.
