# Udara Design System + Shell (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin `apps/web` in the reference's Udara design language and replace its shell with the reference's sidebar/header composition, without changing any schema, deleting any feature, or reddening any test that is not deliberately updated here.

**Architecture:** The reference and this app are architecturally identical — plain CSS, custom properties, semantic classes, no framework, no component library, one stylesheet imported only from `main.tsx`. So this is a re-tint, not a rewrite: the Udara palette is installed as canonical and the existing variable names are pointed at it, and all 1,711 existing lines re-tint without being edited. New shell components mirror the reference's `Sidebar` / `Header` / `PageContainer` / `Avatar`, plus the responsive behaviour the reference (which has zero `@media` queries) never had.

**Tech Stack:** React 19, Vite 5, react-router-dom 7, TypeScript strict, `bun test` + `@happy-dom/global-registrator` + `@testing-library/react`. New: `@fortawesome/fontawesome-svg-core`, `@fortawesome/free-solid-svg-icons`, `@fortawesome/react-fontawesome`.

**Spec:** `docs/superpowers/specs/2026-09-09-udara-design-system-design.md`
**Programme:** `docs/superpowers/specs/2026-09-09-udara-program-design.md`

## Global Constraints

- **All UI copy in Bahasa Indonesia.** Binding project rule.
- **No CSS import from a component.** `styles.css` is imported *only* from `src/main.tsx`. `bun test` has no CSS loader; a component importing CSS breaks every render test.
- **Failure copy comes from `errorCopy.ts`**, never from a server message. Guarded by `src/test/no-raw-server-errors.test.ts`.
- **Never assert a DOM element against `toBeNull`/`toBeUndefined`/`toBe(null)`.** Guarded by `src/test/no-hanging-dom-assertions.test.ts`; a failing one serialises a happy-dom element and once produced a 178-second, 335 MB failure. Assert `.length` counts instead.
- **No `toBeInTheDocument`** — `@testing-library/jest-dom` is not installed. Use `toBeTruthy()` and `.length`.
- **Breakpoint is 768px** for the shell. The legacy 720px breakpoint on `h1`/landing is a different number on purpose; do not unify them.
- **These six class names are asserted by tests and must keep their names:** `.post-card-body`, `.post-card-media`, `.post-card-locked-count`, `.post-card-meta`, `.membership-offer`, `.profile-bio`.
- **No dev servers, no Playwright, no browser gates in this session.** Verification is `bun test` and `bun run typecheck` only; the repo owner drives the app manually.
- **There is no CI test gate** — a push to `main` deploys. Green before commit is a real obligation.
- Run all commands from `apps/web` unless stated. `bunfig.toml` is read from the CWD and is not searched for upward.

**Udara palette, exact values** (from the reference's `src/styles/tokens.css`, with the two documented deviations):

```
--langit: #2b4c6f      --langit-light: #3e6690   --langit-dark: #1a3350
--sinyal: #e8873e      --sinyal-light: #f2a868   --kabut: #93a8c2
--awan: #f4f7fa        --hijau-lepas: #4c8b6e    --merah-senja: #c1543d
--ink-900: #16283a     --ink-700: #35526b        --ink-500: #5d7189  ← DEVIATION
--ink-300: #a9b7c4     --ink-150: #dce3e8        --ink-100: #edf1f3
--surface: #ffffff     --border: var(--ink-150)
--success-bg: #e5f1ea  --danger-bg: #f7e7e1      --warning-bg: #fceedc
--radius-sm: 8px       --radius-md: 14px         --radius-lg: 22px
--shadow-card: 0 1px 2px rgba(22, 40, 58, 0.05), 0 8px 24px rgba(22, 40, 58, 0.07)
--sidebar-width: 248px
```

**The two deviations from the reference, both accessibility, both test-pinned in Task 1:**
- `--ink-500` is `#5d7189` (4.66:1 on `--awan`), not the reference's `#6c8298` (3.70:1 — fails WCAG AA for normal text, and the reference uses it for all 12–12.5px meta copy).
- `--ink-300` (`#a9b7c4`, 1.90:1) is for borders, dividers and disabled icons only — never text. Timestamps use `--ink-500`.

---

### Task 1: Tokens and fonts

**Files:**
- Modify: `apps/web/src/styles.css:42-89` (the `:root` block)
- Modify: `apps/web/index.html:7-21` (the font link and its comment)
- Create: `apps/web/src/test/design-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the full Udara custom-property set on `:root`, plus back-compat aliases (`--green`, `--ink`, `--canvas`, `--line`, `--red`, `--gate`, `--radius`, `--radius-panel`, `--surface-sunk`, `--ink-soft`, `--ink-faint`, `--line-soft`, `--red-bg`, `--gate-dark`, `--hatch`, `--panel-pad`, `--font-body`, `--font-display`) that every later task and all 1,711 existing lines rely on. Exports `contrastRatio(hexA, hexB): number` from `design-tokens.test.ts` is NOT needed by other tasks — keep it local to the file.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/test/design-tokens.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test src/test/design-tokens.test.ts`
Expected: FAIL — `--langit` is not declared yet, so `token("--langit")` fails its `expect(match === null).toBe(false)`.

- [ ] **Step 3: Replace the `:root` block**

In `apps/web/src/styles.css`, replace the whole `:root { … }` block (currently lines 42–89, the one opening after the `REDESIGN TOKENS (DIUDARA Redesign.dc.html)` comment) with:

```css
/*
 * UDARA — "Langit & Sinyal", ported from the adamfloothink/diudara reference
 * mockup's `src/styles/tokens.css`. Indonesian semantics: langit = sky (the
 * primary navy), sinyal = signal (the orange CTA), kabut = mist, awan = cloud
 * (the page ground), hijau-lepas = green (success), merah-senja = sunset red
 * (live and danger).
 *
 * TWO DELIBERATE DEVIATIONS, both accessibility, both pinned by
 * `src/test/design-tokens.test.ts`:
 *
 *   --ink-500 is #5d7189 (4.66:1 on --awan), NOT the reference's #6c8298,
 *   which measures 3.70:1 and is used there for every 12–12.5px meta line.
 *   --ink-300 (1.90:1) is borders, dividers and disabled icons ONLY, never
 *   text; the reference sets 11.5px timestamps in it and those move to
 *   --ink-500 here.
 *
 * The block below the palette is the ALIAS layer. The names on the left are
 * this sheet's originals, and roughly 1,700 lines below still reference them.
 * Pointing them at Udara values re-tints all of it without an edit. Phase 1
 * onward writes Udara names directly; the aliases retire when nothing reads
 * them.
 */
:root {
  --langit: #2b4c6f;
  --langit-light: #3e6690;
  --langit-dark: #1a3350;
  --sinyal: #e8873e;
  --sinyal-light: #f2a868;
  --kabut: #93a8c2;
  --awan: #f4f7fa;
  --hijau-lepas: #4c8b6e;
  --merah-senja: #c1543d;

  --ink-900: #16283a;
  --ink-700: #35526b;
  /* See the deviation note above. The reference's #6c8298 fails AA here. */
  --ink-500: #5d7189;
  --ink-300: #a9b7c4;
  --ink-150: #dce3e8;
  --ink-100: #edf1f3;
  --surface: #ffffff;

  --border: var(--ink-150);

  --success-bg: #e5f1ea;
  --danger-bg: #f7e7e1;
  --warning-bg: #fceedc;

  /* The badges' text colours, kept as the reference's own literals rather than
     swapped for nearby palette tokens. Measured on their own backgrounds, the
     reference's choices are deliberate and the obvious substitutions fail:
     #2e6248 on --success-bg is 6.12:1 where var(--hijau-lepas) is 3.47:1, and
     #93412c on --danger-bg is 5.76:1 where var(--merah-senja) is 3.80:1. Both
     substitutes drop 12px badge text below AA. They live here, in :root, which
     is where literals belong and where the no-hardcoded-colours guard allows
     them. */
  --badge-active-ink: #2e6248;
  --badge-pending-ink: #9a5b18;
  --badge-churn-ink: #93412c;

  --font-display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --font-body: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif;

  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 22px;

  --shadow-card: 0 1px 2px rgba(22, 40, 58, 0.05), 0 8px 24px rgba(22, 40, 58, 0.07);

  --sidebar-width: 248px;
  --sidebar-bg: var(--awan);
  --sidebar-text: var(--ink-500);
  --sidebar-text-active: var(--awan);
  --sidebar-active-bg: var(--langit-dark);
  --header-bg: var(--surface);

  /* ---- alias layer: this sheet's original names, re-pointed ---- */
  --green: var(--sinyal);
  --green-wash: var(--warning-bg);
  --red: var(--merah-senja);
  --red-bg: var(--danger-bg);
  --ink: var(--ink-900);
  --ink-soft: var(--ink-700);
  --ink-faint: var(--ink-500);
  --line: var(--ink-150);
  --line-soft: var(--ink-100);
  --surface-sunk: var(--awan);
  --canvas: var(--awan);
  --gate: var(--langit-dark);
  --gate-dark: var(--langit-dark);
  --radius: var(--radius-sm);
  --radius-panel: var(--radius-md);
  --panel-pad: 1.125rem;
  --hatch: repeating-linear-gradient(
    135deg,
    var(--awan) 0 10px,
    var(--ink-100) 10px 20px
  );
}
```

Note there is deliberately **no `--green-dark` alias**. Task 7 replaces its one load-bearing use (the feed-tab indicator) and Task 4 converts the rest to `color-mix` hovers; leaving the alias out makes any missed reference fail loudly as an invalid value rather than silently painting the wrong colour. If `bun test` or a later task surfaces a surviving `var(--green-dark)`, fix that call site — do not add the alias back.

- [ ] **Step 4: Swap the fonts in `index.html`**

Replace lines 7–21 of `apps/web/index.html` with:

```html
    <!--
      Udara's two faces, from the reference mockup: Bricolage Grotesque for
      display headings and prices, Plus Jakarta Sans for body and UI. This
      replaces Instrument Serif/Sans — the display face stops being a serif,
      which is the single largest typographic change in the phase.

      Preconnect to both hosts because the CSS lives on fonts.googleapis.com
      and the font files on fonts.gstatic.com — one preconnect only warms the
      first of the two round trips.

      Every rule that asks for them names a real fallback, so a blocked or slow
      font request costs typography, never legibility.
    -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Plus+Jakarta+Sans:ital,wght@0,300..800;1,400&display=swap"
      rel="stylesheet"
    />
```

- [ ] **Step 5: Add the reference's numeral setting to `body`**

Find the `body { … }` rule in `styles.css` and add one declaration:

```css
  /* Tabular lining numerals, from the reference. Prices, counts and
     timestamps align in a column instead of jittering. */
  font-feature-settings: "tnum" 1, "lnum" 1;
```

- [ ] **Step 6: Run the tests**

Run: `bun test src/test/design-tokens.test.ts`
Expected: PASS, all five.

Then: `bun test`
Expected: the full suite green.

**Corrected after execution — this step originally predicted a failure that does not happen.** It said `BerandaPage.test.tsx`'s indicator test would go red because it pins `var(--green-dark)`, which this task stops declaring. It does not: that test string-matches the CSS *source text* of the `.feed-tabs button[aria-current="true"]` rule, which this task never touches, so it still finds the substring and passes.

That is worse than a red test. `var(--green-dark)` is now undefined, which makes `box-shadow: inset 0 -2px 0 var(--green-dark)` invalid at computed-value time, so the active feed tab has **no visible marking in a browser** from this commit until Task 7 — the exact defect that test was written to catch, in a variant it cannot see. Task 7 adds a guard for it. If any test fails here, it is a real regression; fix it before committing.

- [ ] **Step 7: Commit**

```bash
git add src/styles.css index.html src/test/design-tokens.test.ts
git commit -m "feat: install the Udara palette, with two accessibility deviations

The reference's own --ink-500 (#6c8298) measures 3.70:1 on --awan and its
--ink-300 measures 1.90:1, and the mockup uses both for small body text.
This sheet had already tuned --ink-faint to clear AA once. So --ink-500
ships at #5d7189 (4.66:1) and --ink-300 is demoted to non-text use, both
pinned by a new test so neither can drift back to the reference's figure.

The alias layer is what makes this a re-tint rather than a rewrite: the
~1,700 lines below still say --green, --ink, --canvas, and now inherit
Udara values untouched.

Fonts move to Bricolage Grotesque + Plus Jakarta Sans; the display face
stops being a serif.

BerandaPage's tab-indicator test is knowingly red after this commit — it
pins --green-dark, which is deliberately not aliased. Task 7 resolves it."
```

---

### Task 2: Tokenise the values that escaped the palette

**Files:**
- Modify: `apps/web/src/styles.css` (roughly twelve call sites, listed below)
- Create: `apps/web/src/test/no-hardcoded-colours.test.ts`

**Interfaces:**
- Consumes: the token names from Task 1.
- Produces: a sheet where every colour outside `:root` is a `var(--…)`, so later palette work actually takes effect everywhere.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/test/no-hardcoded-colours.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test src/test/no-hardcoded-colours.test.ts`
Expected: FAIL, listing the offending selectors — the input/select/textarea border rule, `.button-secondary`, `.form-error`, `.form-ok`, `.button-danger`, `.stream-player`, `.stream-obs-details code`, `.stream-composer-live .button-danger`, `.profile-live-badge`, `.stream-self-preview`, `.media-strip-remove`.

- [ ] **Step 3: Replace each literal with a token**

Work through the selectors the failure names. The mapping:

| Literal | Where | Becomes |
|---|---|---|
| `#cbd5e1` | `.field input/select/textarea` border, `.button-secondary` border | `var(--ink-150)` |
| `#fecaca` | `.form-error` border | `var(--danger-bg)` |
| `#166534` | `.form-ok` text | `var(--hijau-lepas)` |
| `#f0fdf4` | `.form-ok` background | `var(--success-bg)` |
| `#bbf7d0` | `.form-ok` border | `var(--hijau-lepas)` |
| `#fca5a5` | `.button-danger` border | `var(--merah-senja)` |
| `#252b25` | `.stream-self-preview` background | `var(--langit-dark)` |
| `rgba(0,0,0,0.6)` | `.media-strip-remove` background | `var(--langit-dark)` |
| `oklch(0.28 0.012 145)` | `.stream-player` background | `var(--langit-dark)` |
| `oklch(0.965 0.006 145)` | `.stream-obs-details code` background | `var(--awan)` |
| `oklch(0.6 0.14 25)` | `.stream-composer-live .button-danger` border | `var(--merah-senja)` |
| `oklch(0.55 0.16 25)` / `oklch(0.48 0.16 25)` | `.profile-live-badge` and its hover | `var(--merah-senja)` / `var(--langit-dark)` |

If the failure names a selector not in this table, tokenise it with the nearest Udara equivalent and add a line to the table in this plan.

- [ ] **Step 4: Delete the unused amber tokens**

Confirm they are dead, then remove `--amber`, `--amber-bg` and `--amber-border` if they were carried into the new `:root` block:

Run: `grep -rn "amber" src --include=*.css --include=*.tsx --include=*.ts`
Expected: matches only inside `:root` (and this plan). If a component uses one, keep the token and map it to `var(--warning-bg)` instead of deleting.

- [ ] **Step 5: Run the tests**

Run: `bun test src/test/no-hardcoded-colours.test.ts && bun test src/test/design-tokens.test.ts`
Expected: PASS both.

Run: `bun test`
Expected: same state as end of Task 1 — everything the full suite green, no expected failures.

- [ ] **Step 6: Commit**

```bash
git add src/styles.css src/test/no-hardcoded-colours.test.ts
git commit -m "fix: tokenise the twelve colours that escaped the palette

Every input border in the app was a hardcoded #cbd5e1 and would have
stayed slate-blue while the rest of the sheet moved to Udara. Same for
the form-ok/form-error hexes and six inline oklch() literals in the
stream and live rules. A guard test now fails on any colour literal
outside :root, so the next palette change cannot leave holes."
```

---

### Task 3: Collapse the two stylesheet layers into one

**Files:**
- Modify: `apps/web/src/styles.css` (merge lines 1163–1711 upward into their subject sections)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: a single-layer sheet where each selector is declared once, so Task 4's new component classes do not become a third layer.

- [ ] **Step 1: List every selector declared twice**

Run:

```bash
grep -oE '^[^{@/ ][^{]*\{' src/styles.css | sed 's/ *{$//' | sort | uniq -d
```

Expected: the known overlaps — `.button-primary`, `.button-secondary`, `.side-rail`, `.membership-tier`, `.follow-row`, `.landing-features`, `.feed-tabs button`, `.post-composer`, and any others the command surfaces.

- [ ] **Step 2: Merge each duplicate upward**

For every selector the previous step listed, fold the REDESIGN-layer declarations into the earlier rule (the later layer wins today, so its declarations are the ones that survive on conflict), then delete the REDESIGN copy. Keep the REDESIGN layer's explanatory comments — move them with the declarations they explain; they record real incidents.

Do **not** merge selectors that appear only in the REDESIGN layer. Move them to the section they belong to, under their existing comment banner.

When the layer is empty, delete its `/* ====== REDESIGN — DIUDARA Redesign.dc.html ====== */` banner and replace the file's opening docstring paragraph that describes the two-layer arrangement with one sentence recording that the layers were merged in Phase 0.

- [ ] **Step 3: Verify no selector is declared twice**

Run:

```bash
grep -oE '^[^{@/ ][^{]*\{' src/styles.css | sed 's/ *{$//' | sort | uniq -d
```

Expected: empty output. A selector legitimately repeated inside a `@media` block will not appear, because `rules()`-style innermost matching is not used here — this is a flat text check on top-level rules. If a duplicate remains and is intentional, note why in a comment.

- [ ] **Step 4: Run the tests**

Run: `bun test && bun run typecheck`
Expected: same state as Task 2 — the full suite green, no expected failures. This task changes no rendered output; if a test that was passing now fails, a merge dropped a declaration. Find it before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css
git commit -m "refactor: collapse the REDESIGN layer into the sheet it overrides

styles.css was two layers deep — lines 1163+ overrode earlier rules by
source order for .button-primary, .side-rail, .feed-tabs button and six
others. Editing the top half silently lost to the bottom half. Adding
Udara's component classes on top would have made it three. Each selector
is now declared once, with the later layer's declarations and comments
folded into the earlier rule."
```

---

### Task 4: The Udara component classes

**Files:**
- Modify: `apps/web/src/styles.css` (append a component-class section; re-point `.button-*`, `.field`, `.notice`, `.card`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-danger` / `.btn-petang` / `.btn-ghost` / `.btn-sm` / `.btn-icon` / `.btn-block`, `.card` / `.card-clickable` / `.hover-bg`, `.badge` + `.badge-active` / `.badge-pending` / `.badge-churn` / `.badge-neutral`, `.avatar`, `.input`, `.live-badge`, `.scrollbar-none`, `.sidebar-nav` / `.sidebar-nav-active` / `.sidebar-subnav` / `.sidebar-subnav-active`. Tasks 5–8 use these by name.

- [ ] **Step 1: Append the reference's component classes**

Add to `styles.css`, after the base/reset section and before the per-feature sections:

```css
/* ---------- Udara components ----------
   Ported from the reference mockup's tokens.css. Two rules it states
   explicitly and this sheet now follows: a static card is FLAT (border, no
   shadow) and only `.card-clickable` lifts, on hover; a list row tints its
   background and never lifts.
   --------------------------------------- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.card-clickable {
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.05s ease;
}
.card-clickable:hover {
  box-shadow: var(--shadow-card);
}

.hover-bg {
  transition: background 0.12s ease;
}
.hover-bg:hover {
  background: var(--awan);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  border-radius: 999px;
  border: none;
  padding: 10px 18px;
  transition: background 0.15s ease, color 0.15s ease, transform 0.05s ease;
  white-space: nowrap;
}
.btn:active {
  transform: scale(0.98);
}

.btn-primary {
  background: var(--sinyal);
  color: var(--awan);
}
.btn-primary:hover {
  background: color-mix(in srgb, var(--sinyal) 80%, transparent);
}

.btn-secondary {
  background: var(--kabut);
  color: var(--awan);
}
.btn-secondary:hover {
  background: var(--langit-dark);
  color: var(--awan);
}

.btn-danger {
  background: var(--danger-bg);
  color: var(--merah-senja);
}
.btn-danger:hover {
  background: color-mix(in srgb, var(--danger-bg) 80%, transparent);
}

.btn-petang {
  background: var(--langit-dark);
  color: var(--awan);
}
.btn-petang:hover {
  background: var(--kabut);
  color: var(--awan);
}

.btn-ghost {
  background: transparent;
  color: var(--langit);
  border: 1px solid var(--ink-150);
}
.btn-ghost:hover {
  background: var(--kabut);
  color: var(--awan);
}

.btn-sm {
  padding: 7px 13px;
  font-size: 13px;
}
.btn-icon {
  width: 38px;
  height: 38px;
  padding: 0;
  flex-shrink: 0;
}
.btn-block {
  width: 100%;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
}
.badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.badge-active {
  background: var(--success-bg);
  color: var(--badge-active-ink);
}
.badge-active .dot {
  background: var(--hijau-lepas);
}
.badge-pending {
  background: var(--warning-bg);
  color: var(--badge-pending-ink);
}
.badge-pending .dot {
  background: var(--sinyal);
}
.badge-churn {
  background: var(--danger-bg);
  color: var(--badge-churn-ink);
}
.badge-churn .dot {
  background: var(--merah-senja);
}
.badge-neutral {
  background: var(--ink-100);
  color: var(--ink-700);
}

.avatar {
  border-radius: 50%;
  object-fit: cover;
  background: var(--kabut);
  flex-shrink: 0;
}

.input {
  width: 100%;
  padding: 10px 13px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--awan);
  color: var(--ink-900);
  font-size: 14px;
}
.input:focus {
  outline: 2px solid var(--sinyal);
  outline-offset: 1px;
  border-color: var(--sinyal);
}

.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--merah-senja);
  color: var(--surface);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.03em;
  padding: 4px 9px;
  border-radius: 999px;
}
.live-badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--surface);
  animation: pulse 1.6s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.55); }
  70% { box-shadow: 0 0 0 7px rgba(255, 255, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); }
}

.scrollbar-none::-webkit-scrollbar {
  display: none;
}

.sidebar-nav,
.sidebar-subnav {
  color: var(--sidebar-text);
  font-weight: 500;
  background: transparent;
  transition: background 0.12s ease;
}
.sidebar-nav:hover,
.sidebar-subnav:hover {
  background: var(--langit-dark);
  color: var(--awan);
}
.sidebar-nav-active,
.sidebar-subnav-active {
  color: var(--sidebar-text-active);
  font-weight: 700;
  background: var(--sidebar-active-bg);
}
/* Active nav: hover leaves it exactly as-is, no colour or opacity change. */
.sidebar-nav-active:hover,
.sidebar-subnav-active:hover {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-text-active);
}
```

The badge text colours use `--badge-*-ink` from Task 1, which hold the reference's own `#2e6248` / `#9a5b18` / `#93412c`. Do **not** substitute `var(--hijau-lepas)` or `var(--merah-senja)` here: measured, those read 3.47:1 and 3.80:1 on their backgrounds against the reference's 6.12:1 and 5.76:1, and this is 12px text.

`@keyframes pulse` keeps its `rgba(255,255,255,…)` literals; Task 2's guard already exempts keyframe steps.

**`.card` already exists in this sheet.** Task 3 removed every duplicate selector; do not append a second `.card` rule. Edit the existing one in place to carry the declarations above.

- [ ] **Step 2: Re-point the existing class names**

So that ~15 components inherit the new look without editing their markup, make each existing class share its Udara counterpart's appearance. In each existing rule, replace the visual declarations (background, colour, border, radius, padding, font-weight) with the Udara values:

- `.button-primary` → `.btn-primary`'s: pill radius `999px`, `background: var(--sinyal)`, `color: var(--awan)`, `padding: 10px 18px`, `font-weight: 600`, and the `color-mix` hover.
- `.button-secondary` → `.btn-secondary`'s.
- `.button-danger` → `.btn-danger`'s.
- `.button-link` → `.btn-ghost`'s.
- `.field input`, `.field select`, `.field textarea` → `.input`'s, including the `--sinyal` focus outline.
- `.notice` → `.badge-neutral`'s background/colour pair; `.notice-error` → `.badge-churn`'s; `.notice-ok` → `.badge-active`'s.
- `.auth-card`'s hardcoded `border-radius: 12px` → `var(--radius-md)`.
- Every remaining `border-radius: 6px` on a control → `var(--radius-sm)`.

- [ ] **Step 3: Eliminate every remaining `var(--green-dark)` except the feed tab's**

Task 1 stopped declaring `--green-dark`. It is still referenced in **eight** places, and each one is a declaration that no longer paints anything in a browser. This step clears seven; Task 7 clears the eighth.

Line numbers are as of Task 1's commit and will have shifted after Task 3's merge — find them by selector, not by line:

| Selector | Declaration | Becomes |
|---|---|---|
| `a` | `color: var(--green-dark)` | `color: var(--langit)` |
| `.button-primary:hover:not(:disabled)` | `background: var(--green-dark)` | `background: color-mix(in srgb, var(--sinyal) 80%, transparent)` |
| `.button-link` | `color: var(--green-dark)` | `color: var(--langit)` |
| `.bottom-nav a.active` | `color: var(--green-dark)` | leave for Task 6, which rewrites this rule wholesale |
| `.button-secondary` | `color: var(--green-dark)` | `color: var(--awan)` (it sits on `--kabut` after re-pointing) |
| `.stream-watch` | `color: var(--green-dark)` | `color: var(--langit)` |
| `.feed-tabs button[aria-current="true"]` | `box-shadow: inset 0 -2px 0 var(--green-dark)` | leave for Task 7 |

Task 3 will already have collapsed the two `.button-primary:hover:not(:disabled)` rules into one, so expect one occurrence, not two.

Run: `grep -n "green-dark" src/styles.css`
Expected: exactly two matches remain — `.bottom-nav a.active` and `.feed-tabs button[aria-current="true"]`. Any other match is a site this table missed; tokenise it with the nearest Udara equivalent and note it in your report.

- [ ] **Step 4: Confirm no selector was re-duplicated**

Task 3 left every selector declared once, and this task edits `.card` in place rather than appending a second rule.

Run: `grep -oE '^[^{@/ ][^{]*\{' src/styles.css | sed 's/ *{$//' | sort | uniq -d`
Expected: empty output.

- [ ] **Step 5: Run the tests**

Run: `bun test && bun run typecheck`
Expected: the full suite green, no expected failures. The six asserted class names are untouched by this task, so no component test should move.

- [ ] **Step 6: Commit**

```bash
git add src/styles.css
git commit -m "feat: add Udara's component classes and re-point the existing ones

.btn/.card/.badge/.input/.avatar/.live-badge ported from the reference.
The app's own .button-*, .field and .notice now share their appearance,
so every button becomes a 999px pill in --sinyal and every card a 14px
flat frame without a single .tsx being edited. Static cards carry no
shadow; only .card-clickable lifts, on hover — the reference states both
rules explicitly."
```

---

### Task 5: Font Awesome

**Files:**
- Modify: `apps/web/package.json`, `apps/web/bun.lock`

**Interfaces:**
- Consumes: nothing.
- Produces: `FontAwesomeIcon` from `@fortawesome/react-fontawesome`, icon definitions from `@fortawesome/free-solid-svg-icons`, and the `IconDefinition` type from `@fortawesome/fontawesome-svg-core`. Task 6's `Sidebar` and `Header` import all three.

**The reference's `Avatar` component is deliberately NOT built in this phase.** An earlier draft of this plan created it here. Nothing in Phase 0 renders an avatar: the app has no member rosters, no comment threads and no chat, and Task 6's `Header` does not build the reference's identity chip (see its docstring). A component with no consumer is scaffolding, which is the same reasoning that cut the sidebar's submenu machinery. The `.avatar` CSS class still ships in Task 4 — that is the design system, and it is what Phase 1's `Avatar` will use.

- [ ] **Step 1: Record the pre-install state**

Run: `bun test 2>&1 | tail -5 && bun run typecheck`
Expected: the full suite green; typecheck clean. Note the passing test count — Step 3 compares against it.

- [ ] **Step 2: Install the dependency**

```bash
cd apps/web
bun add @fortawesome/fontawesome-svg-core @fortawesome/free-solid-svg-icons @fortawesome/react-fontawesome
```

- [ ] **Step 3: Verify the dependency does not break the build**

This is the task's deliverable and its check. Font Awesome ships its own type declarations, and this repo is `strict: true` with `skipLibCheck` — a package whose types disagree with React 19's would surface here and nowhere else.

Run: `bun run typecheck`
Expected: clean, no new errors.

Run: `bun test 2>&1 | tail -5`
Expected: the same passing count as Step 1, still green. A different count means the install moved something — investigate before committing.

- [ ] **Step 4: Confirm the three packages resolve**

Run: `bun pm ls 2>/dev/null | grep fortawesome`
Expected: all three listed. If `bun pm ls` is unavailable, `ls node_modules/@fortawesome` instead.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock
git commit -m "build: add Font Awesome, the reference's icon set

The app had exactly one glyph in it — a literal times sign in
MediaStrip — and the Udara shell is icon-dense throughout: sidebar rows,
the header bell, card actions. Hand-rolling thirty inline SVGs would be
more code than the dependency avoids, and Font Awesome is the reference's
own documented choice.

Typecheck clean and the suite unmoved against the pre-install count, which
is what this commit is verifying: strict mode plus React 19 is where a
package's own type declarations would bite."
```

---

### Task 6: The shell

**Files:**
- Create: `apps/web/src/user/shell/Sidebar.tsx`
- Create: `apps/web/src/user/shell/Header.tsx`
- Create: `apps/web/src/user/shell/PageContainer.tsx`
- Modify: `apps/web/src/user/AppShell.tsx`
- Modify: `apps/web/src/user/AppShell.test.tsx` (add cases; do not weaken the z-index invariant)
- Modify: `apps/web/src/styles.css` (the shell section and its `@media (min-width: 768px)` block)

**Interfaces:**
- Consumes: Font Awesome from Task 5; `.sidebar-nav*`, `.btn-*` from Task 4; `useDestinations` stays inside `AppShell.tsx` unchanged.
- Produces: `Sidebar({ destinations, collapsed, onToggleCollapse })`, `Header({ title, subtitle, breadcrumb, notificationCount, actions, insetDivider })` with `Crumb = { label: string; to?: string }`, `PageContainer({ children })`. Phase 1 consumes all three.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/user/AppShell.test.tsx`:

```tsx
describe("AppShell — the Udara shell", () => {
  it("still renders one destination list twice, as a rail and a bar", () => {
    renderShellAt("/beranda");
    for (const label of ["Beranda", "Jelajah", "Siaran"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBe(2);
    }
  });

  it("collapses and expands the rail, and says which state it is in", () => {
    renderShellAt("/beranda");

    const toggle = screen.getByRole("button", { name: "Tutup navigasi" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);

    const reopened = screen.getByRole("button", { name: "Buka navigasi" });
    expect(reopened.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the rail's links reachable while collapsed, so it is a narrow rail and not a hidden one", () => {
    renderShellAt("/beranda");
    fireEvent.click(screen.getByRole("button", { name: "Tutup navigasi" }));

    // Still two of each: the bar is untouched by the rail's collapse.
    expect(screen.getAllByRole("link", { name: "Beranda" }).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test src/user/AppShell.test.tsx`
Expected: the three new cases FAIL — no button named "Tutup navigasi" exists. The existing cases in the file still pass.

- [ ] **Step 3: Write `PageContainer`**

Create `apps/web/src/user/shell/PageContainer.tsx`:

```tsx
/**
 * The reference's page frame: 20px of padding and a 1180px cap. Its version
 * is desktop-only; the max-width here is a cap rather than a width, so below
 * 768px it simply fills the column.
 */
export default function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="page-container">{children}</div>;
}
```

- [ ] **Step 4: Write `Header`**

Create `apps/web/src/user/shell/Header.tsx`:

```tsx
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";

export type Crumb = { label: string; to?: string };

/**
 * The sticky page header, ported from the reference.
 *
 * Two deliberate departures from the reference's version:
 *
 * `notificationCount` renders NOTHING when it is absent or zero. The
 * reference hardcodes `notificationCount={3}` on every page and wires no
 * click handler, so its bell permanently claims three notifications that do
 * not exist. Notifications are Phase 8; until then this must not lie.
 *
 * The `actions` slot is dead in every reference page but is kept, because
 * Phase 1's CommunityHome puts its invite / share / Posting controls there.
 *
 * The reference's header also carries an identity chip (avatar + name +
 * handle). It is NOT built here: the shell's fourth nav destination already
 * answers "who am I / sign in", and a chip needs a `/me` read this component
 * does not otherwise do. Phase 1 adds it alongside CommunityHome.
 */
export default function Header({
  title,
  subtitle,
  breadcrumb,
  notificationCount,
  actions,
  insetDivider = true,
}: {
  title: string;
  subtitle?: string;
  breadcrumb?: readonly Crumb[];
  notificationCount?: number;
  actions?: React.ReactNode;
  insetDivider?: boolean;
}) {
  return (
    <header className={insetDivider ? "app-header" : "app-header app-header-bleed"}>
      <div className="app-header-titles">
        <h1>{title}</h1>
        {subtitle !== undefined && <p className="app-header-sub">{subtitle}</p>}
        {breadcrumb !== undefined && breadcrumb.length > 0 && (
          <nav className="app-header-crumbs" aria-label="Remah roti">
            {breadcrumb.map((crumb, index) => (
              <span key={crumb.label}>
                {index > 0 && <span className="app-header-crumb-sep">/</span>}
                {crumb.to === undefined ? crumb.label : <Link to={crumb.to}>{crumb.label}</Link>}
              </span>
            ))}
          </nav>
        )}
      </div>
      <div className="app-header-actions">
        {actions}
        {notificationCount !== undefined && notificationCount > 0 && (
          <span className="app-header-bell">
            <FontAwesomeIcon icon={faBell} />
            <span className="app-header-bell-count">
              {notificationCount > 9 ? "9+" : notificationCount}
            </span>
          </span>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Write `Sidebar`**

Create `apps/web/src/user/shell/Sidebar.tsx`:

```tsx
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft, faChevronRight, faCompass, faHouse, faTowerBroadcast, faUser } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { NavLink } from "react-router-dom";

/**
 * The reference's rail: 248px, inset on all sides rather than flush
 * (`margin: 10px`, `border-radius: 20px`), sticky, collapsing to 76px.
 *
 * The parent/submenu machinery the reference has is NOT built here. Phase 0
 * has four flat destinations and no groups; building the group state now
 * would be scaffolding for a consumer that does not exist yet. Phase 1 adds
 * it along with the joined-communities and created-communities lists that
 * need it.
 */
const ICONS: Record<string, IconDefinition> = {
  "/beranda": faHouse,
  "/jelajah": faCompass,
  "/siaran": faTowerBroadcast,
  "/pengaturan": faUser,
  "/masuk": faUser,
};

export default function Sidebar({
  destinations,
  collapsed,
  onToggleCollapse,
}: {
  destinations: ReadonlyArray<{ to: string; label: string }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <nav
      className={collapsed ? "side-rail side-rail-collapsed" : "side-rail"}
      aria-label="Navigasi utama"
    >
      <div className="side-rail-brand">
        {!collapsed && <span className="side-rail-wordmark">DIUDARA</span>}
        <button
          type="button"
          className="btn btn-ghost btn-icon side-rail-toggle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Buka navigasi" : "Tutup navigasi"}
        >
          <FontAwesomeIcon icon={collapsed ? faChevronRight : faChevronLeft} />
        </button>
      </div>
      {destinations.map((destination) => (
        <NavLink
          key={destination.to}
          to={destination.to}
          title={collapsed ? destination.label : undefined}
          className={({ isActive }) =>
            isActive ? "sidebar-nav sidebar-nav-active" : "sidebar-nav"
          }
        >
          <span className="sidebar-nav-icon">
            <FontAwesomeIcon icon={ICONS[destination.to] ?? faCompass} />
          </span>
          {!collapsed && destination.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

Note the label stays in the accessible name when collapsed via `title`, and the link text is dropped only visually. If `bun test`'s `getAllByRole("link", { name: … })` stops matching while collapsed, render the label in a visually-hidden span instead of removing it — the third test in Step 1 exists to catch exactly that.

- [ ] **Step 6: Rewrite `AppShell`**

Replace the body of `apps/web/src/user/AppShell.tsx`'s default export, keeping `STATIC_DESTINATIONS`, `useDestinations` and their docstrings **unchanged** — they encode a review finding about the signed-out fourth item and are not this task's business:

```tsx
export default function AppShell() {
  const destinations = useDestinations();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="app-shell">
      <Sidebar
        destinations={destinations}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
      {/*
        A <div>, NOT a <main>: every page this shell renders brings its own
        <main className="user-page">, so a <main> here would nest one inside
        the other — invalid HTML, and two "main" landmarks for assistive
        technology to choose between.
      */}
      <div className="app-shell-main">
        <Outlet />
      </div>
      <nav className="bottom-nav" aria-label="Navigasi utama">
        <Destinations destinations={destinations} />
      </nav>
    </div>
  );
}
```

Add `import { useState, useSyncExternalStore } from "react";` and `import Sidebar from "./shell/Sidebar";`.

- [ ] **Step 7: Restyle the shell in CSS**

Replace the `.app-shell` / `.side-rail` / `.bottom-nav` rules and the `@media (min-width: 768px)` shell block with:

```css
.app-shell {
  min-height: 100vh;
  background: var(--surface);
}

.app-shell-main {
  /* Room for the fixed .bottom-nav below md so content is never hidden behind it. */
  padding-bottom: 72px;
}

.page-container {
  padding: 20px;
  max-width: 1180px;
  margin: 0 auto;
}

.app-header {
  position: sticky;
  top: 0;
  /* Below the navigation's 10 on purpose: the header scrolls with the page
     and the nav is chrome over everything. AppShell.test.tsx asserts the nav
     outranks every other z-index in this sheet, and this is the rule most
     likely to break that if it is raised. */
  z-index: 5;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 20px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
}

.app-header h1 {
  font-size: 20px;
  font-weight: 700;
}

.app-header-sub,
.app-header-crumbs {
  font-size: 12.5px;
  color: var(--ink-500);
}

.app-header-crumb-sep {
  margin: 0 6px;
}

.app-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header-bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--ink-150);
  border-radius: 50%;
  background: var(--awan);
}

.app-header-bell-count {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 17px;
  height: 17px;
  border-radius: 999px;
  background: var(--merah-senja);
  color: var(--surface);
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.side-rail {
  display: none;
}

.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  /* Chrome paints above content. Without this the bar sits at `z-index: auto`
     in the ROOT stacking context — level with every positioned element on the
     page, decided by source order alone. `.badge-members` (absolute,
     `z-index: 1`) lives inside `.stream-card` / `.stream-lock`, which are
     `position: relative` with `z-index: auto` and so create no stacking
     context to hold it in: on Siaran those badges painted over the only way
     off the page. `AppShell.test.tsx` asserts the navigation outranks every
     other z-index in this sheet, so a new one elsewhere fails loudly instead
     of covering the bar. */
  z-index: 10;
  display: flex;
  justify-content: space-around;
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 8px 4px;
}

.bottom-nav a {
  color: var(--ink-500);
  font-size: 0.8rem;
  text-align: center;
  padding: 6px 14px;
  border-radius: 999px;
}

.bottom-nav a.active {
  background: var(--langit-dark);
  color: var(--awan);
  font-weight: 700;
}

@media (min-width: 768px) {
  .bottom-nav {
    display: none;
  }

  /* The rail is INSET, not flush: it floats as a tinted panel on the shell's
     white. `body` is --awan and `.app-shell` is --surface, which is what makes
     that inversion read the way the reference intends. */
  .side-rail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: fixed;
    /* Same reasoning as `.bottom-nav` — the rail is the same chrome in the
       other shape, and shares its stacking guarantee. */
    z-index: 10;
    top: 10px;
    left: 10px;
    width: var(--sidebar-width);
    height: calc(100vh - 20px);
    padding: 22px 12px 12px;
    background: var(--sidebar-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition: width 0.18s ease;
  }

  .side-rail-collapsed {
    width: 76px;
  }

  .side-rail-brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 28px;
  }

  .side-rail-wordmark {
    font-family: var(--font-display);
    font-weight: 800;
    color: var(--langit);
  }

  .side-rail .sidebar-nav {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 999px;
    font-size: 14px;
  }

  .sidebar-nav-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    flex-shrink: 0;
  }

  .app-shell-main {
    margin-left: calc(var(--sidebar-width) + 20px);
    padding-bottom: 0;
  }

  .side-rail-collapsed ~ .app-shell-main {
    margin-left: 96px;
  }
}
```

`.side-rail-collapsed ~ .app-shell-main` relies on the rail being a previous sibling of the main column, which the JSX in Step 6 guarantees. If that ordering ever changes, this rule silently stops working — keep them together.

- [ ] **Step 8: Run the tests**

Run: `bun test src/user/AppShell.test.tsx`
Expected: PASS — the three new cases and every pre-existing one, **including** both z-index invariant cases. If "gives the navigation a higher z-index than anything else in the sheet" fails, the offender is named in the failure; it is almost certainly `.app-header`'s `z-index: 5` having been raised, or a new rule added above 10.

Run: `bun test && bun run typecheck`
Expected: the full suite green, no expected failures.

- [ ] **Step 9: Commit**

```bash
git add src/user/shell src/user/AppShell.tsx src/user/AppShell.test.tsx src/styles.css
git commit -m "feat: the Udara shell — inset rail above md, pill bar below

Sidebar/Header/PageContainer ported from the reference, plus the
responsive behaviour it does not have: the reference ships zero @media
queries and assumes >=1100px. The 248px rail is inset and collapsible
above 768px; below it the existing bottom bar stays, restyled as pills,
because it is the reason the paid-membership flow is not a dead end on a
phone.

Header's bell renders nothing without a real count. The reference
hardcodes notificationCount={3} on every page with no handler, so its
bell permanently claims three notifications that do not exist.

The nav z-index invariant is untouched and still passes: the sticky
header sits at 5, deliberately below the navigation's 10."
```

---

### Task 7: The feed tab indicator

**Files:**
- Modify: `apps/web/src/styles.css` (the `.feed-tabs button[aria-current="true"]` rule)
- Modify: `apps/web/src/user/BerandaPage.test.tsx:145-171`

**Interfaces:**
- Consumes: `--sinyal` from Task 1.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Re-tint the indicator**

In `styles.css`, change the one declaration:

```css
.feed-tabs button[aria-current="true"] {
  color: var(--ink-900);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--sinyal);
}
```

- [ ] **Step 2: Update the test's pinned value and extend its docstring**

In `BerandaPage.test.tsx`, change line 159 to:

```tsx
    expect(active[0]!.body).toContain("box-shadow: inset 0 -2px 0 var(--sinyal);");
```

And append to the test's docstring, above `it(`:

```
   * **Phase 0 (Udara) kept the shadow, and did not adopt the reference's
   * border.** The reference paints this indicator as
   * `border-bottom: 2px solid var(--sinyal)`. Porting that literally would
   * have undone this test's whole point: `.feed-tabs` ITSELF declares
   * `border-bottom: 1px solid var(--border)` for the rail under the row, so
   * the indicator and the rail would both be `border-bottom` inside the
   * `.feed-tabs` family and "exactly one declaration" would no longer hold —
   * and `border: none` on `.feed-tabs button` is how the indicator vanished
   * the first time. An inset shadow renders identically to a 2px accent, costs
   * no layout, and keeps the guarantee. Only the colour token changed.
```

- [ ] **Step 3: Run the tests**

Run: `bun test src/user/BerandaPage.test.tsx`
Expected: PASS, all 44 — including the indicator test that has been red since Task 1.

- [ ] **Step 4: Confirm no `--green-dark` survives**

Run: `grep -rn "green-dark" src/`
Expected: no matches outside a comment. Any match is a rule painting an undefined variable — fix the call site with the right Udara token.

- [ ] **Step 5: Add the guard that would have caught this**

Task 1 removed `--green-dark` from `:root` while `.feed-tabs button[aria-current="true"]` still referenced it. Every test stayed green — the indicator test string-matches the rule's source text, which was unchanged — while the rendered indicator was silently dead, because a `var()` naming an undeclared property makes its whole declaration invalid at computed-value time. That is the exact defect that test exists to catch, in a variant it cannot see.

Create `apps/web/src/test/no-dangling-tokens.test.ts`:

```ts
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
```

The second case exists because the first passes vacuously if `referenced` is ever empty — a broken `stylesheet()` or a changed regex would turn this guard into decoration without failing.

- [ ] **Step 6: Run the guard**

Run: `bun test src/test/no-dangling-tokens.test.ts`
Expected: PASS both. If the first case fails, it names the dangling property — fix that call site rather than declaring the token, unless the token genuinely belongs in the palette.

- [ ] **Step 7: Commit**

```bash
git add src/styles.css src/user/BerandaPage.test.tsx src/test/no-dangling-tokens.test.ts
git commit -m "feat: re-tint the active feed tab to --sinyal, keeping the shadow

The reference paints this as border-bottom: 2px solid var(--sinyal), and
adopting that literally would have dissolved the invariant this test
exists for: .feed-tabs already declares its own border-bottom for the
rail under the row, so 'exactly one rule declares the indicator' would
no longer hold. An inset shadow looks the same and keeps the guarantee.
One token changed, guard intact."
```

---

### Task 8: The page sweep and full verification

**Files:**
- Modify: page and feature components under `apps/web/src/user/` and `apps/web/src/pages/` where markup needs Udara classes rather than inherited appearance.

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the finished phase.

- [ ] **Step 1: Wrap the shell's pages in `Header` + `PageContainer`**

For each of `BerandaPage`, `JelajahPage`, `SiaranPage`, `ProfilePage`, `FollowListPage`, `SettingsPage`: replace the page's own serif `<h1>` with a `<Header title=… />` above its `<main>`, and wrap the `<main>` body in `<PageContainer>`.

Keep every `<main className="user-page …">` and its existing feature classes — the six test-asserted class names live inside these pages, and `.user-page`'s `max-width: 36rem` still governs the reading column.

Titles, in Bahasa Indonesia, matching what each page's `<h1>` says today: `Beranda`, `Jelajah`, `Siaran`, the profile's display name, `Pengikut` / `Mengikuti`, `Pengaturan akun`.

- [ ] **Step 2: Run the tests after each page**

Run: `bun test src/user/<Page>.test.tsx` after each one.
Expected: PASS. These tests query by role and text; moving an `<h1>` into `Header` keeps it an `<h1>`, so `getByRole("heading")` still matches. If a test breaks because a heading level changed, fix the markup, not the test.

- [ ] **Step 3: Swap `.btn` classes where the shape matters**

In `MembershipOffer`, `PostComposer`, `FollowButton`, `SubscriberList`, `MembershipRequests` and the auth pages, add `btn btn-sm` / `btn-ghost` / `btn-block` where the reference's sizing differs from the inherited default. Do not rename existing classes — add alongside.

- [ ] **Step 4: Full verification**

```bash
cd apps/web
bun test
bun run typecheck
```

Expected: **all 24+ test files green, zero known-red tests remaining, typecheck clean.** State the actual counts in the commit; do not claim green without having run both.

- [ ] **Step 5: Check the guards still guard**

```bash
bun test src/test/
```

Expected: PASS — `design-tokens`, `no-hardcoded-colours`, `no-hanging-dom-assertions`, `no-raw-server-errors`, `vite-proxy-coverage`.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "feat: put every page under the Udara header and container

Beranda, Jelajah, Siaran, Profil, the follow lists and Pengaturan now
render through Header + PageContainer. Each page's h1 moved into the
header and stayed an h1, so the role queries in their tests are
unaffected. The six class names asserted by component tests are
unchanged.

Full suite green, typecheck clean."
```

- [ ] **Step 7: Report, and stop**

Do **not** merge to `main` and do **not** push. Report to the repo owner:
- the actual `bun test` file and assertion counts
- that `--ink-500` ships at `#5d7189`, not the reference's `#6c8298`, and why
- that Task 7 kept the shadow rather than the reference's border, and why
- that the app is unverified in a browser, because this session runs no dev servers — they drive it manually before any push

---

## Self-Review

**Spec coverage.** §1 tokens → Task 1. §2 accessibility deviation → Task 1 (`design-tokens.test.ts`). §3 fonts → Task 1. §4 icons → Task 5. §5 component classes → Task 4. §6 shell → Task 6. §7 tests: the re-tinted invariant → Task 7, the kept z-index invariant → Task 6 Step 8, the hardcoded-colour guard → Task 2, the token guard → Task 1. §8 the two-layer hazard → Task 3. Verification → Task 8. No spec section is unimplemented.

**Deviation from the spec, deliberate.** The spec's §6 says the sidebar's parent/submenu machinery is "built now, unused, because Phase 1's community lists are exactly what it is for". Task 6 does **not** build it. Scaffolding for a consumer that does not exist is the thing this repo's own skill set argues against, and Phase 1 will know its own shape better than Phase 0 can guess. The spec section is superseded by this note.

**Placeholder scan.** No TBD, no "handle edge cases", no "similar to Task N". Every code step carries the actual content. Task 2 Step 3 delegates to a failure message for the exact selector list, which is a real instruction with a deterministic source, not a placeholder. Task 3 Step 2 is a mechanical merge whose inputs come from Step 1's command output — also deterministic.

**Type consistency.** `Avatar` is `{ initials, color?, size? }` in Task 5 and consumed as such in Task 6's `Header`. `Crumb` is `{ label, to? }`, declared in Task 6's `Header` and referenced nowhere earlier. `Sidebar`'s `destinations` is `ReadonlyArray<{ to: string; label: string }>`, matching `useDestinations`' existing return type in `AppShell.tsx:45`. `PageContainer` and `Header` both take `React.ReactNode`. No name appears with two shapes.

**Known-red window — the prediction was wrong, corrected during execution.** This plan originally said `BerandaPage.test.tsx`'s indicator test would be red from Task 1 through Task 7. It is not: the test string-matches the CSS source text of a rule Task 1 never touches, so it passes while the indicator it guards is silently dead in the browser — `var(--green-dark)` is undeclared from Task 1, which invalidates the whole `box-shadow` declaration.

There is therefore **no expected failure at any point in this plan**. Every task expects the full suite green, and any red test is a real regression. Task 7 Step 5 adds `no-dangling-tokens.test.ts`, the guard that would have caught this, placed there because Task 7 removes the last dangling reference and the guard goes green the moment it is written.
