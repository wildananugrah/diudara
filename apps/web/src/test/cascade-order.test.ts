import { describe, expect, it } from "bun:test";
import { rules, stylesheet } from "./stylesheet";

/**
 * The Udara button classes must be declared AFTER the legacy `.button-*` rules.
 *
 * Both systems style the same elements — a control opts into the design system
 * by carrying `btn btn-sm` alongside its existing `button-primary` — and the two
 * selectors have equal specificity. Source order is therefore the only thing
 * deciding which padding and font-size win, and if the Udara block drifts back
 * above the legacy one, every `btn-sm` in the app silently stops doing anything.
 *
 * That is not hypothetical: it shipped exactly that way once, and no test in
 * this project could see it. `bun test` asserts behaviour and reads the sheet as
 * text; nothing computes style.
 *
 * This compares the WHOLE families, not one selector from each side — a
 * narrower check (say, just `.btn-sm` against the first `.button-*`) is blind
 * to a partial split: someone could move `.btn-ghost` back above the legacy
 * group while leaving `.btn-sm` where it is, and `.btn-ghost` would go inert
 * exactly as before while a single-pair check kept reporting `ordered=true`.
 */

/** Indices of every rule whose selector group contains a match. */
function indicesOf(predicate: (selector: string) => boolean): number[] {
  const found: number[] = [];
  rules(stylesheet()).forEach((rule, index) => {
    if (rule.selector.split(",").map((s) => s.trim()).some(predicate)) found.push(index);
  });
  return found;
}

describe("stylesheet cascade order", () => {
  it("declares every Udara button class after every legacy .button-* rule", () => {
    // `.btn`, `.btn:active`, `.btn-sm`, `.btn-ghost:hover`, … but never
    // `.button-primary` — that starts ".bu", not ".btn".
    const udara = indicesOf((selector) => /^\.btn(\b|-)/.test(selector));
    const legacy = indicesOf((selector) => /^\.button-/.test(selector));

    // Not decoration: with either list empty, Math.min/max return Infinity and
    // the assertion below passes vacuously — on exactly the regression this
    // test exists to catch.
    expect(udara.length >= 8 && legacy.length >= 4).toBe(true);

    const lastLegacy = Math.max(...legacy);
    const firstUdara = Math.min(...udara);

    // Named, not counted: a failure should say which way round they ended up.
    expect(`lastLegacy@${lastLegacy} firstUdara@${firstUdara} ordered=${firstUdara > lastLegacy}`)
      .toContain("ordered=true");
  });
});
