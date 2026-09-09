# Phase 0 handoff — the Udara design system and shell

**Branch:** `feat/udara-design-system`, 25 commits from `a692f2e`.
**State:** 732 tests pass, 0 fail; `tsc --noEmit` clean; 26 guard assertions green.
**Never rendered.** No dev server or browser automation ran during this work.

Plan: `docs/superpowers/plans/2026-09-09-udara-design-system.md`
Spec: `docs/superpowers/specs/2026-09-09-udara-design-system-design.md`
Programme: `docs/superpowers/specs/2026-09-09-udara-program-design.md`

## What shipped

The Udara palette ("Langit & Sinyal") replaces the green oklch palette, installed
as canonical with an alias layer so the sheet's ~1,700 existing lines re-tinted
without being edited. Bricolage Grotesque and Plus Jakarta Sans replace
Instrument Serif/Sans. The reference's `.btn` / `.card` / `.badge` / `.input`
classes are in, and the app's own `.button-*` / `.field` / `.notice` point at
them. The stylesheet's two competing layers were collapsed into one. A new
shell — inset 248px collapsible rail above 768px, the existing bottom bar
restyled below it — replaces the old rail, and all six member-facing pages now
render their title through a sticky `Header`.

No schema change. No feature added or removed.

## Deviations from the reference, and why

The reference's own colour pairings do not clear WCAG AA. Every deviation below
changes ink only and leaves the reference's hues exactly as drawn.

| Where | Reference | Ships as |
|---|---|---|
| `--ink-500` | `#6c8298`, 3.70:1 | `#5d7189`, 4.66:1 |
| `--ink-300` | used for 11.5px timestamps, 1.90:1 | borders and disabled icons only |
| `.btn-primary` | `--awan` on `--sinyal`, 2.45:1 | `--ink-900`, 5.69:1 |
| `.btn-secondary` | `--awan` on `--kabut`, 2.27:1 | `--ink-900`, 6.16:1 |
| `.btn-danger` | `--merah-senja` on `--danger-bg`, 3.80:1 | `--danger-ink`, 5.76:1 |
| `.btn-petang:hover`, `.btn-ghost:hover` | `--awan` on `--kabut`, 2.27:1 | `--ink-900`, 6.16:1 |
| focus ring | `--sinyal` outline, 2.45–2.64:1 (WCAG 1.4.11 wants 3:1) | `--langit`, 8.25–8.87:1 |

Three more were this phase's own doing, not the reference's: the alias layer
pointed `--green` at an orange, so `.form-error` (3.80:1), `.brand` (2.64:1) and
`.landing-eyebrow` (2.45:1) silently dropped below AA when the sheet re-tinted.
All three are fixed. The reference's three **badge** inks — `#2e6248`,
`#9a5b18`, `#93412c` — are the reference getting it right; they are kept
verbatim as `--success-ink` / `--warning-ink` / `--danger-ink`. Do not "tidy"
them into palette tokens.

**One judgement call to revisit if you disagree:** the primary CTA now reads
dark navy on orange rather than white on orange. Making white pass needs
`--sinyal` down to a relative luminance of 0.167, which is brown, not the
brand — so the hue was kept and the label darkened. Reversible by darkening the
fill instead.

## Look at these first, in a browser

Nothing here has been rendered. In rough order of risk:

1. **`/beranda` at ≥768px** — the page title in the sticky header. It should be
   Bricolage Grotesque, matching the price on a profile's membership offer. This
   was broken until the final review and is the least-exercised fix.
2. **Any shell page at 1440px** — the content column. `.user-page` caps at 36rem,
   so expect a 576px column beside a 268px rail with a lot of empty space to the
   right. See "the open question" below.
3. **Any form submitted with a bad password** — the error box. Its ink changed
   twice during this phase.
4. **Tab through any form** — the focus ring is now navy, not orange. Confirm it
   is visible on every field.
5. **`/masuk` and `/`** — the DIUDARA wordmark and the landing eyebrow, both
   changed from orange to navy for contrast.
6. **`/@handle`** — the display name now lives only in the sticky header; the
   body starts at `@handle`. Confirm that reads as intended.
7. **`/jelajah`** — follow rows carry `.card`, whose 18px padding is overridden
   to `0.875rem 0`. Look for text touching the rounded borders.
8. **`/siaran` below 768px, scrolled down** — member badges against the fixed
   bottom bar. The z-index invariant says this is fine; it is the regression the
   invariant was written for, so confirm once.

## The open question Phase 1 must settle

`PageContainer` was removed from all six pages: it caps at 1180px inside a
576px parent, so it could only ever compound padding. The component is kept and
documented as unused.

The real question it exposes is whether the app adopts the reference's **wide
1180px frame** or keeps its **36rem reading column**. The reference is a wide
desktop layout; this app is a mobile-first narrow column, deliberately. Phase 0
kept the column, because changing it reflows every existing page. Phase 1's
community pages are the first that genuinely want the wide frame — decide it
there, deliberately, rather than letting the two drift.

## What Phase 1 inherits

**Solid.** 32 of the reference's 33 tokens present at identical values (the
absentee is dead in the reference too). The alias layer did its job. Four guard
tests now fail on defect classes that previously reached a browser unseen:
`design-tokens` (pins the accessibility deviations), `no-hardcoded-colours`,
`no-dangling-tokens`, `contrast`, and `cascade-order`. `AppShell` still produces
one destination list and renders it twice. The nav z-index is asserted as an
invariant rather than a number.

**Fragile — read this before writing Phase 1 CSS.**

- **`contrast.test.ts` is a floor with a real hole.** It only measures a rule
  declaring *both* a colour and a background. A rule with `color:` and no
  `background:` is never considered at all — that is exactly how three AA
  failures shipped in this phase. Phase 1's avatars, identity chip and community
  cards are all that shape.
- **`no-hardcoded-colours` is blind to named CSS colours.** `color: white`
  passes.
- **`no-dangling-tokens` collects declarations sheet-wide**, so a property
  scoped to one component passes while dying in another rule.
- **`cascade-order` pins one of at least three source-order dependencies.**
  `.landing-feature`, `.membership-tier` and `.follow-row` each clear properties
  `.card` sets and rely on being declared after it. Only the `.btn*` /
  `.button-*` pair is guarded.
- **`.card` carries a baked 18px padding** the reference's does not, and three
  consumers already override it. Any Phase 1 surface wanting a flush card will
  fight it.
- **Two class families style the same buttons.** Every new control must carry
  both `btn` and a legacy `button-*` class, or get the wrong one silently.

## Deferred, deliberately

Dead `.sidebar-subnav*`, `.avatar` and `.scrollbar-none` rules (their consumers
arrive in Phase 1); half-tokenised radii (three tokens coexisting with 3/4/6/10/13px
literals); `--green` and `--green-wash` now resolving to orange, which are
misleading names rather than broken ones; colliding task-number comments from
three different phases; JSX indentation drift in five files (this repo has no
formatter).
