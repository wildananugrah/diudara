# Phase 1 — Communities core

**Date:** 2026-09-09
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 0, `2026-09-09-udara-design-system-design.md` (merged)
**Branch:** `feat/communities-core`

## Goal

A signed-in user can create a community, find one, join it, and see who else is
in it. That is the whole phase.

No tiers, no payments, no feed, no events. Those are Phases 2–5 and each has a
reason to arrive later than this one.

## What the exploration changed

The programme spec said Phase 1 would "revive `community`, `channel`,
`join_request`". That is not viable, and the reason matters enough to record.

**The legacy community tables are entirely dead.** No non-test file in
`apps/api`, `apps/worker` or `apps/web` reads or writes any of the eighteen.
The only importer is `src/db/test-helpers.ts`, which truncates them. Four
commits removed the community-centric API wholesale — `create-community`,
`start-checkout`, `process-renewals`, the creator login, `routes/auth.ts`,
`http/auth.middleware.ts` and about twenty use-cases with them.

**And a community cannot belong to a user.** `community.creator_id` is
`NOT NULL REFERENCES creator(id)`, and `creator` is a separate identity table
from `app_user`: no foreign key, no shared id, and no login path since
`c8c5046` deleted it. `app_user`'s own docstring calls a creator "a different
owner entirely", and `PaymentProviderPort` carries an instruction not to join
the two.

**This repo has answered the underlying question four times.** `user_tier`,
`user_subscription`, `user_stream` and `membership_reminder` are each a new
user-scoped table placed *beside* a dormant community-scoped one, each
documenting the same reason — the old table's `NOT NULL community_id` — and the
same payoff: "Phase 8 becomes a deletion rather than an untangling."

The precedent existed to protect the `/dashboard/*` creator identity. That
identity, its routes and its login are deleted. The thing the precedent
protected is gone, so this phase takes the deletion the precedent was saving up
for.

## The schema

### Deletion

Drop all eighteen dormant tables. Fifteen from the community-centric model —
`creator`, `community`, `membership_tier`, `channel`, `channel_membership`,
`member`, `subscription`, `renewal_reminder`, `join_request`, `transaction`,
`activity_log`, `event`, `event_rsvp`, `course`, `enrollment` — plus
`ai_conversation`, `ai_message` and `ai_usage`, which are creator-scoped and
equally dead.

They must be dropped children-before-parents, or the foreign keys refuse:
`enrollment` and `course` before `community`; `event_rsvp` before `event`;
`renewal_reminder` and `transaction` before `subscription`; `subscription`
before `membership_tier` and `member`; `channel_membership` before `channel`;
`join_request` before all three of `community`, `membership_tier` and `member`;
`activity_log` before `member` and `community`; the three `ai_*` tables before
`creator`; and `community` before `creator` last of all. Drizzle generates this
order from the schema, but the generated SQL is worth reading before it is
committed.

Also removed: their `db.delete(...)` lines in `resetDatabase()`, the roughly ten
`src/db/schema-*.test.ts` files that exist only to prove their constraints round
trip, and the four orphaned `UniqueRule` entries in `application/errors.ts`
(`creatorEmail`, `communitySlug`, `channelPlatformGroup`,
`subscriptionMemberTierActive`) that no code can raise.

**The repo owner authorised this loss explicitly**, having been told it includes
`transaction` (amounts, payment methods, gateway references, paid-at),
`subscription`, `member` (WhatsApp numbers) and `creator` (emails, password
hashes, Xendit account ids). The migration is committed here; the owner runs
`bun run db:migrate` themselves. Nothing in this repo's tooling reaches a
deployed database.

This also retires the `0003_romantic_rattler.sql` hazard permanently: that
migration adds `community.slug` as `NOT NULL` with no default and no backfill,
and fails outright on any table holding rows. It cannot be fixed by a later
migration and has sat unresolved since. Dropping the table it targets ends it.

### Creation

Two tables. The name `community` is free once the old one is dropped, and the
product's central concept should have it.

```ts
export const communities = pgTable(
  "community",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => appUsers.id),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 60 }).notNull().unique(),
    category: varchar("category", { length: 64 }).notNull(),
    description: varchar("description", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_owner_idx").on(table.ownerId),
    index("community_category_created_idx").on(table.category, table.createdAt),
  ],
);

export const communityMembers = pgTable(
  "community_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id").notNull().references(() => communities.id),
    userId: uuid("user_id").notNull().references(() => appUsers.id),
    role: varchar("role", { length: 16 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("community_member_unique").on(table.communityId, table.userId),
    index("community_member_user_idx").on(table.userId),
    index("community_member_community_joined_idx").on(table.communityId, table.joinedAt),
  ],
);
```

`role` is `owner` or `member`. Creating a community writes the community row and
the owner's `community_member` row in one transaction — a community with no
members is not a state this app should be able to reach.

**Three things deliberately absent.**

*No `color` column.* The reference gives each community a palette colour, used
on its Discover card. Deriving it from the slug — a hash into a fixed list of
Udara hues — is deterministic, needs no storage, needs no colour picker in the
create form, and cannot drift off-palette. It lives in the web app as a pure
function, because a colour is presentational and the API should not carry it.

*No denormalised member count.* `count(*)` over `community_member` is correct,
and this product has no communities yet. Denormalise when a query plan says to.

*No `access_mode`.* The old table had `paid | request`; this phase has one join
model, and a column with one legal value is a column that lies about its future.

## The API

A new `/communities` router, following the vertical slice this codebase already
uses: route handler → use-case → port interface → Drizzle repository, hand-wired
in `bootstrap()`. Six endpoints.

| Method | Path | Auth | Returns |
|---|---|---|---|
| POST | `/communities` | required | the created community |
| GET | `/communities` | optional viewer | browse: search + category + keyset page |
| GET | `/communities/:slug` | optional viewer | one community + the viewer's membership state |
| POST | `/communities/:slug/join` | required | `{ member: true }` |
| DELETE | `/communities/:slug/join` | required | `{ member: false }` |
| GET | `/communities/:slug/members` | optional viewer | the roster |

"Optional viewer" means `resolveViewerId` rather than `requireUserAuth` — the
pattern `/users/by-handle/:handle` and `/users/explore` already use, so a
response can distinguish "anonymous" from "signed in but not a member".

**Slug generation** mirrors `domain/handle.ts`: derived from the name,
lowercased, non-alphanumerics collapsed to hyphens, and unique. A collision
returns a `ConflictError` naming the taken slug rather than silently appending a
number — the user picked the name and should get to pick again.

**Category** is validated against a fixed six in a new
`packages/shared/src/community.schema.ts`: `Bimbel & Ujian`, `Coaching Bisnis`,
`Kajian & Rohani`, `Edukasi Finansial`, `Skill Digital`, `Kreator & Media`.
These are the reference's own categories. The package previously held exactly
such a file and it was deleted with the old API; this restores the pattern
`auth.schema.ts` and `media.schema.ts` follow.

**Joining is idempotent**, like following: joining twice returns
`{ member: true }` and writes one row, via `onConflictDoNothing`.

**An owner cannot leave their own community.** The use-case rejects it with a
`ConflictError` before reaching the repository, the way `FollowUser` rejects a
self-follow — a precondition enforced in the use-case so a raw constraint error
can never abort an enclosing transaction. Deleting or transferring a community
is not in this phase, so an owner who wants out has no route; that is honest
rather than accidental, and Phase 6's dashboard is where it belongs.

**The roster is capped** at the same 50 as the follow lists, and says so when it
truncates, reusing `DEFAULT_FOLLOW_LIST_LIMIT`'s established shape.

## The web app

**`/jelajah` becomes two tabs.** Komunitas and Orang, with the tab state in the
URL as `?tab=`, exactly as Beranda already does it — including the
`aria-current` keying and the single-declaration indicator its test pins.

- **Komunitas** is the reference's Discover layout: a search field, a horizontal
  row of category chips, and a responsive grid of community cards. Each card
  carries the initial tile in its derived colour, the name, the description, and
  the member count. Search is submit-only, matching the existing Jelajah search
  and for the same reason — the endpoint groups over a whole table.
- **Orang** is today's Jelajah, unchanged: Hasil pencarian, Akun terbaru, Paling
  banyak diikuti.

**`/komunitas/:slug`** is CommunityHome, reduced to what Phase 1 can fill: the
reference's gradient banner (initial tile, name, `N anggota · Kategori`), a join
or leave button, and the member roster.

**No tab bar on CommunityHome.** The reference has six tabs; this phase can fill
one. Rendering five empty or disabled tabs would break the project's own rule
that a control is never rendered for an action that would fail. Phase 2 adds the
bar when Feed gives it a second tab.

**`/komunitas/baru`** is the create form: name, category, description. Reached
from a button on the Komunitas tab. The reference reaches creation through its
Pulse-ID AI onboarding, which is Phase 8; a plain form is what this phase can
honestly ship.

**Navigation** keeps Phase 0's four destinations. The sidebar's collapsible
joined-communities group — the submenu machinery deliberately cut from Phase 0 —
stays cut: it wants a list worth collapsing, and Phase 2 has the better claim on
building it.

**Vite proxy.** `/communities` must be added to the proxy table in
`vite.config.ts`. `src/test/vite-proxy-coverage.test.ts` greps every fetch call
site for its first path segment and fails if the table cannot match it, so this
is enforced rather than remembered.

## Not in this phase

Tiers, prices and the paid join button (Phase 5). The feed and the Materi,
Kegiatan, Pengumuman and Dokumen tabs (Phases 2–4). Editing or deleting a
community, and transferring ownership (Phase 6). Removing a member — the
pattern exists in `SubscriberList`, but nothing forces it until there is a paid
membership worth revoking, so it arrives with checkout in Phase 5. The invite
modal. Live badges on community cards, which need Phase 7's decisions.

## Testing

The house pattern, unchanged:

- **Use-case tests** with hand-written in-memory fakes, one per port, each fake
  throwing `"not used in these tests"` for unimplemented methods and counting
  calls so a test can assert a port was never reached.
- **Repository tests** against the real per-run database, proving the uniqueness
  constraint and the idempotent join actually hold at the storage layer.
- **Route tests** through `createApp(bootstrap())`, creating accounts via the
  real signup and login routes, asserting status codes and wire bodies.
- **Web component tests** by role, label and text, never by class name.

New tables must be added to `resetDatabase()` in FK order — children before
parents — or every later test file fails on a foreign key violation. The
deleted tables must be removed from it in the same edit.

All UI copy in Bahasa Indonesia. Failure copy derives from the error's shape
through `errorCopy.ts`, never from a server message; `no-raw-server-errors.test.ts`
enforces it.

## Risks

**The migration is destructive and the owner runs it.** Dropping eighteen tables
is irreversible. The migration is one generated file, reviewed before commit,
and executed by hand by the owner against whatever database they choose.

**Slug collisions are user-visible.** Two communities cannot share a name that
slugifies identically. The error copy has to say so in a way that suggests a fix
rather than reporting a constraint.

**`/jelajah` gaining tabs touches a tested page.** Its existing tests query by
role and text, so adding a tab layer above them should not move them — but the
Beranda tab-indicator invariant shows how this kind of change has broken before,
and the same care applies.
