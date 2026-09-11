# Phase 3 — Events and the calendar

**Date:** 2026-09-11
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 2, `2026-09-10-community-feed-design.md` (merged)
**Branch:** `feat/udara-events`

## Goal

A community owner can schedule an event. It appears in the community's feed as
an event card, on a month calendar under a new **Kegiatan** tab, and on a
detail page where members can discuss it.

That is the whole phase. No RSVP, no live-room link, no materi, no dokumen —
each for its own reason, recorded below.

## What reading the reference changed

The programme's Phase 3 row reads "Kegiatan tab, month grid, agenda,
EventDetail" with "new `community_event` + RSVP". The reference mockup was not
in the working tree when that row was written; it is now read directly from
`github.com/adamfloothink/diudara`, and two things in it do not match the row.

**There is no RSVP in the reference.** `EventDetail.tsx` is a gradient date
banner, a description card, and a live-room link — no attend button, no
attendee count, no roster. `mock.ts`'s `calendarSchedule` entries carry
`date`, `month`, `day`, `title`, `type`, `time`, `description`, `hasLiveRoom`
and nothing else. The programme table is the only place RSVP is promised, and
nothing else in the programme depends on it.

So **this phase ships no RSVP.** Building it would mean inventing a UI the
reference does not have, for a capability no other phase consumes, on top of a
calendar, an agenda, a feed card, a composer type and a detail page. Adding it
later is one additive table (`event_rsvp`) and one endpoint; no decision in
this phase forecloses it. This is the same deviation-with-reason Phase 2
recorded for flat comments and the inline composer.

**The reference's calendar mixes three types, and two of them are not ours
yet.** `calendarSchedule` carries `live`, `event` and `materi` rows in one
grid with a three-dot legend. `materi` is Phase 4 and `live` depends on Phase
7's unmade SFU-versus-broadcast decision. This phase renders events only. The
legend is therefore not built — a legend with one entry explains nothing —
but the grid's day cell takes a list, so a later phase adds a second source
without restructuring it.

**Events reuse the `post` table**, exactly as Phase 2's discussions and
announcements do, for the reasons Phase 2 records: a `community_event` that
owned its own body would duplicate the composer, `post_media`'s
claim-on-create upload and its orphan sweep, the soft delete, the `editedAt`
marker, the keyset cursor and PostCard itself. Phase 2 already left
`kegiatan` reserved in `post.type` for this.

## The schema

### `community_event`

```
post_id      uuid PRIMARY KEY REFERENCES post(id)
community_id uuid NOT NULL REFERENCES community(id)
title        varchar(160) NOT NULL
starts_at    timestamptz  NOT NULL
ends_at      timestamptz  NULL
location     varchar(200) NULL
```

**`post_id` is the primary key, not a separate `id`.** The relationship is 1:1
and the post is the identity: the detail page's URL, the comment thread, the
soft delete and the owner's moderation all key off the post. A second id would
be a second name for the same thing, and the first bug it produces is a URL
built from the wrong one.

**No `created_at`, no `deleted_at`, no `edited_at`.** The post carries all
three. A soft-deleted event is a soft-deleted post: every read path in this
phase joins `post` and filters `post.deleted_at IS NULL`, so the event row
needs no lifecycle of its own and cannot develop one that disagrees.

**`community_id` duplicates `post.community_id`, deliberately.** The calendar's
only query is "this community's events between two instants", and without this
column it is a join from `post` filtered on `community_id` — which means
walking the community's entire post history to find the twenty rows that are
events. With it, the query is one index range scan. Both rows are written in
the same transaction (see **Writing an event**), so they cannot drift, and
nothing reads this column to decide which community a post belongs to; it
exists to be ranged over.

**`title` is separate from the post's `body`.** The reference's event card, its
calendar chip and its detail banner all show a title, and its feed card shows
the title and the description as different elements. A `diskusi` has no title
and the existing `PostCard` renders none; giving `post` a nullable `title`
column that only one type ever uses puts the nullable field on the hot table
instead of the cold one.

### The CHECK

```
check community_event_ends_after_starts:
  ends_at IS NULL OR ends_at > starts_at
```

A CHECK and not only a use-case guard, for the reason `follow_no_self` already
records: it holds however the row arrives — a future import, a manual fix, a
second call site.

An event with `ends_at` equal to `starts_at` is rejected rather than stored: a
zero-length event is a data-entry slip, and the composer's own time fields make
it easy to produce.

### The index

```
index community_event_community_starts_idx on (community_id, starts_at)
```

The calendar's month range, and the agenda's ordering, in one. No partial
`WHERE` clause: there is no soft-delete column here to exclude, and the
`post.deleted_at` filter lands on the joined side.

### `post` is not touched

`type` is already `varchar(16)` with the widening Phase 2 documented, so
`kegiatan` needs no migration. `post_personal_has_no_type` already forbids a
personal post from carrying it. `post_community_created_idx` already serves
the feed, events included.

There is no CHECK tying `post.type = 'kegiatan'` to the existence of a
`community_event` row, in either direction — Postgres cannot express a
cross-table constraint without a trigger, and a trigger to enforce an
invariant that one transaction in one use case already maintains is machinery
guarding against a caller that does not exist. **Testing** states how the
invariant is held instead.

## Writing an event

`CreatePost` already runs inside `PostWriteUnitOfWorkPort` — the transaction
that claims media atomically with the post insert. The `community_event`
insert joins that same transaction. A failed event insert therefore rolls the
post back, and there is no window in which a `kegiatan` post exists without
its event row.

`CreateCommunityPost` gains `kegiatan` in the branch `pengumuman` already
takes:

```
if (type === 'pengumuman' || type === 'kegiatan') → owner only
else                                              → member
```

One more value in an existing condition, not a new rule. The reference agrees:
`PostEditorModal`'s `availableTypes` is `["diskusi", "konten", "event",
"pengumuman"]` for an admin and `["diskusi"]` for everyone else.

## The contract

`packages/shared/src/post.schema.ts`:

- `COMMUNITY_POST_TYPES` becomes `["diskusi", "pengumuman", "kegiatan"]`.
- `createCommunityPostSchema` gains an optional `event` object:

```
event?: {
  title:     string  // trimmed, 1..160
  startsAt:  string  // ISO-8601
  endsAt?:   string  // ISO-8601, must be after startsAt
  location?: string  // trimmed, 1..200
}
```

- A `superRefine` makes it **required when `type === 'kegiatan'` and rejected
  otherwise.** Both halves matter. Without the first, an event with no date
  reaches the calendar and has no cell to sit in — the exact failure Phase 2
  cited when it refused to render `kegiatan` early. Without the second, a
  `diskusi` carrying event fields writes a `community_event` row the feed
  card will then render on a discussion.

`packages/shared/src/post.schema.test.ts` currently asserts that `kegiatan` is
**rejected**. Phase 3 flips that assertion and leaves a comment recording that
Phase 3 is what made the value valid — the programme's working agreement on
breaking an existing test invariant deliberately rather than quietly.

`endsAt > startsAt` is validated in Zod as well as in the CHECK. The CHECK is
the guarantee; the Zod rule is what turns a violation into a Bahasa field
error instead of a 500 from a constraint the client cannot read.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/events?month=YYYY-MM` | none — **new** |
| `POST` | `/communities/:slug/posts` | member; `pengumuman` **and `kegiatan`** owner-only |
| `GET` | `/users/posts/:id` | none — unchanged, now carries `event` |
| `GET` | `/communities/:slug/posts` | none — unchanged, now carries `event` |

The events endpoint answers:

```
{ events: [ { postId, title, startsAt, endsAt, location,
              author: { handle, displayName } }, ... ] }
```

Ascending by `startsAt` — the order the agenda renders in, so the client sorts
nothing. `postId` and not `id`, because that is what it is and because the
detail link is built from it. No `body`: the calendar shows a title and a time,
and the description belongs to the page you reach by clicking. A wrapper object
rather than a bare array, matching every other list response in this API.

**It is unpaginated, and that is a decision.** It
returns one month of one community's events. The keyset cursor every other
feed carries exists because a feed is unbounded; a month is not. A community
running an event every weekday produces 23 rows. If that assumption ever
breaks the endpoint grows a cursor, and the calendar grid — which must hold
the whole month to render at all — is the surface that would have to change,
not just the query.

**`month` is a WIB month.** `?month=2026-09` is the range
`[2026-08-31T17:00:00Z, 2026-09-30T17:00:00Z)`, because Asia/Jakarta is UTC+7
year-round and September in Jakarta begins seven hours before September in
UTC. Reading it as a UTC month would file every event scheduled before 07:00
WIB on the 1st into the previous month's grid — visible only to a user who
scheduled an early-morning event, which is precisely the kind of bug that
ships. An absent or malformed `month` is the current WIB month, resolved from
`ClockPort` and not from `new Date()` in the route, for the reason
`clock.port.ts` already documents.

**No new literal under `/users/`, so `RESERVED_HANDLES` is untouched.** The
new endpoint's literal segment is `events`, and it sits after `:slug` under
`/communities`, where it cannot shadow a handle. `/communities` is already in
the Vite proxy table, so `vite-proxy-coverage.test.ts` is satisfied without a
change — stated rather than left silent, because Phase 2 recorded that the
same test has caught three missing entries.

**No edit and no separate delete.** `DELETE /users/posts/:id` already removes
an event: it soft-deletes the post, and every event read path filters on the
post. `PATCH /users/posts/:id` edits the body and leaves the event row alone —
rescheduling is not in this phase. That is a real limitation and it is listed
under **Not in this phase**, not hidden here.

### `PostView` gains `event`

```
event: {
  title:     string
  startsAt:  string       // ISO-8601
  endsAt:    string | null
  location:  string | null
} | null
```

Present on **every** post, `null` on all but a `kegiatan` — the stable key set
`membersOnly`, `type` and `lockedMediaCount` already keep, for the reason
`post-views.ts` records: a conditional key leaves the client unable to tell
"absent" from "absent because I was not told".

`endsAt` and `location` are explicitly `null` rather than omitted, inside the
object, for the same reason one level down.

### The event rides on `PostRow`, not on a second query

`listByCommunity` and `getById` gain a `LEFT JOIN community_event ON
community_event.post_id = post.id`, and `PostRow` gains `event: EventRow |
null`.

The alternative considered was a batched `events.findForPosts(ids)` threaded
through `paginate` the way `comments.countForPosts` already is. It was
rejected: the comment count is an aggregate over a table with many rows per
post and genuinely needs its own grouped query, while this is a primary-key
join returning at most one row per post — a second round trip to fetch what
the first query could have carried.

The join costs the three personal read paths nothing and needs no special
case in them: they already filter `community_id IS NULL`, and a personal post
can never have a `community_event` row, so `event` is `null` there by
construction rather than by a projection remembering to set it.

`create()` returns the event on the `PostRow` it produces, so the composer's
optimistic prepend renders a complete card without a refetch.

## Permissions

| Action | Who |
|---|---|
| Read the calendar, an event, its comments | anyone, signed out included |
| Create an event | the community's owner |
| Comment on an event | members |
| Delete an event | its author (the owner), or the community's owner |

Open reading follows Phase 1's model unchanged: every community is open-join
with one unconditional click, so a wall in front of the calendar stops nobody
while making a community impossible to evaluate before joining.

## The web app

**`CommunityPage` gains a third tab: Kegiatan**, at `?tab=kegiatan`, beside
Diskusi and Anggota. Jelajah's pattern, which `CommunityPage` already follows —
`.feed-tabs` markup, `aria-current`, the tab in the URL rather than component
state, and only the active tab mounted so opening the calendar does not fetch
a feed nobody asked for.

**`KegiatanTab` is one fetch rendered twice.** `GET .../events?month=` returns
the month; the grid above and the agenda list below read the same array. Two
fetches for one month's data would be two chances to disagree on screen.

The grid is a seven-column CSS grid, Monday-first, built the way the reference
builds it: pad to the first weekday, fill the days, pad to a multiple of
seven. Each day cell shows up to two event chips and `+N lagi` beyond that.
A chip links to the detail page.

**`PostCard` renders the event, driven by `post.event !== null`** — a meta
line of date, time and location above the body, and a `Kegiatan` badge beside
the existing `Pengumuman` one. Still one card, for the reason Phase 2 recorded
when it refused a second: a separate `EventCard` is how two feeds start
drifting visually one phase later.

**The composer gains an event fieldset, not a second composer.**
`PostComposer`'s owner-only type `<select>` gets `Kegiatan`; choosing it
reveals title, date, time, optional end time and optional location. Native
`<input type="date">` and `<input type="time">` — a date-picker dependency for
a form with one date in it is the kind of addition this repo does not make,
and the native controls are already keyboard- and screen-reader-correct.

The composer's `onSubmit` gains a **fourth argument, an object**:

```
onSubmit(body, mediaIds, visibilityOrType?, event?)
```

`post-repository.port.ts` records that trailing positional arguments were
rejected in Phase 2 — "a fourth and fifth trailing string argument is exactly
where a caller silently passes `type` into `communityId`". That reasoning is
respected here rather than ignored: slot four is an **object** and slot three
is a **string**, so transposing them is a compile error, not a silent
mis-store. Reshaping `onSubmit` into an options bag would touch all three
existing callers to serve one new one.

**`EventPage` is a new route:** `/komunitas/:slug/kegiatan/:postId`, declared
beside `/komunitas/:slug/diskusi/:postId` and above `/:handleParam` for the
same reason that one is. It renders the date banner, the description, and
Phase 2's `CommentList` **reused unchanged** — the event is a post, so the
existing comment endpoints already answer for it and there is no new backend
behind the thread.

An unknown id renders `NotFoundPage`, matching `DiscussionPage`. A post whose
`event` is `null` — a discussion id typed into an event URL — does the same:
the page cannot render a banner it has no date for, and redirecting to the
discussion would make two URLs for one post.

### One new helper: `wibDate.ts`

`relativeTime.ts` formats from `getUTCDate()` / `getUTCMonth()`. For a relative
label that is harmless. For a calendar it is not: an event at 01:00 WIB on the
16th is `2026-09-15T18:00Z`, and a grid bucketing on UTC parts files it under
the 15th.

So the web app gains a small WIB helper using the shift-and-read-UTC-parts
pattern `remind-expiring-membership.ts` already documents — add
`7 * 60 * 60 * 1000`, then read the UTC fields — reusing `relativeTime.ts`'s
literal `MONTHS_ID` array rather than `Intl.DateTimeFormat`, for the reason
that file records: a build without full ICU silently falls back to English and
the failure only appears in production.

`relativeTime.ts` is **not** changed to match. Its UTC reads are a separate
question about a shipped surface, and answering it inside an events phase is
how an events phase breaks the feed's timestamps.

## Not in this phase

- **RSVP.** See **What reading the reference changed**. One additive table and
  one endpoint whenever the product asks.
- **The live-room link.** The reference's `hasLiveRoom` sends the viewer to
  `LiveRoomPage`, which the programme says cannot be built until Phase 7
  chooses between an SFU and a broadcast studio. No column is added to hold
  the flag: a column nothing writes and nothing reads is a column whose
  meaning is decided by whoever finds it first.
- **Editing or rescheduling an event.** `PATCH /users/posts/:id` edits the
  body; the `community_event` row is immutable once written. Moving an event
  means deleting it and posting it again, which is honest for a phase this
  size and is the same shape Phase 2 shipped comments in (posted or deleted,
  never edited).
- **Recurring events.** Every occurrence is its own row.
- **The sidebar's collapsible joined-communities group.** Phase 2 deferred it
  here on the grounds that Phase 3 would have a list worth collapsing. It
  would, but it is submenu machinery unrelated to events, on top of a calendar
  grid, an agenda, a feed card, a composer type and a detail page. **Deferred
  a second time, and recorded rather than dropped** — it belongs to whichever
  phase touches the shell next, or to a small branch of its own.
- **A calendar anywhere but a community page.** No cross-community agenda on
  Beranda, no "my events". Events reach exactly as far as community posts do.
- **Notifications or reminders** of any kind. Phase 8.

## Testing

**The invariant with no constraint behind it gets the test that cannot pass by
omission.** Nothing in the database forbids a `kegiatan` post without a
`community_event` row, or an event row on a `diskusi`. One test asserts both
directions through the use case: creating a `kegiatan` writes exactly one
event row, and a rejected event payload writes neither row — the rollback, not
just the error.

That test is written against the transaction, not a mock, because the thing
being proven is that the two inserts share one. A mocked unit of work proves
the code calls it, which is the part that was never in doubt.

**The WIB month boundary gets a test at the boundary.** An event at
`2026-08-31T17:00:00Z` is 1 September 00:00 WIB and must appear in
`?month=2026-09` and not in `?month=2026-08`. A test at midday proves nothing
about a rule that is only ever wrong within seven hours of midnight — this
repo already carries a family of boundary tests for exactly this reason
(`billing-cycle.ts`, `remind-expiring-membership.ts`), and the clock is
injected so the boundary is nameable.

The grid's own bucketing gets the same treatment on the web side: the helper,
not the component, is where the boundary is asserted.

Beyond that:

- **Every existing Beranda, profile and community-feed test keeps its current
  expectations and stays green untouched.** That is the proof the `LEFT JOIN`
  and the new `event` key are additive. Any one of them needing an edit is a
  signal to stop and look, not to edit it.
- The one deliberate exception is `post.schema.test.ts`'s `kegiatan`
  rejection, flipped with a comment, as **The contract** states.
- `CreateCommunityPost`'s authorisation gets the `kegiatan` case beside the
  `pengumuman` one it mirrors: a member is refused, the owner succeeds, and an
  unknown slug is a 404 before either check — the ordering
  `community-feed.ts` already documents so a 403 never confirms which slugs
  exist.
- `PostCard` is asserted to render no event meta and no badge when `event` is
  `null`, which is every post on every other surface in the app.
- `EventPage` renders `NotFoundPage` for an unknown id **and** for a post
  whose `event` is `null`.

Per the repo's standing rule, the gate is `bun test` and `bun run typecheck`.
No Playwright run and no dev server is part of this phase's verification.

## Risks

**The duplicated `community_id` is the one piece of denormalised state in this
schema.** It is written once, in the same transaction as the post, by the one
use case that creates events, and no read consults it to answer "which
community owns this post". The exposure is a future second write path that
sets one and not the other. The test above — one event row per `kegiatan`,
nothing on rollback — is what a second write path would have to pass.

**The composer is now doing three jobs** (body, media, and a typed fieldset)
for four post types across three surfaces. It is not yet the file that needs
splitting, but it is the file to watch: Phase 4 adds `materi` and `dokumen`,
each with fields of its own, and that is the point at which the type-specific
fieldsets should become their own components rather than a fourth branch.
