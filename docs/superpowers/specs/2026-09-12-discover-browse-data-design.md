# Discover browse data — tags, trending, price

Sub-project 1 of 3 towards a new Discover page (`docs/references/discover.png`,
mirroring `adamfloothink/diudara`'s `src/pages/Discover.tsx`). This phase widens
`GET /communities` with three fields the reference shows that Diudara's browse
grid does not carry today: **tags**, **trending**, and **price**. It does not
touch the frontend Discover page itself, live-viewer counts, or navigation —
those are sub-projects 2 and 3.

## Goals

- A community can carry tags: set optionally at creation, editable afterwards
  by its owner — the first field a community gains an edit path for.
- `GET /communities` returns each row's tags, a real (not manually-flagged)
  trending signal, and its cheapest active tier's price.
- `GET /communities` also returns the site's most-used tags, for a "Tag
  populer" panel.

## Data model

One migration: add `tags` to `community`.

```
tags: text("tags").array().notNull().default(sql`'{}'::text[]`)
```

A native Postgres text array, not a join table — there is no query in this
phase that needs a tag as its own row (no "communities with tag X, paginated
and sortable" endpoint), only membership-in-a-list checks and a global
frequency count, both of which `unnest()` answers directly. If a later phase
needs tag-scoped browsing at scale, that is the trigger to promote it to a
join table, not this one.

No other column changes. Price and trending are both computed from tables
that already exist:

- **Price** — `user_tier` rows where `community_id = communities.id` and
  `is_active = true`; the one with the lowest `price_amount`. No active tier
  → no price (renders "Gratis", same convention `tierCopy.ts` already uses for
  a `priceAmount === 0` tier).
- **Trending** — `community_member` rows where `community_id = communities.id`
  and `joined_at >= now() - interval '7 days'`, counted per community. The
  top 3 by that count, **provided the count is at least 5** — a floor so a
  quiet community is never badged just for being the least-quiet one. Fewer
  than 3 communities clear the floor → fewer than 3 (or zero) are trending.
  This set is computed **globally**, independent of whatever `search`/
  `category` the caller passed — a filtered view can show zero, one, two, or
  three trending badges depending on which communities it happens to include,
  but the badge always means "one of the site's top 3 this week," never "top
  3 within this filter."

## Shared constants (`packages/shared/src/community.schema.ts`)

```
MAX_COMMUNITY_TAG_LENGTH = 24       // one tag, trimmed, no leading "#"
MAX_COMMUNITY_TAGS = 5              // per community
POPULAR_TAGS_LIMIT = 8              // "Tag populer" panel size
```

A tag is stored lowercase, trimmed, without a leading `#` — the UI adds the
`#` when rendering, the same way `formatRupiah`/`formatTierPrice` format
rather than store their punctuation. Validation (shared, used by both the
create and the edit path): non-empty after trim, `≤ MAX_COMMUNITY_TAG_LENGTH`,
`≤ MAX_COMMUNITY_TAGS` tags, duplicates within one submission collapsed.

## API

### `CommunityListRow` (widened)

```
interface CommunityListRow {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  memberCount: number;
  tags: string[];
  trending: boolean;
  price: { amount: number; billingCycle: string } | null;
}
```

### `GET /communities` (`BrowseCommunities.execute`)

Response becomes `{ communities: CommunityListRow[]; popularTags: string[] }`.
`popularTags` is the top `POPULAR_TAGS_LIMIT` tags by frequency across every
community's `tags`, independent of `search`/`category` — the same
"unfiltered, site-wide" shape as the trending set, and for the same reason:
the reference's own "Tag populer" panel doesn't change when you type into the
search box or tap a category chip.

### `POST /communities` (`CreateCommunity`)

Accepts an optional `tags?: string[]`, validated by the shared schema.
Omitted or empty → `{}`.

### `PATCH /communities/:slug/tags` (new, owner-only)

```
Request:  { tags: string[] }
Response: { tags: string[] }
```

403 when the caller is not the community's owner (same guard shape as
`getCommunityStats`'s owner check). Full replace, not a merge — the caller
sends the complete new list, same convention as every other "set the whole
list" endpoint in this codebase (e.g. tier deactivation is explicit per-row
rather than diffed). Validated by the same shared schema as creation.

## Frontend

- **`CommunityCreatePage`** gets an optional "Tag" field: free text, comma or
  space separated, client-side capped to `MAX_COMMUNITY_TAGS` ×
  `MAX_COMMUNITY_TAG_LENGTH` before submit, same `Field` component the
  existing name/category/description inputs use.
- **`CommunityPage`'s existing owner-only "Keanggotaan" tab** gains a small
  tag-editor section below the tier list: current tags as removable chips, an
  input to add more, saving through the new `PATCH` endpoint. Not a new tab —
  this is a settings concern, and that tab is already where tier settings
  live.
- **`CommunityCard`** (the shared card used by Jelajah's Komunitas tab today,
  and by the future Discover page) renders: tag chips (`.badge-neutral`), a
  trending badge (`.badge-pending`, reusing the class the reference's own
  "Trending" pill visually matches) when `trending` is true, and a price line
  using the existing `formatTierPrice`/`tierCopy.ts` helpers — no new
  formatting code.

## Testing

- API: `browse-communities.test.ts` — widened row shape; trending's boundary
  (4 vs 5 joins, 6 days 23 hours vs 7 days, a 4th community that would qualify
  by count but isn't in the top 3 by count); price (no active tier → `null`;
  two active tiers → the cheaper one; a cancelled/inactive cheaper tier is
  ignored); `popularTags` frequency and its `POPULAR_TAGS_LIMIT` cap.
- API: `create-community.test.ts` — tags accepted, validated, defaulted to
  `{}`.
- API: a new `update-community-tags.test.ts` — replaces the list, rejects a
  non-owner with 403, rejects an invalid tag (too long / too many) with the
  shared schema's error.
- Frontend: `CommunityCreatePage.test.tsx` — the new field, its client-side
  cap. A new tag-editor test alongside `CommunityPage`'s existing owner-tab
  tests. `CommunityCard`'s existing test gains cases for the trending badge,
  price line, and tag chips (including the "no tags" and "no active tier"
  empty states).

## Out of scope (later sub-projects)

Live-status and viewer counts on communities; the Discover page itself and
its wide layout; Jelajah's nav slot and the fate of its "Orang" tab.
