import { describe, expect, it } from "bun:test";
import { rules, stylesheet } from "./stylesheet";

/**
 * Every rule that sets BOTH a text colour and a background must clear WCAG AA
 * for normal text (4.5:1).
 *
 * This exists because the design language ported in Phase 0 does not clear AA
 * on its own: its primary button was white-on-orange at 2.45:1, its secondary
 * white-on-mist at 2.27:1, its danger 3.80:1, and three more besides. All were
 * caught by hand, one at a time, across three reviews. A guard finds the next
 * one on the commit that introduces it.
 *
 * WHAT THIS CANNOT DO, stated plainly: it only sees a colour and a background
 * declared in the SAME rule. Text inheriting its colour from an ancestor while
 * sitting on a background set elsewhere is invisible to it, and so is anything
 * whose value is not a plain hex after resolution — color-mix(), gradients,
 * currentColor, transparent. Those are skipped, not guessed. It is a floor,
 * not a proof.
 *
 * The 4.5:1 threshold is applied regardless of font size. A few call sites are
 * large enough for the 3:1 allowance, but the rule text does not reliably say
 * so, and holding everything to the stricter number costs nothing here.
 */

function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * linearise((n >> 16) & 0xff) +
    0.7152 * linearise((n >> 8) & 0xff) +
    0.0722 * linearise(n & 0xff)
  );
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `:root`'s custom properties, name -> raw value. */
function tokens(css: string): Map<string, string> {
  const root = rules(css).find((rule) => rule.selector === ":root");
  const map = new Map<string, string>();
  if (root === undefined) return map;
  for (const match of root.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

/**
 * Resolve a declaration value to `#rrggbb`, or null when it is not a plain
 * colour. Follows `var()` chains — this sheet's aliases are two deep
 * (`--green` -> `--sinyal` -> `#e8873e`) — with a depth cap so a cycle cannot
 * hang the suite.
 */
function resolve(value: string, map: Map<string, string>, depth = 0): string | null {
  const v = value.trim();
  if (depth > 6) return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
  }
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref === null) return null;
  const next = map.get(ref[1]!);
  return next === undefined ? null : resolve(next, map, depth + 1);
}

/** Every rule declaring both a resolvable colour and a resolvable background. */
function pairs(css: string): { selector: string; ratio: number }[] {
  const map = tokens(css);
  const found: { selector: string; ratio: number }[] = [];
  for (const rule of rules(css)) {
    if (rule.selector === ":root") continue;
    const fg = /(?:^|;)\s*color:\s*([^;]+)/.exec(rule.body);
    const bg = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(rule.body);
    if (fg === null || bg === null) continue;
    const ink = resolve(fg[1]!, map);
    const ground = resolve(bg[1]!, map);
    if (ink === null || ground === null) continue;
    found.push({ selector: rule.selector, ratio: contrastRatio(ink, ground) });
  }
  return found;
}

describe("text contrast", () => {
  it("clears WCAG AA on every rule that sets both a colour and a background", () => {
    const failures = pairs(stylesheet())
      .filter((pair) => pair.ratio < 4.5)
      .map((pair) => `${pair.selector} ${pair.ratio.toFixed(2)}:1`);

    // Named, not counted: a failure must say WHICH rule and by how much.
    expect(failures.join(" | ")).toBe("");
  });

  it("actually examined the sheet — a vacuous pass here would hide every failure", () => {
    // The sheet held 31 such pairs when this guard was written. A resolver that
    // silently stopped matching would make the assertion above pass on nothing.
    expect(pairs(stylesheet()).length >= 20).toBe(true);
  });
});
