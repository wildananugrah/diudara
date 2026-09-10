/**
 * The hues a community card may take, all Udara tokens.
 *
 * A community's colour is DERIVED from its slug rather than stored. The design
 * reference gives each community a colour on its Discover card; deriving it
 * means no column, no picker in the create form, and no way for a card to end
 * up off-palette. The cost is that a community cannot choose its colour, which
 * is a feature nobody has asked for.
 */
export const COMMUNITY_COLORS: readonly string[] = [
  "var(--langit)",
  "var(--hijau-lepas)",
  "var(--sinyal)",
  "var(--merah-senja)",
  "var(--langit-light)",
  "var(--kabut)",
];

/**
 * The ink for the initial sitting ON each hue above, index for index —
 * whichever of white and `--ink-900` actually reads there.
 *
 * **Chosen by measurement, not by eye**, because half the palette flips: white
 * on `--sinyal` is 2.64:1 and on `--kabut` 2.44:1, both unreadable, while
 * `--ink-900` on `--langit` is 1.69:1. The measured pairs, in order:
 *
 *   --langit       white     8.88:1
 *   --hijau-lepas  white     4.02:1  ← the one exception, see below
 *   --sinyal       ink-900   5.70:1
 *   --merah-senja  white     4.56:1
 *   --langit-light white     5.99:1
 *   --kabut        ink-900   6.16:1
 *
 * `--hijau-lepas` clears 3:1 but not 4.5:1 on either ink (4.02 white, 3.74
 * dark). The tile's initial is deliberately large and bold, which is the
 * threshold WCAG applies to it, and the glyph is `aria-hidden` and redundant
 * with the community name beside it — so the worst case is a slightly soft
 * letter next to legible text, never information nobody can reach.
 *
 * `contrast.test.ts` cannot see any of this: the background arrives as an
 * inline style, and that guard only reads pairs declared in one CSS rule. The
 * numbers above are the record that it was checked anyway.
 */
export const COMMUNITY_INKS: readonly string[] = [
  "var(--surface)",
  "var(--surface)",
  "var(--ink-900)",
  "var(--surface)",
  "var(--surface)",
  "var(--ink-900)",
];

/** FNV-1a, for a stable spread across the palette from a short string. */
function paletteIndex(slug: string): number {
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i += 1) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % COMMUNITY_COLORS.length;
}

export function communityColor(slug: string): string {
  return COMMUNITY_COLORS[paletteIndex(slug)]!;
}

/** The ink that reads on `communityColor(slug)`. Same index, by construction. */
export function communityInk(slug: string): string {
  return COMMUNITY_INKS[paletteIndex(slug)]!;
}
