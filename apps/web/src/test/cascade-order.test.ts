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
 */
function firstIndexOf(predicate: (selector: string) => boolean): number {
  return rules(stylesheet()).findIndex((rule) =>
    rule.selector.split(",").map((s) => s.trim()).some(predicate)
  );
}

describe("stylesheet cascade order", () => {
  it("declares the Udara button classes after the legacy .button-* rules", () => {
    const legacy = firstIndexOf((s) => /^\.button-[a-z]+$/.test(s));
    const udara = firstIndexOf((s) => s === ".btn-sm");

    expect(legacy >= 0 && udara >= 0).toBe(true);
    // Named, not counted: a failure should say which way round they are.
    expect(`legacy@${legacy} udara@${udara} ordered=${udara > legacy}`).toContain("ordered=true");
  });
});
