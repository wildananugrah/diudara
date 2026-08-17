# Profiles and Following — Design Spec

Date: 2026-08-18
Status: Approved for planning
Parent: `docs/superpowers/specs/2026-08-17-member-ui-design.md` (the shape) and
`docs/superpowers/specs/2026-08-17-user-accounts-design.md` (Phase 1)

## 1. Purpose

Phase 1 shipped accounts nobody can reach: signup, login and a profile exist, but nothing links to
them and there is no navigation once you are in. This phase makes the app **navigable and social**.

After it: you can reach the app from the front page, move between four destinations, find other
people, follow them, and see who follows whom.

There is still no feed — that is Phase 3. This phase builds the frame it hangs in.

## 2. What the UI spec already settles

Read `2026-08-17-member-ui-design.md` first. It fixes, and this phase must not re-decide:

- Four destinations: **Beranda**, **Jelajah**, **Siaran**, **Profil**
- **Bottom tabs below `md`, a left rail at `md` and above**, from one shared component
- Signup, login and the reset pages render **outside** the shell — no navigation without a session
- **Jelajah is people, not posts**, and it is top-level because it is the only answer to an empty
  follow graph
- The creator dashboard is **not restyled**; it runs untouched until Phase 8

## 3. Scope

**In scope:**
- `AppShell` — both nav shapes, one component
- **Jelajah**: search by handle or display name, plus two plain lists
- Follow and unfollow, with follower and following counts
- The profile screen: a follow button, counts, and links to the lists
- **Entry points on `/`**: "Daftar" and "Masuk" alongside the existing dashboard links
- **Beranda** and **Siaran** as placeholder screens inside the shell

**Out of scope, with why:**
- **Posts and the feed.** Phase 3. Beranda ships as an honest empty state.
- **Going live.** Phase 7. Siaran ships as a placeholder.
- **Blocking and muting.** Real moderation needs a real product decision and there is nothing to
  moderate yet.
- **Notifications** of any kind. Phase 3 at the earliest, and probably later.
- **Algorithmic suggestions.** "Newest accounts" and "most followed" are one query each and enough
  at this size.
- **Restyling the creator dashboard.** Explicitly forbidden by the UI spec.

## 4. The follow model

A `follow` table, deliberately minimal:

| column | notes |
|---|---|
| `id` | uuid pk |
| `follower_id` | uuid not null → `app_user` |
| `followee_id` | uuid not null → `app_user` |
| `created_at` | timestamptz not null default now |

**A unique index on `(follower_id, followee_id)`** — following twice is one row, arbitrated by the
database rather than by a read-then-write. This project's established pattern; see
`join_request_community_member_pending_unique` and the concurrency test that proves it.

**Two further indexes**, because both directions are read on every profile view:
`(followee_id, created_at)` for "who follows this person" and `(follower_id, created_at)` for "who
they follow". Missing indexes on exactly this shape caused a seq scan in the renewal passes that
went unnoticed for a phase.

**`follower_id = followee_id` is refused.** Following yourself is not a feature and the check is
one line. A database CHECK constraint rather than only a use-case guard, so it holds however the
row arrives.

### 4.1 Counts are computed, not stored

`COUNT(*)` against the indexes above, per profile view. **No denormalised counter column.**

A counter is the obvious optimisation and the wrong one now: it must be kept correct under
concurrent follows and unfollows, which means a transaction or a trigger, which is a real source of
drift for a number nobody is looking at yet. At this size the count query is a single index scan.

**Revisit when a profile view measurably slows**, not before — and record the measurement rather
than assuming.

## 5. Jelajah

Three things on one screen:

- **Search** by handle or display name, case-insensitive, prefix-matched.
- **Terbaru** — the newest accounts.
- **Paling diikuti** — the most followed.

Both lists are capped at a page of results with no infinite scroll. Search matches against the
normalised `handle` and against `display_name`.

**Search must not become an enumeration surface.** Phase 1 went to considerable lengths so signup
and password reset cannot be used to test whether an email is registered. Jelajah searches handles
and display names — both public by design, both already browsable at `/@handle` — and **must never
match on email or WhatsApp number.** A search that accepted an email address would undo the whole
of Phase 1's §5.1.

## 6. The profile screen

For any user at `/@handle`:

- display name, handle, bio
- **follower and following counts**, each linking to a list
- a **follow / unfollow** button — absent on your own profile, absent when signed out with "Masuk
  untuk mengikuti" in its place

The public projection stays exactly what Phase 1 pinned — `handle`, `displayName`, `bio`,
`createdAt` — plus the two counts and, for a signed-in viewer, whether they already follow.
**No email, no WhatsApp number, no id.** Phase 1's review found that invariant defended on only two
of five repository paths, and a bare `select()` returns every column regardless of what TypeScript
says. Assert on response keys, not on types.

## 7. Errors

| Condition | Behaviour |
|---|---|
| Follow an unknown handle | 404 |
| Follow yourself | 409, in Bahasa Indonesia |
| Follow someone you already follow | **200, idempotent.** A double-tap must not error; the unique index makes the second a no-op |
| Unfollow someone you do not follow | **200, idempotent.** Same reasoning |
| Follow or unfollow without a session | 401 |
| Jelajah search with an empty query | The two lists, no error |
| A profile with no bio | Renders without an empty element |
| An unknown handle | The existing 404 page, with no hint whether the handle is free |

Follow and unfollow are **idempotent by design**. A button that errors when the state already
matches what you asked for is a worse experience than one that agrees, and on a phone a double-tap
is the common case rather than the edge case.

## 8. Testing

- The unique index arbitrates a concurrent double-follow — driven with `ArrivalLatch`, the way
  `markPastDue` and `createPending` already are, not sequentially.
- Following yourself is refused **at the database**, not only in the use case: insert directly and
  confirm the CHECK rejects it.
- Counts are correct after a follow, an unfollow, and a re-follow.
- **The profile response's keys are asserted**, and contain no email — the form
  `expect(Object.keys(body).sort()).toEqual([...])`, which is what bites.
- **Jelajah search by a registered email returns nothing** — the enumeration guard of §5.
- Both nav shapes render: bottom tabs below `md`, left rail above, and every destination reachable
  in each.
- Signup, login and the reset pages render **without** the shell.
- The landing page's new links resolve, and the existing dashboard links still do.
- No `expect(<DOM element>).toBeNull()` — it hangs `bun test`; there is a source-scan guard.

## 9. Honest limitations

**Beranda and Siaran ship empty.** They are placeholders with honest copy, not stubs pretending to
load. A user completing this phase can navigate, find people and follow them, and there is nothing
to read. That is the cost of building the frame before the content, and it is the right order
because the frame is what both later phases hang in.

**No notifications**, so a followed user learns nothing about it. Acceptable while nobody is using
this; not acceptable by the time posts exist.

**No blocking.** There is no way to stop somebody following you. Fine at this size, and it needs a
real moderation design rather than a bolted-on flag.

**The shape is still unvalidated.** The UI spec says the cheapest correction point is after Phase 3,
when there is a feed to look at. This phase does not change that — it makes the guess concrete.

**Two account systems still coexist.** A person can hold both a creator account and a user account
with the same email, and neither knows about the other. Unchanged from Phase 1; retires in Phase 8.
