import { describe, expect, it } from "bun:test";
import { rules, stylesheet } from "./stylesheet";

/**
 * The palette's two accessibility deviations from the reference mockup, pinned
 * so they cannot be "corrected" back to the reference's own figures by someone
 * comparing the two files side by side.
 *
 * Measured on the reference's values: `--ink-500 #6c8298` on `--awan #f4f7fa`
 * is 3.70:1 and `--ink-300 #a9b7c4` is 1.90:1. WCAG AA wants 4.5:1 for normal
 * text, and the reference sets every meta line at 12–12.5px in `--ink-500` and
 * every timestamp at 11.5px in `--ink-300` — body text at small sizes, so the
 * 3:1 large-text allowance does not apply to either.
 *
 * This repo had already fought this once: `--ink-faint` was set to
 * `oklch(0.53 …)` rather than `0.55` because 0.55 measured 4.24:1 on
 * `--canvas`, and `.muted` lands on that background in seven components.
 * Adopting the reference verbatim would have thrown that away.
 */

/** One channel of sRGB, linearised per WCAG 2.x. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` string. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = linearise((n >> 16) & 0xff);
  const g = linearise((n >> 8) & 0xff);
  const b = linearise(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, always >= 1, order-independent. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The value of one custom property declared on `:root`. */
function token(name: string): string {
  const root = rules(stylesheet()).find((rule) => rule.selector === ":root");
  expect(root === undefined).toBe(false);
  const match = new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`).exec(root!.body);
  expect(match === null).toBe(false);
  return match![1]!.trim();
}

describe("design tokens", () => {
  it("declares the Udara palette", () => {
    expect(token("--langit")).toBe("#2b4c6f");
    expect(token("--sinyal")).toBe("#e8873e");
    expect(token("--awan")).toBe("#f4f7fa");
    expect(token("--ink-900")).toBe("#16283a");
  });

  it("keeps --ink-500 above WCAG AA on --awan, darker than the reference's own value", () => {
    const ratio = contrastRatio(token("--ink-500"), token("--awan"));
    // Named in the message rather than counted, so a failure says how far off it is.
    expect(`${token("--ink-500")} @ ${ratio.toFixed(2)}:1`).toBe("#5d7189 @ 4.66:1");
    expect(ratio >= 4.5).toBe(true);
  });

  it("keeps the reference's own --ink-500 out of the sheet, because it fails AA", () => {
    expect(contrastRatio("#6c8298", "#f4f7fa") < 4.5).toBe(true);
    expect(stylesheet().includes("#6c8298")).toBe(false);
  });

  it("never uses --ink-300 for a text colour, because it measures 1.90:1", () => {
    expect(contrastRatio(token("--ink-300"), token("--awan")) < 3).toBe(true);
    const textRules = rules(stylesheet()).filter((rule) =>
      /(?:^|;)\s*color:\s*var\(--ink-300\)/.test(rule.body)
    );
    expect(textRules.map((rule) => rule.selector).join(" | ")).toBe("");
  });

  it("aliases every legacy token so the 1,711 existing lines re-tint untouched", () => {
    for (const alias of ["--green", "--ink", "--canvas", "--line", "--red", "--gate"]) {
      expect(token(alias).startsWith("var(--")).toBe(true);
    }
  });
});
