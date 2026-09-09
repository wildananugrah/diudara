# Phase 0 — the Udara design system and the app shell

**Date:** 2026-09-09
**Programme:** `2026-09-09-udara-program-design.md`
**Branch:** `feat/udara-design-system`
**Schema changes:** none

## Goal

The app wears the reference's design language and its sidebar/header shell,
on the stack this repo already has, with every existing feature intact and
`bun test` green.

This phase deliberately ships no new features. It is first because it is the
one that makes the app *look* like the reference, it changes no schema, and it
can be judged on its own.

## Why a re-tint and not a rewrite

`apps/web/src/styles.css` is 1,711 hand-written lines with no framework, keyed
throughout on variable names like `--green`, `--ink`, `--canvas`. The reference
is *also* plain CSS with custom properties and semantic classes — `.card`,
`.btn`, `.badge`, `.input`. The two are architecturally identical and visually
opposite.

So the cheap move is available: install the Udara palette as the canonical set
and point the existing names at it. Every one of those 1,711 lines then re-tints
without being touched. New code written from Phase 1 onward uses the Udara names
directly; the aliases are retired in a later phase once nothing references them.

## 1. Tokens

### Mechanical mappings

| Existing | Becomes | Note |
|---|---|---|
| `--ink` | `--ink-900` `#16283a` | |
| `--ink-soft` | `--ink-700` `#35526b` | |
| `--ink-faint` | `--ink-500` **`#5d7189`** | darkened from the reference — see §2 |
| `--line` | `--ink-150` `#dce3e8` | |
| `--line-soft` | `--ink-100` `#edf1f3` | |
| `--surface` | `--surface` `#ffffff` | was `oklch(0.99 0.004 90)`, near-white already |
| `--canvas` | `--awan` `#f4f7fa` | |
| `--surface-sunk` | `--awan` `#f4f7fa` | collapses with `--canvas`; the reference has fewer neutrals |
| `--red` | `--merah-senja` `#c1543d` | |
| `--red-bg` | `--danger-bg` `#f7e7e1` | |
| `--gate` / `--gate-dark` | `--langit-dark` `#1a3350` | the reference's dark action is already the paywall colour |
| `--radius` 4px | `--radius-sm` 8px | |
| `--radius-panel` 5px | `--radius-md` 14px | |

### The three that need a judgment call, not a lookup

- **`--green` → `--sinyal` `#e8873e`.** The primary action goes from green to
  orange. This is the single largest semantic change in the phase and it is
  correct: `--sinyal` is the reference's CTA colour and `.btn-primary` is built
  on it.
- **`--green-dark`.** The reference has no dark variant of `--sinyal` — it
  expresses hover as `color-mix(in srgb, var(--sinyal) 80%, transparent)`.
  `--green-dark`'s only load-bearing use here is the Beranda active-tab
  indicator, which this phase replaces outright (§5). Remaining uses adopt the
  `color-mix` hover form; the alias is then deleted rather than redefined.
- **`--green-wash`.** Today it paints the active nav background. The reference's
  active nav is `--langit-dark` with `--awan` text, so that use disappears. Any
  surviving use maps to `--warning-bg` `#fceedc` (the orange-family tint) or
  `--ink-100`, decided per call site — there are few.

`--amber`, `--amber-bg`, `--amber-border` are reported unused by any surviving
component. Verify with a grep, then delete rather than map.

`--hatch` (the locked-content diagonal) keeps its structure, re-tinted to
`--awan` / `--ink-100`.

New tokens taken from the reference verbatim: `--langit`, `--langit-light`,
`--kabut`, `--hijau-lepas`, `--sinyal-light`, `--success-bg`, `--warning-bg`,
`--border`, `--radius-lg`, `--shadow-card`, the six `--sidebar-*` vars, and
`--header-bg`.

## 2. The accessibility deviation

Measured on the reference's own values:

| Pair | Ratio | AA normal text (4.5:1) |
|---|---|---|
| `--ink-500 #6c8298` on `--awan #f4f7fa` | 3.70:1 | fails |
| `--ink-300 #a9b7c4` on `--awan #f4f7fa` | 1.90:1 | fails |

The reference sets every meta line at 12–12.5px in `--ink-500` and every
timestamp at 11.5px in `--ink-300`. Both are body text at small sizes; neither
qualifies for the 3:1 large-text allowance.

This repo already fought this. `styles.css` carries a comment recording that
`--ink-faint` was set to `oklch(0.53 …)` rather than `0.55` because at `0.55` it
measured 4.24:1 on `--canvas` — below AA — and `.muted` lands on that background
across seven components. Copying the reference's neutrals would throw that away.

**Deviation, and the only one in this phase:**

- `--ink-500` is `#5d7189`, not `#6c8298`. Measured **4.66:1** on `--awan`.
  Same hue family, one step darker; at the sizes involved the difference reads
  as crispness, not as a different palette.
- `--ink-300` is demoted to non-text use only — borders, disabled icons,
  dividers. Timestamps move to `--ink-500`.

A test asserts both, so the values cannot drift back (§7).

## 3. Fonts

`index.html` swaps the Google Fonts link:

- display: **Bricolage Grotesque** (`opsz,wght@12..96,300..800`) replaces Instrument Serif
- body: **Plus Jakarta Sans** replaces Instrument Sans

`--font-display` stops being a serif. Headings and prices across the landing
page, auth cards, Beranda, Jelajah, Siaran, Profile and Settings all change
character. This is the intended effect and the second-largest visual shift after
the green→orange primary.

Keep real fallback stacks on both, as the current sheet does.

Add the reference's `font-feature-settings: "tnum" 1, "lnum" 1` on `body` —
tabular lining numerals, which is what keeps prices and counts aligned.

## 4. Icons

Add `@fortawesome/fontawesome-svg-core`, `@fortawesome/free-solid-svg-icons`,
`@fortawesome/react-fontawesome`.

This is the phase's only new dependency, and the justification is narrow: the
app currently contains exactly one glyph (a literal `×` in `MediaStrip`), the
reference's UI is icon-dense throughout — sidebar rows, tab bar, feed type
badges, card actions, empty states — and the reference's own `CLAUDE.md`
specifies Font Awesome, with emoji reserved for chat content. Hand-rolling the
~30 icons needed as inline SVG is more code than the dependency it avoids.

## 5. Component classes

Append the reference's classes verbatim: `.card`, `.card-clickable`,
`.hover-bg`, `.btn` and its seven variants, `.btn-sm` / `.btn-icon` /
`.btn-block`, `.badge` and its four variants, `.avatar`, `.input`,
`.live-badge` with its `pulse` keyframes, `.scrollbar-none`, `.sidebar-nav*`
and `.sidebar-subnav*`.

Then re-point the existing class names at the same visuals so markup does not
have to be edited component by component:

- `.button-primary` → `.btn-primary`'s appearance (a 999px pill in `--sinyal`,
  not a 6px rectangle in green). Every button in the app changes shape.
- `.button-secondary` → `.btn-secondary`, `.button-danger` → `.btn-danger`,
  `.button-link` → `.btn-ghost`
- `.card` already exists in both; the reference's wins (14px radius, border, and
  **no shadow** — the reference is explicit that static cards are flat and only
  `.card-clickable` lifts, on hover)
- `.field input/select/textarea` → `.input`
- `.notice` → the `.badge` family's background/text pairs

Two conventions to adopt from the reference's own documented rules: static cards
carry a border and no shadow; list rows tint their background on hover and never
lift.

## 6. The shell

Replace `AppShell.tsx` with the reference's composition, plus the responsive
behaviour the reference does not have.

New components, mirroring the reference's structure:
`user/shell/Sidebar.tsx`, `user/shell/Header.tsx`,
`user/shell/PageContainer.tsx`, `user/Avatar.tsx`.

**≥768px.** A 248px `<aside>`, inset rather than flush — `margin: 10px 0 10px
10px`, `border-radius: 20px`, `background: var(--awan)`, `border: 1px solid
var(--border)`, `position: sticky; top: 10px`, `height: calc(100vh - 20px)`.
Collapses to 76px behind a chevron, `transition: width 0.18s ease`. Nav rows are
full pills (`border-radius: 999px`, `padding: 9px 12px`) with a 26px icon slot,
using `.sidebar-nav` / `.sidebar-nav-active`. The parent/submenu machinery —
`openMenus[key] ?? isChildActive`, auto-expanding when a child is the active
route, force-closed while collapsed — is built now, unused, because Phase 1's
joined-communities and created-communities lists are exactly what it is for.

The shell paints `--surface` while `body` is `--awan`, so the rail reads as a
tinted panel floating on white. That inversion is deliberate in the reference
and is what makes the layout read the way it does.

**<768px.** The sidebar is hidden. The existing bottom nav is kept — restyled as
pills with Font Awesome icons — because it is the reason the paid-membership
flow works on a phone. `PageContainer`'s `max-width: 1180px` and the reference's
300px right rails stack into one column.

**`Header`** is sticky at `top: 0`, `z-index: 10`, inside `<main>`, so it and the
sidebar stick independently. Props follow the reference: `title`, `subtitle`,
`breadcrumb`, `notificationCount`, `actions`, `insetDivider`. Two notes: the
`actions` slot is dead in every reference page — keep it, Phase 1 uses it for
CommunityHome's invite/share/post controls — and `notificationCount` is
hardcoded to `3` in the reference with no click handler. Here it renders only
when a real count is passed, so nothing claims a notification that does not
exist. Notifications are Phase 8.

**Destinations, this phase:** today's set — Beranda, Jelajah, Siaran, and the
session-dependent fourth (Profil → `/pengaturan` signed in, Masuk → `/masuk`
signed out). Phase 1 swaps in Discover / Komunitas / Dashboard Creator. The
signed-out fourth item must keep telling the truth about where it goes; a
previous review found it pointing at `/pengaturan` unconditionally and bouncing
signed-out visitors straight back out.

`AppShell` keeps rendering one computed destination list twice — once as a rail,
once as a bar — with CSS choosing. That is what lets the existing tests prove
"one source, two shapes" instead of two lists drifting apart.

## 7. Tests

**One invariant is broken on purpose.** `BerandaPage.test.tsx` pins the active
feed tab to `box-shadow: inset 0 -2px 0 var(--green-dark)` and asserts the rule
does *not* contain `border-bottom-color`. That test exists because the indicator
vanished once when a border was removed. The reference's tab indicator is
`border-bottom: 2px solid var(--sinyal)` — precisely what the test forbids.

The test is rewritten to pin the new indicator, keeping its structure: still
keyed on `.feed-tabs button[aria-current=true]`, still asserting exactly one
rule declares the indicator, still forbidding `aria-selected` and
`button.active` as the key. The docstring records that the shadow form was
replaced by the Udara border form in this phase, so the next reader sees a
deliberate change and not an eroded guard.

**One invariant is kept and must survive.** `AppShell.test.tsx` asserts both nav
shapes declare a `z-index` and that the lowest nav z-index beats every other
z-index in the sheet. The new sidebar, sticky header (`z-index: 10`), modal
scrims (`z-index: 200`) and floating chat (`z-index: 100`) all interact with
this. The header sits *inside* the scroll area and the nav is chrome, so the nav
must still win. Expect this test to fail first and to be informative when it
does.

**New guard.** A test asserting no rule outside `:root` hardcodes a colour —
catching the ~12 values that will otherwise not follow the palette:
`#cbd5e1` on every input/select/textarea border and `.button-secondary`;
`#fecaca`, `#166534`, `#f0fdf4`, `#bbf7d0`, `#fca5a5` in `.form-error` /
`.form-ok` / `.button-danger`; `#252b25` in `.stream-self-preview`; and six
inline `oklch()` literals in `.stream-player`, `.stream-obs-details code`,
`.stream-composer-live .button-danger` and `.profile-live-badge`. All are
tokenised as part of this phase.

**New guard.** A test asserting `--ink-500` and `--ink-300` hold the values §2
settled on, so the contrast work cannot be silently reverted to the reference's
figures.

**Everything else stays green.** 24 test files, ~500 `it()` blocks. They query by
role, label and text; class names appear in only six assertions
(`.post-card-body`, `.post-card-media`, `.membership-offer`,
`.post-card-locked-count`, `.profile-bio`, `.post-card-meta`). Those six class
names are kept.

## 8. A hazard in the sheet

`styles.css` is already two layers deep: lines 1163+ are a "REDESIGN" layer
appended rather than merged, which overrides earlier rules by source order for
`.button-primary`, `.button-secondary`, `.side-rail`, `.membership-tier`,
`.follow-row`, `.landing-features`, `.feed-tabs button` and the composer.

Editing only the top half will silently lose to the bottom half. This phase
collapses the two layers into one while re-tinting, because leaving a third
layer on top of two would make the next phase worse.

## Scope

`apps/web/src/styles.css` (major), `apps/web/index.html`,
`apps/web/package.json`, `AppShell.tsx` rewritten, four new shell components,
and className touch-ups across roughly fifteen page and feature components.

## Verification

- `bun test` in `apps/web` — all files green, the two updated/kept invariants
  behaving as §7 describes
- `bun run typecheck` — clean
- The two new guard tests failing before the tokenisation work and passing after
- Manual: the owner drives the app; this session does not run dev servers or
  browser gates
