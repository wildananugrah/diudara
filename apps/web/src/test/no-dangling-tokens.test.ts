import { describe, expect, it } from "bun:test";
import { rules, stylesheet } from "./stylesheet";

/**
 * A `var(--x)` naming a property nothing declares does not fall back or warn —
 * it makes the WHOLE declaration invalid at computed-value time, and the rule
 * simply does not paint. Nothing in a text-matching test suite can see that:
 * during Phase 0, `--green-dark` was removed from `:root` while the active feed
 * tab still referenced it, and the suite stayed green for five tasks with the
 * tab indicator dead in every browser.
 *
 * Declarations are collected from the whole sheet rather than from `:root`
 * alone, so a property legitimately scoped to a component (`.foo { --bar: … }`)
 * counts as declared. The check is only "is it declared anywhere", which is the
 * one thing that separates a working `var()` from a silently dead one.
 */
describe("custom properties", () => {
  it("leaves no var(--x) referring to a property nothing declares", () => {
    const css = stylesheet();
    const declared = new Set(
      [...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!)
    );
    const referenced = new Set(
      [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!)
    );

    // Named, not counted: a failure must say WHICH property is dangling.
    const dangling = [...referenced].filter((name) => !declared.has(name)).sort();
    expect(dangling.join(" | ")).toBe("");
  });

  it("actually inspects the sheet — a vacuous pass here would hide every dangling token", () => {
    const css = stylesheet();
    expect([...css.matchAll(/var\(\s*(--[\w-]+)/g)].length > 50).toBe(true);
    expect(rules(css).some((rule) => rule.selector === ":root")).toBe(true);
  });
});
