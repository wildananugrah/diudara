# The Discover page

Sub-project 3 of 3 towards a Discover page matching `docs/references/discover.png`
(mirroring `adamfloothink/diudara`'s `src/pages/Discover.tsx`). This phase builds
the page itself, on top of the two already-shipped sub-projects: real tags,
trending and price on every community row (`GET /communities`), and a real
live-viewer count on every stream (`GET /streams`). Nothing here is a design
question any more except three: what to call it, where its old tenant's second
feature goes, and how a community learns its own owner is live. All three are
already decided or scoped below.

## Naming and routing

**Renamed, not added alongside.** "Discover" replaces "Jelajah" as both the nav
label and the route (`/discover`, not `/jelajah`) — the one English word in an
otherwise all-Bahasa-Indonesia nav, a deliberate exception rather than an
oversight. `JelajahPage.tsx` becomes `DiscoverPage.tsx`; every place that named
the old route or label is updated to the new ones (`App.tsx`, `AppShell.tsx`'s
`STATIC_DESTINATIONS`, `Sidebar.tsx`'s icon map, `BerandaPage.tsx`'s empty-state
link, `CommunityCreatePage.tsx`'s category hint, `LandingPage.tsx`'s marketing
copy, the page's own `LOAD_FAILED_MESSAGE`). Comments that narrate PAST events
("the pattern that produced the English Zod sentence on Jelajah") stay as
written — renaming a page does not rewrite history.

**Orang moves with it, as a second tab — not dropped.** Jelajah was always two
halves under one tab strip: Komunitas (the community grid this phase replaces)
and Orang (people search — newest/most-followed accounts, unrelated to
communities). `OrangTab` and its `FollowRow` export move into
`DiscoverPage.tsx` UNCHANGED; only the Komunitas half's content is replaced by
this phase's richer layout. The tab strip, the `?tab=` convention, and
`FollowListPage.tsx`'s import of `FollowRow` all keep working, just from the
renamed file.

## The one new backend piece: is a community's owner live

`CommunityListRow` gains one field:

```
live: { streamId: string; viewerCount: number } | null
```

Computed the same way `trending` and `price` already are — inside
`DrizzleCommunityRepository.browse()`, via a join most callers never see: a
community's owner has at most one `live` `user_stream` row
(`user_stream_one_live`'s own partial unique index guarantees it), so
"is this community live" is a join on `communities.owner_id = user_stream.owner_id
AND user_stream.status = 'live'`, and its viewer count is the same
`stream_viewer_heartbeat` count `DrizzleStreamViewerRepository.countRecentViewers`
already computes, queried directly against the schema table the same way
`browse()` already reaches into `user_tier` for price — not through the other
repository CLASS, matching this file's existing style of composing by schema
table rather than by injecting sibling repositories.

**`VIEWER_HEARTBEAT_WINDOW_MS` moves to `domain/`.** It lives in
`application/use-cases/stream-views.ts` today, which `DrizzleCommunityRepository`
(infrastructure) must not import — that would run the dependency arrow
backwards. It relocates to a small new `domain/viewer-heartbeat-window.ts` (the
same shape `user-watch-token.ts`'s `USER_WATCH_TOKEN_TTL_MS` already has: a pure
constant, no imports from `application/` or `infrastructure/`), and both
`stream-views.ts` and the community repository import it from there. One
constant, one source, same value (20 seconds) either place it is read.

**Shown regardless of visibility**, the same call `viewerCount` on `StreamView`
already made: a `members`-only stream's live status and viewer count are still
a discovery signal even to a visitor who cannot watch it yet — nothing here
changes what the card LINKS to (still gated the normal way once you get there).

## Layout: the wide frame, only here

`PageContainer` (`shell/PageContainer.tsx`) — a 1180px cap, 20px padding,
already built and explicitly "kept for the wide community pages a later phase
is expected to add" — replaces `.user-page`'s 36rem cap for this ONE page.
Every other page is untouched; the open question Phase 0's handoff raised is
answered here, narrowly, rather than by moving every page onto the wide frame
at once.

Below 768px (the shell's existing single breakpoint — `AppShell`'s bottom-nav
switch, reused rather than inventing a second one) the two-column layout
becomes one column: the sidebar (tag cloud + CTA card) stacks BELOW the
community grid rather than beside it. Above 768px, `grid-template-columns:
minmax(0, 1fr) 300px` — the reference's own split, expressed as a CSS class
rather than the reference's inline `style={{}}`, matching every other
component in this codebase since Phase 0 collapsed the two competing style
layers into one.

## The page itself

**Header**: title "Discover", subtitle "Gabung komunitas yang cocok dengan
minatmu" — unchanged regardless of which tab is active, the same way Jelajah's
one header served both its tabs.

**Tab strip**: Komunitas (default) / Orang, `DiscoverPage`'s own `feed-tabs`
markup, unchanged from Jelajah's.

**Komunitas tab — the new content, wide frame:**
- Search input + "Cari Komunitas" button, submitting into the same
  `browseCommunities({ q, category })` call `KomunitasTab` already makes —
  submit-on-click/enter, not per-keystroke, for the reason that use case's own
  docstring already gives (an `ILIKE` over a grouped join is not a thing to
  re-run per keystroke).
- Category chips: "Semua" plus the six `COMMUNITY_CATEGORIES`, the exact
  component Jelajah already has, restyled to the reference's pill shape (most
  of that styling already exists on `.category-chip`).
- "Sedang berlangsung" live-now strip — shown only when at least one returned
  community's `live` is non-null. Each card: the community's tile colour/ink
  (`communityColor`/`communityInk`, already built), a LIVE badge, the viewer
  count ("128 nonton"), name and category. Click navigates to
  `/siaran/{live.streamId}` (this app's live-room route — the reference's own
  `/live/:id` has no equivalent here).
- "Semua komunitas · N hasil" (or the active category's name) heading, then the
  community grid — every row rendered through the EXISTING `CommunityCard`,
  unchanged: it already renders the trending badge, price line and tag chips
  sub-project 1 built. No new card component.
- Sidebar: a "Tag populer" card listing `popularTags` (already returned
  alongside `communities` by `GET /communities`) as badge chips, and the
  "Punya komunitas sendiri?" CTA card linking to `/komunitas/baru` — this
  app's real creation flow, standing in for the reference's `/onboarding`. The
  CTA copy keeps its "bareng Pulse-ID" line verbatim: Pulse-ID is this
  project's own real, already-named, deliberately-unbuilt concept (see the
  commit recording that), not a fabricated claim — the link it sends someone to
  is real even though the automated setup the copy imagines is not built yet.

**Orang tab**: `OrangTab`, byte-for-byte what Jelajah already had.

**Not built**: "Komunitas" and "Dashboard Creator" as SEPARATE nav destinations,
and "Pulse-ID" as a nav destination at all — the reference's sidebar shows all
four, but only Discover corresponds to anything this app has. Adding nav items
for pages that do not exist would be a nav a visitor could not use; that is a
later phase's decision, not this one's.

## Testing

- `DrizzleCommunityRepository`'s test — `browse()`'s `live` field: a community
  whose owner has a `live` public stream reports `{ streamId, viewerCount }`
  matching a real heartbeat; a `members`-only owner's live stream still reports
  it (visibility is not the gate here); an owner with no live stream, or whose
  stream has ended, reports `null`; the viewer count reads through the same
  20-second window `stream_viewer_heartbeat`'s other consumer uses.
- `domain/viewer-heartbeat-window.test.ts` — trivial, pins the value now that
  two files depend on it agreeing.
- `DiscoverPage.test.tsx` (renamed from `JelajahPage.test.tsx`, its Orang-tab
  tests unchanged): the search/category/tab-strip tests that existed carry
  over; new tests cover the live-now strip's conditional render, its link
  target, and that `CommunityCard` is what renders each grid row (not a
  reimplementation).
- Every file whose `/jelajah`-facing string changed gets its own test's
  assertion updated to match (`BerandaPage.test.tsx`'s empty-state link,
  `AppShell.test.tsx`'s nav label/route, `Sidebar`'s icon-per-path test if one
  exists) — a grep for `/jelajah` and `"Jelajah"` across `apps/web/src` after
  the rename must return nothing outside historical prose comments.

## Out of scope

Nothing — this is the last of the three sub-projects. Loose ends explicitly
NOT picked up here, for a later pass to decide deliberately: "Komunitas" and
"Dashboard Creator" as their own nav destinations; a Pulse-ID product of any
kind; adopting the wide 1180px frame anywhere beyond this one page.
