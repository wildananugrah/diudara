import { describe, expect, it } from "bun:test";
import { rules, selectors, stylesheet } from "./stylesheet";

/**
 * A colour written as a literal outside `:root` does not follow a palette
 * swap. Phase 0's whole method is "re-point the tokens and 1,711 lines
 * re-tint for free", and every literal below that line is a hole in it —
 * the input borders stayed slate-blue while everything around them moved
 * to Udara, which is exactly the sort of half-migrated sheet this catches.
 *
 * `:root` is exempt because that is where literals belong. `transparent`,
 * `inherit`, `currentColor` and `none` are not colours in this sense.
 *
 * `@keyframes` steps are exempt too. `rules()` matches innermost braces, so
 * each `0%`/`70%`/`100%` step is returned as its own rule, and the pulse
 * animation's spreading `rgba(255,255,255,…)` glow is an animation parameter
 * rather than a palette colour — expressing it as a `color-mix` on --surface
 * would obscure what the rule does without making it themeable.
 */
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i;
/** A keyframe step selector: `0%`, `70%`, `from`, `to`, or a comma-separated list. */
const KEYFRAME_STEP = /^(?:from|to|-?\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|-?\d+(?:\.\d+)?%))*$/;

describe("no hardcoded colours outside :root", () => {
  it("declares every colour as a token", () => {
    const offenders = rules(stylesheet())
      .filter((rule) => rule.selector !== ":root")
      .filter((rule) => !KEYFRAME_STEP.test(rule.selector))
      .filter((rule) => LITERAL.test(rule.body));

    // Named, not counted: a failure must say WHICH rule reintroduced a literal.
    expect(selectors(offenders)).toBe("");
  });
});
