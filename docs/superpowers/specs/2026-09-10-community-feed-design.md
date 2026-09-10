# Phase 2 — Community feed

**Date:** 2026-09-10
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 1, `2026-09-09-communities-core-design.md` (merged)
**Branch:** `feat/udara-feed`

## Goal

A member can start a discussion inside a community, everyone can read it, and
members can reply. An owner can additionally post an announcement.

That is the whole phase. No events, no materi, no dokumen, no per-community
checkout — Phases 3 to 5, each for its own reason.

## What the exploration changed

The programme's Phase 2 row reads "5 post types, FeedPostCard,
PostEditorModal, DiscussionDetail + comments, announcements". That line is the
only description of this phase anywhere in the repo, and the reference mockup
it summarises is not in this working tree — it lives at
`github.com/adamfloothink/diudara`. So the five types were never enumerated
here, and three of them turn out to belong to later phases.

**This phase builds two types: `diskusi` and `pengumuman`.** `kegiatan` needs
`community_event` and RSVP, which is Phase 3. `materi` and `dokumen` need the
course/lesson and document tables, which is Phase 4. Rendering all five now
would put an event card with no date on screen, and a dokumen card that opens
nothing — the same "a control is never rendered for an action that would fail"
rule that made Phase 1 cut the tab bar. `type` is `varchar(16)`, so Phases 3
and 4 add their values without a migration; the reasoning is the one
`subscription.status` already records.

**Community posts reuse the `post` table.** The alternative — a
`community_post` table — was considered and rejected: it duplicates the
composer, `post_media`'s claim-on-create upload and its orphan sweep, the soft
delete, the `editedAt` marker and the keyset cursor, which is substantially the
whole of the 2026-08-18 posts phase rebuilt beside itself, plus a second
PostCard to keep in visual sync. Programme decision 4 — nothing shipped gets
deleted — points the same way.

The cost of that reuse is that one table now feeds three surfaces. **Feed
reach** states the rule and **Testing** states how it is held.

## The schema

### `post` gains two columns

```
community_id  uuid NULL REFERENCES community(id)
type          varchar(16) NOT NULL DEFAULT 'diskusi'
```

Both additive with a default. Every existing row becomes a personal `diskusi`
post; no backfill, and the migration is reversible in the sense that matters —
dropping the columns restores the previous behaviour exactly.

`community_id IS NULL` means a personal post: Beranda and profiles.
`community_id IS NOT NULL` means a community post. There is no third state and
nothing infers one from the other.

### Two CHECK constraints

Constraints rather than use-case guards, so they hold however the row arrives —
a later bulk import, a manual fix, a second call site. This is the reasoning
`follow_no_self` already carries.

```sql
CHECK (community_id IS NOT NULL OR type = 'diskusi')
CHECK (community_id IS NULL OR visibility = 'public')
```

The first says a personal post has no type. Types are a community concept, and
a personal post carrying `type = 'pengumuman'` would be a row no surface knows
how to render.

**The second is load-bearing and the reason it exists must not be lost.**
`visibility = 'members'` is the *personal* paywall: `paginate()` in
`read-posts.ts` resolves it against `user_tier` subscriptions through
`listActiveOwnersAmong`, locking a post unless the viewer is the author or a
current member of that author's own tier. A community post carrying `members`
would therefore be gated against the author's personal tier, which has no
relationship to the community the post is in — a member of the community would
be locked out of it, and a subscriber to the author who has never joined the
community would be let in. A community post's audience is the community. The
column must not be made to mean anything else here.

With that constraint in place, every community row is `public`, the paywall
gate resolves to "nothing locked" with no special case, and `post_media` works
on community posts exactly as it does on personal ones.

### Indexes

Both existing indexes now want the same additional filter, because Beranda and
profiles are `community_id IS NULL` (see **Feed reach**):

- `post_live_created_idx` — predicate becomes
  `deleted_at IS NULL AND community_id IS NULL`. Community rows leave the Untuk
  Anda index entirely rather than being filtered out of every scan, which is
  the reasoning that index's own comment already gives for excluding deleted
  rows.
- `post_author_created_idx` — same filter added. Both its consumers, a
  profile's posts and the post side of the Mengikuti join, exclude community
  posts.
- `post_community_created_idx` on `(community_id, created_at DESC)` where
  `deleted_at IS NULL` — new; the community feed's keyset page.

### `post_comment`

```
id          uuid PK
post_id     uuid NOT NULL REFERENCES post(id)
author_id   uuid NOT NULL REFERENCES app_user(id)
body        text NOT NULL
created_at  timestamptz NOT NULL DEFAULT now()
edited_at   timestamptz NULL
deleted_at  timestamptz NULL
index (post_id, created_at) WHERE deleted_at IS NULL
```

Flat, oldest-first. No `parent_id`.

The programme's feature list does say "threaded comments", so this is a
deliberate deviation and is recorded as one. Threading costs a recursive read,
a depth cap, a collapse control and a rule for replying under a deleted parent;
a community discussion with a handful of replies reads fine flat. `parent_id`
can be added later as a nullable column without moving a row.

`edited_at` and `deleted_at` are present from the start, matching `post`, so a
comment's lifecycle needs no second migration.

**Only community posts take comments this phase.** `post_id` references `post`
rather than a community-only table, so the schema does not forbid a comment on
a personal post — but no endpoint creates one: `POST /users/posts/:id/comments`
requires membership of the post's community, and a personal post has none, so
the request is rejected. Opening comments on personal posts is a product
decision for a later phase, not a migration.

**No stored comment count.** The count is of live comments — `deleted_at IS
NULL` — and is taken per feed page in one batched query, the way Phase 1
refused a stored `member_count` on `community`.

## The API

Reads are open, writes are member-gated.

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/posts?before=` | none |
| `POST` | `/communities/:slug/posts` | member; `pengumuman` owner-only |
| `GET` | `/users/posts/:id` | none — **new** |
| `GET` | `/users/posts/:id/comments` | none |
| `POST` | `/users/posts/:id/comments` | member of the post's community |
| `DELETE` | `/users/comments/:id` | own comment, or the community's owner |

**The `/users` prefix is not a typo.** `app.ts` mounts `postRoutes` with
`app.route("/users", postRoutes(deps))`, so today's post surface is already
`/users/posts`, `/users/feed` and `/users/:handle/posts`. Comment endpoints
join `postRoutes` and inherit that prefix. The community feed's two endpoints
sit in `communityRoutes`, mounted at `/communities`, and keep that prefix.

**`comments` must be added to `RESERVED_HANDLES`** in `domain/handle.ts`.
`DELETE /users/comments/:id` introduces a new literal segment directly under
`/users/`, and a guard test derives the reserved list from the route table
precisely so that a literal nobody reserved is caught there rather than by a
user who registers the handle and shadows the route. `posts` and `media` are
already in that list for the same reason.

`GET /users/posts/:id` does not exist today — the post endpoints are create, edit,
delete, feed and a user's posts. DiscussionDetail needs a single-post read and
this is it. It answers for personal posts too, honouring the existing paywall
gate, since one endpoint that applies the gate correctly is safer than a
community-only endpoint that never learns about it.

`PATCH /users/posts/:id` and `DELETE /users/posts/:id` are reused for edit and delete with
one change: `DeletePost` currently permits the author alone, and gains the
community-owner rule — an owner may delete any post in their community.
**`EditPost` does not gain it.** An owner moderating removes a post; they never
rewrite another member's words under that member's name.

The feed read reuses `paginate()` unchanged, including its two batched queries
for media and the membership gate.

### Announcements are not pinned

They render as a distinct card in the ordinary chronological feed.

Pinning would need either `ORDER BY (type = 'pengumuman') DESC, created_at
DESC`, which breaks the keyset cursor `PostFeed` paginates on, or a second
query whose results then appear twice on the page. The reference shows
announcements as a banner, so this is a real difference from it, taken
knowingly and cheaply reversible if the product wants the banner later.

## Feed reach: community posts stay in their community

Beranda — both Untuk Anda and Mengikuti — and profile post tabs filter
`community_id IS NULL`. A community post appears on its community page and
nowhere else.

The alternative, mixing joined communities into Untuk Anda, puts a join against
`community_member` on the busiest query in the product and abandons the
partial index that serves it. Showing them on profiles risks the leak this
phase most needs to avoid. Neither is worth it while a community's own page is
the only place a reader is looking for its discussions.

## Permissions

| Action | Who |
|---|---|
| Read the feed, a discussion, its comments | anyone, signed out included |
| Start a `diskusi` | members |
| Comment | members |
| Post a `pengumuman` | the owner |
| Edit a post | its author |
| Delete a post or comment | its author, or the community's owner |

Open reading follows from Phase 1's model: every community is open-join with
one unconditional click, so a wall in front of the feed stops nobody who wants
past it while making a community impossible to evaluate before joining — which
would leave the browse tab a list of names.

## The web app

**CommunityPage gets the tab bar Phase 1 cut.** Two tabs make it honestly a
bar: **Diskusi** (default) and **Anggota** (Phase 1's roster, moved under the
tab unchanged). The pattern is Jelajah's, which is the precedent already in
this repo — `.feed-tabs` markup, `aria-current`, the tab in the URL as `?tab=`
rather than component state so a link to either half works, and only the active
half mounted so opening the roster does not fetch a feed nobody asked for.

**The feed reuses `PostFeed` with no changes to it.** It already takes
`load(before)`, owns its list, and exposes `prepend`/`replace`/`remove` — which
is exactly what a composer above it needs. The community feed is a third caller
beside Beranda and profiles.

**One card, not two.** `PostCard` gains three optional props: a `pengumuman`
badge driven by `post.type`, a comment count, and a link to the discussion. The
reference calls this component `FeedPostCard`; introducing a second component
is how the two feeds start drifting visually one phase later, and PostCard's
props are already optional-by-default.

**The composer is inline, not a modal.** `PostComposer` already carries body,
media, `submitLabel`, `onSubmit`, `onCancel` and a variant selector. For a
community post its visibility selector is replaced by a type selector shown
**only to the owner** — a member sees no selector, because `pengumuman` would
fail for them. The reference's `PostEditorModal` would need a focus trap,
escape handling, scroll lock and a return-focus rule, all new, wrapping a form
that already exists. Deviation recorded.

A non-member, or a signed-out visitor, sees the composer's place taken by the
same `Gabung` / `Masuk untuk gabung` control the banner carries.

**`DiscussionDetail` is a new route:** `/komunitas/:slug/diskusi/:postId`,
declared before `/:handleParam` for the reason `/komunitas/baru` precedes
`/komunitas/:slug`. The post, a flat comment list, and a comment form for
members. An unknown id renders `NotFoundPage`, matching an unknown slug.

**Vite proxy: nothing to add.** Every endpoint this phase introduces sits under
`/users` or `/communities`, both already in the proxy table, so
`src/test/vite-proxy-coverage.test.ts` is satisfied without a change. This is
stated rather than left silent because the same test caught three separate
instances of a missing entry answering `200 text/html` from the SPA fallback,
and "no change needed" is a conclusion worth recording once.

## Not in this phase

- **The sidebar's collapsible joined-communities group.** Phase 1 deferred it
  here on the grounds that Phase 2 would finally give it a list worth
  collapsing. It would, but it is submenu machinery the programme's Phase 2 row
  does not ask for, on top of a feed, two post types, comments, a tab bar and a
  detail page. Phase 3 takes it.
- **`kegiatan`, `materi`, `dokumen`** — Phases 3 and 4, with their tables.
- **Threading** — flat comments, `parent_id` addable later.
- **Pinned announcements** — see above.
- **Editing a comment.** `edited_at` exists on the table so the capability
  needs no migration, but no endpoint or UI writes it this phase. A comment is
  posted or deleted.
- **Moderation beyond delete** — no mute, no ban, no report. Removing a member
  was already out of Phase 1 and stays out.
- **Notifications** of any kind. Phase 8.

## Testing

**The leak filter is this phase's one real risk, and it gets a test that cannot
pass by omission.**

`post.deletedAt`'s own comment records what happened last time this shape
appeared: "a filter present on three paths and missing on the fourth… each
path's own tests only ever create live posts, so nothing goes red."
`community_id IS NULL` is that shape again, on the same paths, one phase later.

So: one table-driven test over the three read paths — `listGlobal`,
`listFollowing`, `listUserPosts` — sharing a single fixture that inserts one
community post and asserting it absent from each. Not three tests that each
happen to remember. A fourth path added later joins the table.

Beyond that:

- **Every existing Beranda and profile test keeps its current expectations and
  stays green untouched.** That is the proof the migration is additive. Any
  such test needing a change is a signal to stop and re-read this spec, not to
  update the test.
- **Both CHECK constraints get a test each** that attempts the forbidden insert
  directly against the database and expects rejection — a use-case test would
  only prove the use-case guards it.
- **Permissions are tested at the use-case**, one case per row of the
  permissions table above, including the negative for each: a non-member
  starting a discussion, a member posting an announcement, a stranger deleting
  a comment.
- **Web component tests** by role, label and text, never by class name — the
  rule Phase 1 set.

## Risks

**One table, three surfaces.** Covered by the table-driven test above; named
here because it is the thing most likely to go wrong quietly.

**The `visibility` CHECK is easy to mistake for redundancy.** A future reader
sees `visibility` defaulting to `public` and a constraint forcing community
posts to `public`, and deletes the constraint as belt-and-braces. It is not:
without it a community post can be given a personal paywall that gates it
against the wrong audience in both directions. The constraint carries a comment
saying so.

**`PostCard` and `PostComposer` now serve two shapes.** Both grow optional
props rather than a `variant` flag. If either file starts branching on "am I in
a community" in more than the two or three places this spec names, that is the
signal the single-component decision needs revisiting — report it rather than
letting the branches accumulate.

**No migration is run by this branch.** As in Phase 1, the generated migration
is committed and the repo owner runs it. Unlike Phase 1, it is additive and
destroys nothing.
