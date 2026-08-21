# Phase 6 — Exclusive Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can mark a post members-only; its images reach paying members and nobody else.

**Architecture:** One column on `post`, and **two independent barriers**. The projection never sends a
media id to a non-member (parent spec §5.1), and the media route independently refuses one it did not
send — because a paying member holds legitimate ids and can pass them on. Entitlement is one batched
query per page, decided in the use case where a test can point at it.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm, Postgres, React 19 + Vite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-21-exclusive-content-design.md`

## Global Constraints

- **All user-facing copy is Bahasa Indonesia.** `NotFoundError` messages are English at every call site.
- **`/dashboard/*` and its six tables are UNTOUCHABLE**: `community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`.
- **`isMemberOf` must not change** — `apps/api/src/application/use-cases/is-member-of.ts` is byte-identical to its Phase 5a form and pinned by an `EXPLAIN` test. Reuse its predicate; never edit it.
- **Never turn `/users/media/:id` into a redirect.** Read the comment at `apps/api/src/routes/media.ts:125` before touching that file.
- **Both guard tests live in `apps/web`**: `apps/web/src/test/no-raw-server-errors.test.ts` and `apps/web/src/test/no-hanging-dom-assertions.test.ts`. There is no `apps/api/src/test/no-raw-server-errors.test.ts`. Both must stay green.
- **Never put a DOM node on either side of an assertion that can fail** — it serialises the node's whole object graph and has taken this machine down once. Use the `isNode` helper in `BerandaPage.test.tsx`, or compare `textContent` strings.
- Tests assert **literal values**, never the constant they check.
- **Read the clock once per operation** and pass the `Date` down. Phase 5b shipped a residual (m-8) caused by one use case reading `clock.now()` twice around a query.
- **The api suite takes ~300s.** Run it in the FOREGROUND with `timeout: 450000`; a backgrounded run never wakes a subagent.
- Never run a dev server, bind a port, or drive a browser.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema.ts` | `posts.visibility` column |
| `apps/api/src/application/ports/post-repository.port.ts` | `PostRow` gains `authorId`, `visibility` |
| `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts` | `postColumns` selects the two new fields |
| `apps/api/src/application/ports/user-subscription-repository.port.ts` | `listActiveOwnersAmong` |
| `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts` | its query |
| `apps/api/src/application/use-cases/post-views.ts` | `toPostView`'s `locked` parameter; the wire shape |
| `apps/api/src/application/use-cases/read-posts.ts` | the batched entitlement step |
| `apps/api/src/application/use-cases/write-post.ts` | the members-needs-an-image rule |
| `apps/api/src/routes/media.ts` | barrier two + the cache header |
| `apps/web/src/user/PostComposer.tsx` | the "Khusus anggota" control |
| `apps/web/src/user/PostCard.tsx` | the lock panel |

---

### Task 1: The column, and `PostRow` learns who wrote the post

**Files:**
- Modify: `apps/api/src/db/schema.ts` (the `posts` table)
- Create: `apps/api/drizzle/<generated>.sql` (via `bun run db:generate`)
- Modify: `apps/api/src/application/ports/post-repository.port.ts:11-18`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-post.repository.ts:18-25`
- Test: `apps/api/src/infrastructure/repositories/drizzle-post.repository.test.ts`

**Interfaces:**
- Produces: `PostRow` gains `authorId: string` and `visibility: "public" | "members"`. Every later task reads both.

`PostRow` today carries `authorHandle` and `authorDisplayName` but **no `authorId`** — and the gate
cannot work without it, because entitlement is a question about ids, not handles.

- [ ] **Step 1: Write the failing test**

```ts
test("a post row carries its author's id and its visibility, defaulting to public", async () => {
  const author = await seedUser({ handle: "rina" });
  // NOTE: `create` is POSITIONAL — `create(authorId: string, body: string)`.
  const post = await repo.create(author.id, "halo");
  const rows = await repo.listByAuthor(author.id, 10, null);
  expect(rows[0]?.authorId).toBe(author.id);
  expect(rows[0]?.visibility).toBe("public");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && bun test drizzle-post.repository.test.ts`
Expected: FAIL — `rows[0].authorId` is `undefined`.

- [ ] **Step 3: Add the column**

```ts
// posts, in schema.ts. VARCHAR, not an enum — the reasoning subscription.status
// already records: a later value needs no migration.
// The DEFAULT is load-bearing: it makes this migration additive and turns every
// existing post public, which is the only safe direction.
visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
```

Then `bun run db:generate` and **read the generated SQL** — it must be one `ALTER TABLE … ADD COLUMN`
with a default, and must not rewrite or drop anything.

- [ ] **Step 4: Widen `PostRow` and `postColumns`**

```ts
// post-repository.port.ts
export interface PostRow {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  authorId: string;
  /** `public` | `members`. Widened here rather than in the DB so a new value needs no migration. */
  visibility: string;
  authorHandle: string;
  authorDisplayName: string;
}
```

```ts
// drizzle-post.repository.ts
const postColumns = {
  id: posts.id,
  body: posts.body,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
  authorId: posts.authorId,
  visibility: posts.visibility,
  authorHandle: appUsers.handle,
  authorDisplayName: appUsers.displayName,
} as const;
```

- [ ] **Step 5: Fix every fake and fixture the compiler now rejects**

`tsc --noEmit` will name them. There are fixtures in `read-posts.test.ts`, `write-post.test.ts`,
`post-views.test.ts` and `bootstrap.test.ts`. Give each `authorId` a **distinct** literal — a fixture
where the author id and the viewer id are the same string will make a later gate test pass for the
wrong reason.

- [ ] **Step 6: Run the api suite, then commit**

Run: `cd apps/api && bun test` (foreground, `timeout: 450000`)

```bash
git add -A && git commit -m "feat(api): posts carry a visibility and their author's id"
```

---

### Task 2: `listActiveOwnersAmong` — one query for a whole page

**Files:**
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`

**Interfaces:**
- Produces: `listActiveOwnersAmong(subscriberId: string, ownerIds: string[], now: Date): Promise<string[]>` — the owner ids from `ownerIds` this subscriber is **currently** a member of.

**Do not edit `is-member-of.ts`.** This method reads the same predicate — `status = 'active' AND
current_period_end > now` — against the same partial unique index, for many owners at once.

- [ ] **Step 1: Write the failing tests**

```ts
test("returns only the owners this subscriber currently pays for", async () => {
  const found = await repo.listActiveOwnersAmong(buyer.id, [rina.id, budi.id, sari.id], NOW);
  expect(found.sort()).toEqual([rina.id, sari.id].sort());
});

test("EXCLUDES an owner whose period has already passed — status alone is not membership", async () => {
  // subscription row: status 'active', current_period_end one minute before NOW
  const found = await repo.listActiveOwnersAmong(buyer.id, [lapsed.id], NOW);
  expect(found).toEqual([]);
});

test("excludes an owner whose period end EQUALS now exactly (strict >, not >=)", async () => {
  const found = await repo.listActiveOwnersAmong(buyer.id, [edge.id], NOW);
  expect(found).toEqual([]);
});

test("returns an empty array for an empty ownerIds list, without querying", async () => {
  expect(await repo.listActiveOwnersAmong(buyer.id, [], NOW)).toEqual([]);
});
```

The **lapsed** test is the one that matters: a status-only filter would return that owner, and a
lapsed member would then see gated images they no longer pay for.

- [ ] **Step 2: Run, watch each fail on its own assertion**

Run: `cd apps/api && bun test drizzle-user-subscription.repository.test.ts`
Expected: FAIL — `repo.listActiveOwnersAmong is not a function`. Add an empty stub returning `[]`,
re-run, and confirm the first three now fail on their **assertions**. A file that fails to load is not
a red phase.

- [ ] **Step 3: Implement**

```ts
async listActiveOwnersAmong(subscriberId: string, ownerIds: string[], now: Date): Promise<string[]> {
  // An empty `in ()` is a SQL error in some drivers and a pointless round trip in all of them.
  if (ownerIds.length === 0) return [];
  const rows = await this.db
    .select({ ownerId: userSubscriptions.ownerId })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.subscriberId, subscriberId),
        inArray(userSubscriptions.ownerId, ownerIds),
        eq(userSubscriptions.status, "active"),
        gt(userSubscriptions.currentPeriodEnd, now)
      )
    );
  return rows.map((row) => row.ownerId);
}
```

- [ ] **Step 4: Run, confirm green, and mutation-test**

Drop `gt(...)` and confirm the lapsed test reddens. Change `gt` to `gte` and confirm the
equals-now test reddens. Restore both.

- [ ] **Step 5: Add it to the in-memory fake, then commit**

Mirror the same predicate in the fake used by the use-case tests — a fake that ignores
`currentPeriodEnd` would make Task 3's lapsed test pass against a broken gate.

```bash
git add -A && git commit -m "feat(api): batched active-membership lookup for a page of authors"
```

---

### Task 3: Barrier one — the projection

**Files:**
- Modify: `apps/api/src/application/use-cases/post-views.ts:16-63`
- Modify: `apps/api/src/application/use-cases/read-posts.ts:28-80`
- Modify: `apps/api/src/application/use-cases/write-post.ts:111,116,162`
- Test: `apps/api/src/application/use-cases/post-views.test.ts`, `read-posts.test.ts`, `apps/api/src/routes/posts.test.ts`

**Interfaces:**
- Consumes: `PostRow.authorId`, `PostRow.visibility` (Task 1); `listActiveOwnersAmong` (Task 2).
- Produces: `toPostView(row: PostRow, media: MediaRow[], locked: boolean): PostView`; `PostView` gains `membersOnly: boolean` and `lockedMediaCount: number`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a locked post carries no media, and says how many are behind the lock", () => {
  const view = toPostView(row({ visibility: "members" }), [mediaA, mediaB, mediaC], true);
  expect(view.media).toEqual([]);
  expect(view.membersOnly).toBe(true);
  expect(view.lockedMediaCount).toBe(3);
});

test("an unlocked members-only post carries its media AND still says it is members-only", () => {
  const view = toPostView(row({ visibility: "members" }), [mediaA], false);
  expect(view.media.map((m) => m.id)).toEqual([mediaA.id]);
  expect(view.membersOnly).toBe(true);
  expect(view.lockedMediaCount).toBe(0);
});

test("the wire projection is CLOSED and identical in both shapes", () => {
  const keys = ["author", "body", "createdAt", "editedAt", "id", "lockedMediaCount", "media", "membersOnly"];
  expect(Object.keys(toPostView(row({ visibility: "members" }), [mediaA], true)).sort()).toEqual(keys);
  expect(Object.keys(toPostView(row({}), [mediaA], false)).sort()).toEqual(keys);
});
```

```ts
// read-posts.test.ts — the gate itself
test("a signed-out reader gets the caption and no media for a members-only post", async () => {
  const page = await listFeed.execute({ tab: "untuk-anda", viewerId: null, limit: 10, before: null });
  expect(page.posts[0]?.body).toBe("Behind the scenes");
  expect(page.posts[0]?.media).toEqual([]);
  expect(page.posts[0]?.lockedMediaCount).toBe(2);
});

test("a paying member gets the media", async () => { /* viewerId = buyer, member of rina */ });

test("a LAPSED member does NOT get the media — their period ended", async () => { /* … */ });

test("the AUTHOR always gets their own media, member or not", async () => { /* viewerId = rina */ });
```

- [ ] **Step 2: Run, watch fail**

Run: `cd apps/api && bun test post-views.test.ts read-posts.test.ts`
Expected: FAIL — `toPostView` takes two arguments; `membersOnly` is undefined.

- [ ] **Step 3: Widen the view**

```ts
export interface PostView {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: { handle: string; displayName: string };
  /** In `position` order. EMPTY when this viewer is locked out — never partial, never a URL. */
  media: MediaView[];
  /** On EVERY post, not only locked ones: the author and paying members need to know it is gated. */
  membersOnly: boolean;
  /** How many images the lock is hiding. `0` whenever `media` is populated. */
  lockedMediaCount: number;
}

/**
 * `locked` is REQUIRED, for the reason `media` already is: a default would let a
 * new call site forget it. Here the forgotten default publishes gated media.
 */
export function toPostView(row: PostRow, media: MediaRow[], locked: boolean): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
    media: locked ? [] : media.map(toMediaView),
    membersOnly: row.visibility === "members",
    lockedMediaCount: locked ? media.length : 0,
  };
}
```

- [ ] **Step 4: Decide `locked` once per page, in `read-posts.ts`**

`toFeedPage` gains a `lockedAuthors: ReadonlySet<string>` and asks it per row. The shared `paginate`
helper builds that set with **one** call:

```ts
// Read the clock ONCE and pass it down — Phase 5b shipped a residual caused by
// a use case reading clock.now() twice around a query.
const now = this.clock.now();
const gated = rows.filter((row) => row.visibility === "members" && row.authorId !== viewerId);
const lockedAuthors = new Set(gated.map((row) => row.authorId));
if (viewerId !== null && lockedAuthors.size > 0) {
  for (const ownerId of await this.subscriptions.listActiveOwnersAmong(
    viewerId, [...lockedAuthors], now
  )) {
    lockedAuthors.delete(ownerId);
  }
}
```

A signed-out viewer skips the query entirely and stays locked out of everything gated.

- [ ] **Step 5: Fix `write-post.ts`'s three call sites**

All three return the post to **its own author**, who is never locked out. Pass `false`, and say so in a
comment — a bare `false` three times invites someone to copy it somewhere it is wrong.

- [ ] **Step 6: Run, confirm green, mutation-test, commit**

Mutate `media: locked ? [] : …` to always populate and confirm the signed-out test reddens. Mutate the
author check (`row.authorId !== viewerId` → `true`) and confirm the author test reddens.

```bash
git add -A && git commit -m "feat(api): the projection never sends a media id to a non-member"
```

---

### Task 4: Barrier two — the media route

**Files:**
- Modify: `apps/api/src/routes/media.ts:125-190`
- Modify: `apps/api/src/bootstrap.ts` (wire the new dependency) and `apps/api/src/bootstrap.test.ts`
- Test: `apps/api/src/routes/media.test.ts`

**`deps.mediaEntitlement` is a new dependency.** Build it as a small use case beside the others, wire
it in `bootstrap.ts`, and extend `bootstrap.test.ts` — that file asserts the container's shape, so it
will fail until you do. It needs the media repository, the post repository, the subscription
repository and the clock.

**Interfaces:**
- Consumes: `listActiveOwnersAmong` (Task 2); `PostRow.visibility`, `PostRow.authorId` (Task 1).

**Read the comment at `media.ts:125` first.** Phase 4 wrote it for this task. **Do not turn either
route into a redirect**, and keep them two separate handlers.

- [ ] **Step 1: Write the failing tests**

```ts
test("a signed-out caller gets 404 for a members-only post's image — not 403, which would confirm it exists", async () => {
  const res = await app.request(`/users/media/${gatedMediaId}`);
  expect(res.status).toBe(404);
});

test("a LAPSED member gets 404", async () => { /* … */ });

test("a paying member gets the bytes", async () => {
  const res = await app.request(`/users/media/${gatedMediaId}`, { headers: memberAuth });
  expect(res.status).toBe(200);
});

test("the author gets their own bytes", async () => { /* … */ });

test("a gated response is never publicly cacheable", async () => {
  const res = await app.request(`/users/media/${gatedMediaId}`, { headers: memberAuth });
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
});

test("a public post's image keeps the immutable cache", async () => {
  const res = await app.request(`/users/media/${publicMediaId}`);
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
});
```

Repeat every one of these against `/users/media/:id/thumb`. Two handlers, gated independently — a test
that only covers `/media/:id` proves nothing about the other.

**And the barrier-independence test, which is the point of this phase:**

```ts
test("BARRIER TWO ALONE: an id obtained legitimately by a member is refused to a non-member", async () => {
  // The projection never sends this id to a non-member — this test hands it over anyway,
  // exactly as a member forwarding a link would.
  const res = await app.request(`/users/media/${gatedMediaId}`, { headers: strangerAuth });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run, watch fail**

Expected: FAIL — status is 200, the bytes came back.

- [ ] **Step 3: Implement, before `mediaStorage.get`**

```ts
const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
const gate = await deps.mediaEntitlement.decide({ mediaId: id, viewerId, now: deps.clock.now() });
// 404 rather than 403: media ids are stripped from the projection, so they are not
// public knowledge, and a 403 would confirm which ids exist. It is also what this
// route already returns for a missing row, so gated and absent look identical.
if (!gate.allowed) throw new NotFoundError(NOT_FOUND_MESSAGE);
```

and the header comes from **the same decision**, never computed separately:

```ts
return c.body(new Uint8Array(object.bytes), 200, {
  "Content-Type": object.contentType,
  // Decided by the same check that decided the bytes. Computed apart, the two can
  // disagree — and a shared cache then holds gated images and serves them to strangers,
  // which no assertion on this route's status code would ever catch.
  "Cache-Control": gate.gated ? "private, no-store" : CACHE_CONTROL,
});
```

Unclaimed media (`post_id is null`) has no post and so no visibility: **allowed, ungated**, exactly as
today. Say that in the decision's docstring.

- [ ] **Step 4: Run, confirm green, mutation-test, commit**

Delete the `if (!gate.allowed)` line and confirm the signed-out 404 test reddens. Force
`gate.gated = false` and confirm the cache-header test reddens.

```bash
git add -A && git commit -m "feat(api): the media route refuses an id it never sent"
```

---

### Task 5: A members-only post needs an image — at the server

**Files:**
- Modify: `apps/api/src/application/use-cases/write-post.ts`
- Modify: `apps/api/src/routes/posts.ts:52-70` (the zod schema) and `:128,150` (the validated reads)
- Test: `apps/api/src/application/use-cases/write-post.test.ts`, `apps/api/src/routes/posts.test.ts`

The route currently validates `{ body, mediaIds? }`. It gains
`visibility: z.enum(["public", "members"]).optional()`. **`.optional()` is load-bearing on PATCH for
the same reason `mediaIds` already documents it there**: an omitted `visibility` on an edit means
"leave it alone", not "make it public" — read that comment at `posts.ts:52` before writing this.

One rule, checked on **create and edit alike**, so the two cannot drift.

- [ ] **Step 1: Write the failing tests**

```ts
// `CreatePost`, `EditPost` and `DeletePost` are three separate classes, each with
// ONE `execute(input)` method. There is no `writePost.create` / `.edit`.
test("refuses to create a members-only post with no image — the lock would protect nothing", async () => {
  await expect(createPost.execute({ authorId: rina.id, body: "halo", mediaIds: [], visibility: "members" }))
    .rejects.toThrow(ValidationError);
});

test("refuses to EDIT away the last image of a members-only post", async () => {
  await expect(editPost.execute({ postId: locked.id, editorId: rina.id, body: "halo", mediaIds: [] }))
    .rejects.toThrow(ValidationError);
});

test("allows removing the last image once the post is public again, in the same edit", async () => {
  const view = await editPost.execute({
    postId: locked.id, editorId: rina.id, body: "halo", mediaIds: [], visibility: "public",
  });
  expect(view.membersOnly).toBe(false);
});
```

The third test is the one that keeps the rule usable: unlocking and clearing images in one edit must
work, or a creator has to make two edits to undo one mistake.

- [ ] **Step 2: Run, watch fail. Step 3: implement the check against the post's RESULTING state**

Check the visibility and media the edit is *producing*, not what the row holds now.

- [ ] **Step 4: Run, confirm green, commit**

```bash
git add -A && git commit -m "feat(api): a members-only post must carry at least one image"
```

---

### Task 6: The composer

**Files:**
- Modify: `apps/web/src/user/PostComposer.tsx`
- Test: `apps/web/src/user/PostComposer.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
test("Khusus anggota is unavailable until an image is attached, and says why", async () => {
  render(<PostComposer {...props} />);
  const box = screen.getByLabelText("Khusus anggota") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(screen.getByTestId("members-only-hint").textContent).toContain("Tambahkan foto dulu");
});

test("attaching an image enables it", async () => { /* … */ });

test("removing the last image un-checks it rather than leaving an unenforceable lock", async () => { /* … */ });
```

Assert on `textContent` strings and `input.disabled` — **never put a DOM node on either side of an
assertion that can fail.**

- [ ] **Step 2: Run, watch fail. Step 3: implement. Step 4: run, confirm green**

Copy, in Bahasa Indonesia: label `Khusus anggota`, hint `Tambahkan foto dulu — teks selalu bisa dibaca
semua orang.`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): compose a members-only post"
```

---

### Task 7: The lock panel

**Files:**
- Modify: `apps/web/src/user/PostCard.tsx`
- Test: `apps/web/src/user/PostCard.test.tsx`

`PostCard` has **no `data-testid` today** — add `data-testid="post-card"` to its root as part of this
task. It exists so assertions can read one `textContent` string instead of putting a DOM node on
either side of a failing assertion.

- [ ] **Step 1: Write the failing tests**

```tsx
test("a locked post shows the caption, the count, and the invitation", () => {
  render(<PostCard post={lockedPost} />);
  const text = screen.getByTestId("post-card").textContent ?? "";
  expect(text).toContain("Behind the scenes");
  expect(text).toContain("3 foto terkunci");
  expect(text).toContain("Jadi anggota untuk melihat");
});

test("the lock links to the author's profile, where the offer lives", () => {
  render(<PostCard post={lockedPost} />);
  expect(screen.getByRole("link", { name: /Jadi anggota untuk melihat/ }).getAttribute("href"))
    .toBe("/rina");
});

test("an unlocked members-only post renders its images, not the lock", () => { /* … */ });

test("no image URL for a locked post reaches the DOM", () => {
  render(<PostCard post={lockedPost} />);
  expect(document.body.innerHTML).not.toContain("/users/media/");
});
```

The last one is cheap and worth having: it fails loudly if a future change starts deriving URLs from
something other than `media`.

- [ ] **Step 2: Run, watch fail. Step 3: implement. Step 4: run, confirm green. Step 5: commit**

```bash
git add -A && git commit -m "feat(web): the lock panel is the conversion surface"
```

---

### Task 8: The gate checklist

**Files:**
- Create: `docs/superpowers/sdd/2026-08-21-exclusive-content/gate-checklist.md`

Written by the controller, run by the owner. It must cover what no suite here can prove:

- [ ] Post a members-only photo; confirm a signed-out browser sees the caption and the lock, and that
      **the network tab shows no request that returns image bytes**.
- [ ] Copy a gated media URL out of a member's session and open it signed-out — it must 404.
- [ ] Buy a membership and confirm the same post unlocks without a reload trick.
- [ ] Let a membership lapse (`current_period_end` in the past) and confirm the images lock again.
- [ ] Confirm a gated response's `Cache-Control` is `private, no-store` in the network tab, and a
      public one's is `public, max-age=31536000, immutable`.
- [ ] Confirm `/dashboard/*` still behaves exactly as before.

---

## Self-Review

**Spec coverage.** §5 model → Task 1. §6.1 projection → Tasks 2, 3. §6.2 media route → Task 4.
§6.3 unclaimed and soft-deleted rows → Task 4 Step 3. §6.4 both barriers → Task 4's independence test
plus Task 3's gate tests. §7 composing/editing → Tasks 5 (server rule + route schema), 6 (composer). §8 the wire → Task 3. §8.1 caching →
Task 4. §9 limitation → nothing to build. §10 testing → distributed. §11 out of scope → respected.

**Type consistency.** `PostRow.authorId`/`visibility` (Task 1) are consumed by Tasks 3 and 4.
`listActiveOwnersAmong(subscriberId, ownerIds, now)` (Task 2) is called in Task 3 Step 4 with that
exact signature. `toPostView(row, media, locked)` (Task 3) matches all four call sites.

**Pre-flight corrections (made before Task 1 was dispatched).** Three names in the first draft did not
match the codebase: `PostRepositoryPort.create` is **positional** (`create(authorId, body)`), not an
object; `write-post.ts` exposes **`CreatePost` / `EditPost` / `DeletePost`, each with one
`execute(input)`** — there is no `writePost.create`; and `PostCard` carries **no `data-testid`**, so
Task 7 adds one. All three are corrected in place above.
`PostView`'s key list in Task 3's closed-projection test matches the interface in the same task.
