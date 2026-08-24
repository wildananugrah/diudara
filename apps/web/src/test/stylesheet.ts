import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Helpers for tests that assert on `src/styles.css` as TEXT.
 *
 * Extracted from `BerandaPage.test.tsx`, which needed them first, once a
 * second test (`AppShell.test.tsx`'s nav stacking invariant) needed the same
 * parsing. Two hand-rolled CSS parsers that normalise slightly differently
 * would disagree about what the sheet says, which is the one thing a test of
 * this kind cannot afford.
 *
 * WHAT TESTS BUILT ON THIS CANNOT DO — worth repeating at every call site:
 * this reads rule text. It cannot weigh specificity, see `!important`, know
 * which `@media` block a rule sits in, or account for inline styles or a
 * second stylesheet. It catches "the declaration is missing" and "something
 * else declares it too", which is what these invariants are about.
 */

/**
 * `src/styles.css`, normalised: comments stripped first (so a selector NAMED in
 * prose is never mistaken for a rule), then quotes removed and whitespace
 * collapsed — `[aria-current="true"]` and `[aria-current=true]` are the same
 * selector and must not read differently here.
 */
export function stylesheet(): string {
  return readFileSync(join(import.meta.dir, "../styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Every rule in the sheet as `{ selector, body }`. The pattern matches INNERMOST
 * braces, so a rule nested in an `@media` block is returned on its own and the
 * at-rule's prelude is skipped — which also means the media condition is lost.
 */
export function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!.trim(),
  }));
}

/** Selectors as one readable string, so a failure names the offender instead of printing a count. */
export function selectors(matched: { selector: string }[]): string {
  return matched.map((rule) => rule.selector).join(" | ");
}
