# Posts and a Feed — Design Spec

Date: 2026-08-18
Status: Approved for planning
Parent: `docs/superpowers/specs/2026-08-17-member-ui-design.md` (the shape) and
`docs/superpowers/specs/2026-08-18-profiles-and-following-design.md` (Phase 2)

## 1. Purpose

Phase 2 made the app navigable and social: you can sign up, move between four destinations, find
people and follow them. There is nothing to read. `Beranda` is an honest placeholder that says so.

This phase gives the app **content**. After it: you can write a post, read everyone's posts, read
only the people you follow, see someone's posts on their profile, and edit or delete your own.

There are still no images — that is Phase 4 — and no members-only content, which is Phase 6. Every
post in this phase is public text.

## 2. What the parent specs already settle

Read `2026-08-17-member-ui-design.md` §2 and §8 first. They fix, and this phase must not re-decide:

- **Beranda has two tabs: `Untuk Anda` (everyone's newest, the default) and `Mengikuti`.**
  Discovery-first, because a following-only feed shows nothing to almost everyone at this size.
- **Chronological, not ranked.** Ranking buys nothing until volume makes ordering matter.
- Phase 3 owns `PostCard`, both tabs, and composing a post.
- The creator dashboard is **not restyled**; it runs untouched until Phase 8.
- Likes, replies, reposts, DMs, bookmarks, hashtags and notifications are each out of scope for the
  whole pivot's early phases. Twitter's *shape* is being borrowed, not its feature list.

Phase 2 additionally establishes, and this phase inherits:

- **A public endpoint is not an anonymous one.** Any route that resolves a viewer needs the viewer's
  `Authorization` header sent from the client. `publicGet` does this; a bare `fetch()` does not, and
  forgetting it made the follow button unreachable for every signed-in user.
- **Every new endpoint lives under the `/users/` prefix**, which nginx and the Vite dev proxy
  already cover.
- User-visible failure copy comes from `errorCopy.describeRequestFailure`, never from the server's
  message. A source scan enforces this for every screen under `src/user`.

## 3. Scope

**In scope:**
- The `post` table, with soft delete and an edit marker
- `POST`, `PATCH`, `DELETE` for your own posts
- The two-tab feed, cursor-paginated with a `Muat lebih banyak` button
- That person's posts on `/@handle`
- `PostCard` and an inline composer at the top of Beranda
- Repairing the split-session state Phase 2 carried forward (§9)

**Out of scope, with why:**
- **Images and video.** Phase 4. `PostCard` gains a media slot then rather than being rewritten.
- **Members-only posts.** Phase 6 owns gating, so there is **no visibility column yet.** Adding an
  unused one now is the mistake caught in the free-communities phase, where an env flag was designed
  for a capability the owner already chose per community.
- **Likes, replies, reposts, bookmarks, hashtags, mentions.** Each is its own project.
- **Ranking, infinite scroll, notifications, blocking.** Unchanged from Phase 2.
- **A rate limit on posting.** See §10 — named as a known exposure with a revisit trigger, not
  built.

## 4. The post model

| column | notes |
|---|---|
| `id` | uuid pk |
| `author_id` | uuid not null → `app_user` |
| `body` | text not null |
| `created_at` | timestamptz not null default now |
| `edited_at` | timestamptz null — set on edit, drives the `diedit` marker |
| `deleted_at` | timestamptz null — soft delete |

**Two new indexes:**

- `(created_at desc, id desc) where deleted_at is null` — Untuk Anda, and partial so deleted rows
  leave the hot index entirely.
- `(author_id, created_at desc)` — a profile's posts, and the post side of the Mengikuti join.

Phase 2's `follow_follower_created_idx` serves the follow side of that join, so this phase adds no
index to `follow`.

### 4.1 Ordering is always two columns

`order by created_at desc, id desc`, and the cursor carries **both**. A cursor on a timestamp alone
silently drops or duplicates rows when two posts share a millisecond. This is not hypothetical here:
this project has a family of a dozen flakes that exist precisely because timestamps were assumed
distinct enough, and Phase 2 had a parked finding about a missing `ORDER BY` tiebreaker.

### 4.2 Soft delete is this phase's real risk

`deleted_at` must be filtered on **every** read path: both feed tabs, the profile list, and the
single-post read behind edit. The failure mode is a filter on three paths and not the fourth, which
no test notices because each path's own tests only ever create live posts. This is the dominant
defect shape on this project — each layer correct alone, wrong in combination, invisible to a green
suite. §8 says how it gets pinned.

## 5. The endpoints

All under `/users/`, so **no nginx change and no new Vite proxy entry** — the bug this repo has
shipped three times.

| Route | Auth | Notes |
|---|---|---|
| `POST /users/posts` | required | 201 with the created post |
| `GET /users/feed?tab=untuk-anda\|mengikuti&before=` | see below | `{ posts, nextCursor }` |
| `GET /users/:handle/posts?before=` | public | `{ posts, nextCursor }` |
| `PATCH /users/posts/:id` | required, author only | 200 with the updated post |
| `DELETE /users/posts/:id` | required, author only | 200, **idempotent** |

`limit` defaults to 20 and is clamped at 50, from the same shared constant the client uses.
`nextCursor` is `null` when the page is the last one.

**Pagination reuses `apps/api/src/domain/keyset-cursor.ts`** rather than inventing a cursor. That
module already exists, is already shared by the activity feed and the member roster, and already
encodes `(timestamp, id)` for exactly the reason §4.1 gives. Hence the parameter is **`?before=`**,
matching what it and `routes/analytics.ts` already use. A malformed value is a 400, never a silent
restart at page 1 — a "load more" button given a corrupt cursor would otherwise loop for ever
showing the same rows.

### 5.1 Untuk Anda is public; Mengikuti requires a session

`/beranda` is a publicly reachable route — Phase 2 ruled that deliberately. An auth-only feed
endpoint would therefore break a page a signed-out visitor can open, which is the cross-layer defect
shape this project keeps finding. So `tab=untuk-anda` works with no session, and `tab=mengikuti`
returns 401.

Signed out, the Mengikuti tab renders **`Masuk untuk melihat`** with a link, mirroring how the
profile's follow button already behaves. It does not fetch and fail.

### 5.2 The post projection

`id`, `body`, `createdAt`, `editedAt`, and an author of `handle` and `displayName`.

**No `author_id`, no `deleted_at`, no email, no WhatsApp number.** Asserted on response **keys** —
`expect(Object.keys(post).sort()).toEqual([...])` — not on types. A bare `select()` returns every
column whatever TypeScript claims, and Phase 1 found this invariant defended on only two of five
repository paths.

`editedAt` is `null` on an unedited post rather than absent, so the key set is stable.

## 6. The composer

An inline box at the top of Beranda. Placeholder `Apa yang terjadi?`, a visible counter, and `Kirim`
disabled while the body is empty, whitespace-only, or over the limit.

**1000 characters, from one shared constant** used by both the client bound and the server
validator. Phase 2 established this pattern after a bug where the tested copy of a constant was the
unused one: a single edit to the constant must redden tests in both workspaces.

A successful post prepends to the visible feed without a full refetch, and clears the box. A failed
post keeps the text — losing what someone typed is the worst available outcome — and shows Bahasa
copy from `describeRequestFailure`.

## 7. PostCard

Display name, `@handle`, relative time, body, and `· diedit` when `editedAt` is set. On your own
posts, a menu with `Edit` and `Hapus`; on anyone else's, no menu.

**No follow button inside the card.** Phase 2's carry-forward names this as exactly where
`viewerFollows` gets guessed again as `signedIn ? false : null`, so the card does not take the prop
at all.

Relative time reads `baru saja`, then minutes (`5m`), hours (`2j`), days (`3h`), then an absolute
date. **Formatted against an injected clock**, never `Date.now()` in a test — the dozen known flakes
on this project are all clock comparisons.

`Hapus` asks for confirmation, in Bahasa Indonesia. `Edit` reuses the composer's constraints,
including the same shared limit.

## 8. Errors

| Condition | Behaviour |
|---|---|
| Post with an empty or whitespace-only body | 400, Bahasa Indonesia |
| Post over the limit | 400 — and the client should have prevented it; both halves exist |
| Post without a session | 401 |
| Edit or delete someone else's post | 403 |
| Edit or delete an id that never existed | 404 |
| Delete an already-deleted post | **200, idempotent** — the row exists and is already in the asked-for state, same reasoning as follow/unfollow |
| Edit a deleted post | 404 |
| Malformed cursor | 400, Bahasa Indonesia |
| `tab=mengikuti` signed out | 401, and the UI never sends it |
| Any feed request fails | Bahasa copy, and **content already on screen stays** |
| A profile with no posts | An honest empty line, not a spinner |
| Feed empty on Mengikuti | Points at Jelajah, the way the placeholder does today |

## 9. Repairing the split session

Phase 2 shipped a known residual: the token key and the account key can disagree, and in that state
a live `Ikuti` appears on your own profile and on your own Jelajah row. Only external corruption
reaches it — the quota path is closed — but it was recorded as this phase's job.

**Fix it at the cause:** when a token is present and the account is not, re-fetch `/users/me` and
re-run `setUserSession`. Not by patching the three screens that render wrongly, which is the
instance rather than the class — a distinction that already cost this project a round when two fixes
each closed their own call site and a guard test then found four more offenders.

**This requires dropping `id` from `SessionUser`.** `GET /users/me` has never returned the user's id,
so the account blob cannot be rebuilt from it while `id` is required. The field is **read nowhere** —
every consumer uses `handle` or `displayName` — so it goes, rather than widening an endpoint to
supply something nothing needs. Existing stored blobs still parse, since an extra key is ignored.

If the re-fetch itself fails with a 401 the token is genuinely dead, and the existing
`apiRequest` behaviour applies: clear it and let the person sign in again.

## 10. Testing

- **A deleted post is asserted absent on every read path** — both tabs, the profile list, and the
  read behind edit — and each filter is proven by removing it and watching a test go red.
- **Cursor stability**: paginate, insert a post between pages, and confirm no row is skipped or
  repeated. Also two posts sharing a `created_at`, which is what the `id` tiebreaker is for.
- **The shared length constant**: one edit to it reddens tests in both `apps/api` and `apps/web`.
- **The post projection's keys are asserted**, and contain no `author_id` and no `deleted_at`.
- **`tab=untuk-anda` succeeds with no `Authorization` header**, and `tab=mengikuti` returns 401 —
  both pinned, because §5.1 is the whole reason the split exists.
- **The viewer's token is sent** on every client call to a route that resolves a viewer.
- Relative time is tested at each boundary against a fixed clock.
- A failed feed request leaves already-loaded posts on screen.
- No `expect(<DOM element>).toBeNull()` — it hangs `bun test`; there is a source-scan guard.
- The root gates are `bun run test` and `bun run typecheck`, never bare `bun test`.

## 11. Honest limitations

**A text-only feed is not yet useful to a real creator.** You can post, read and follow, and none of
it shows a photo. Phase 4 is where this starts being worth someone's time; this phase is the frame
that holds it.

**Nobody is told you posted.** No notifications, so a follower learns about a post only by opening
the app. Acceptable while the only users are the people building it.

**Untuk Anda is a global public feed with no moderation, no blocking, no rate limit, and no way to
delete someone else's post.** Anyone who signs up can fill the default tab for everyone. This is
tolerable only because nobody is using the site. **The revisit trigger is the first signup by
somebody you do not personally know.**

**Edit has no history.** A reader sees that a post changed, never what it said before. That is a
deliberate simplification and it means edit can be used to rewrite a post someone already replied
to — harmless while there are no replies, and worth revisiting when Phase 4 or later adds them.

**Two account systems still coexist.** Unchanged since Phase 1; retires in Phase 8.
