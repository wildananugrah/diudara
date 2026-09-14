/** 3-60 chars, lowercase letters, digits and hyphens — the column is varchar(60). */
export const COMMUNITY_SLUG_PATTERN = /^[a-z0-9-]{3,60}$/;

const MAX_SLUG_LENGTH = 60;

/**
 * Derive a URL slug from a community's name.
 *
 * Returns an empty string when the name contains nothing sluggable, rather
 * than inventing a placeholder: the caller decides what to tell the user, and
 * a generated slug the user never chose is worse than a clear rejection.
 */
export function slugifyCommunityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

export function isValidCommunitySlug(slug: string): boolean {
  return COMMUNITY_SLUG_PATTERN.test(slug);
}

/**
 * Slugs nobody may take, because each is a literal segment of a real route
 * and a community holding it would be unreachable.
 *
 * `baru` is `/komunitas/baru`, the web create form. `pengikut` and
 * `mengikuti` are the second segments of `/:handleParam/pengikut` and
 * `/:handleParam/mengikuti`: for the URL `/komunitas/pengikut`, react-router
 * scores that route and `/komunitas/:slug` identically — one static segment
 * and one dynamic each — so the winner is decided by declaration order
 * rather than by intent.
 *
 * `mine` is the API's own version of the same hazard, one layer down:
 * `GET /communities/mine` (the sidebar's joined-communities list —
 * `ListMyCommunities`) is a literal first segment after `/communities`,
 * exactly where `GET /communities/:slug` sits. `routes/communities.ts`
 * declares `/mine` before `/:slug` as the first defense; this is the second,
 * the same belt-and-suspenders `RESERVED_COMMUNITY_SLUGS`'s own docstring
 * on `documents` already argues for.
 */
export const RESERVED_COMMUNITY_SLUGS: ReadonlySet<string> = new Set([
  "baru",
  "mengikuti",
  "mine",
  "pengikut",
]);

export function isReservedCommunitySlug(slug: string): boolean {
  return RESERVED_COMMUNITY_SLUGS.has(slug);
}
