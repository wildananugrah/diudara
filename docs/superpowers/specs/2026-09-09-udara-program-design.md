# Udara: adopting the reference UI/UX and pivoting to communities

**Date:** 2026-09-09
**Status:** approved decomposition, phases specced individually
**Reference:** `github.com/adamfloothink/diudara` — a static mockup, no LICENSE
file present. Confirm the intended terms with its author before any of its code
is redistributed; this program ports its design, and lifts component structure
where the reference's own README invites it ("gampang di-port ke `apps/web`").

## What this is

The reference repo is a hi-fi design mockup for DIUDARA: React + Vite,
~2,900 LOC, all data hardcoded in one `src/data/mock.ts`, no backend. Its
own `CLAUDE.md` states its purpose — "visual/interaction reference for the
dev team" — and its README says it is written "dengan struktur yang gampang
di-port ke `apps/web`".

This program adopts it: the design language, the shell, the information
architecture, and eventually the whole feature set, built for real on the
stack this repo already has.

## The four decisions this program rests on

Recorded because each one had a cheaper alternative that was rejected, and
a later reader will otherwise assume the cheap one was never considered.

1. **Full clone including new features**, not a re-skin. The reference's
   communities, events, discussions, announcements, materi and dokumen get
   built for real, with schema and API behind them — not wired to mock data.

2. **Communities are the direction.** The reference is community-centric
   (`/community/:id` is the spine; discussions, events and announcements are
   *post types within a community*, not separate features). This repo had
   pivoted the other way — to a user-centric model of profiles, following and
   personal tiers, over the `retire-telegram`, `user-accounts`,
   `profiles-and-following` and `free-memberships` phases. That pivot is being
   reversed as the *primary* axis.

3. **Mobile is kept, and designed.** The reference has **zero** `@media`
   queries: fixed 300px rails, a 1180px container, a `1fr 320px` live layout.
   It is a desktop-only artefact. This app is mobile-first on purpose — the
   bottom nav below 768px, the 36rem column, and the deliberate move of the
   profile and membership flow *inside* `AppShell` on 2026-08-25 so the paid
   flow is not a dead end on a phone. Following the reference literally would
   undo that. So: the reference's look is adopted exactly, and the responsive
   behaviour it never had is designed rather than ported.

4. **Nothing shipped gets deleted.** Profiles, following, Beranda, Siaran and
   personal memberships stay and receive the new design. Communities are added
   as a new layer beside them. Retiring the overlap is a later, separate
   decision to be taken once communities have proven out — not a precondition
   of this program.

## Why this is decomposed

The reference implies, at minimum: communities CRUD and discovery, a unified
feed of five post types with tags and attachments, threaded comments,
announcements, events with a month calendar and RSVP, a syllabus/lesson system
with video/audio/ebook/quiz, a document library, a member roster with roles and
status, per-community checkout, creator analytics, multi-party live rooms,
direct messaging, an AI onboarding flow, and notifications.

That is a product rebuild. It does not fit in one spec, one plan, or one
review. Each phase below gets its own spec, its own plan, its own branch and
its own green test run before the next begins.

## Phases

| # | Phase | Ships | Backend |
|---|---|---|---|
| 0 | Design system + shell | The app wears the Udara language and the sidebar/header shell | none |
| 1 | Communities core | Browse tabs, CommunityHome banner + roster, create/join | **drop** the 18 dormant tables; new `community` + `community_member` |
| 2 | Feed | 5 post types, FeedPostCard, PostEditorModal, DiscussionDetail + comments, announcements | posts gain a community owner; new comments table |
| 3 | Events + calendar | Kegiatan tab, month grid, agenda, EventDetail | new `community_event` + RSVP |
| 4 | Materi + Dokumen | Syllabus, lesson viewer, document library | new course/lesson + documents |
| 5 | Per-community checkout | Tier selection, payment, success | adapt existing Xendit path |
| 6 | Creator dashboard | Metrics, revenue chart, tier distribution, activity log | new aggregate queries |
| 7 | Live rooms | **Scoping decision required** — see below | likely new SFU |
| 8 | DMs, Pulse-ID, notifications | FloatingChat, AI onboarding, the bell | new realtime; `ai_conversation` tables exist unused |

Phase 0 is first because it is the phase that makes the app *look* like the
reference, it is independently shippable, and it touches no schema — so it can
land and be judged on its own.

**Correction, made during Phase 1's design.** This table originally said Phases
1, 3 and 4 would *revive* the dormant `community`, `channel`, `join_request`,
`event`, `event_rsvp`, `course` and `enrollment` tables. They cannot be revived:
`community.creator_id` is `NOT NULL REFERENCES creator(id)`, and `creator` is a
separate identity from `app_user` with no foreign key, no shared id, and no
login path since it was deleted. Every one of the eighteen dormant tables hangs
off that root.

Phase 1 therefore **drops** the dormant set and builds fresh user-scoped tables,
with the repo owner's explicit authorisation for the data loss. Later phases add
their own tables rather than reviving anything. See
`2026-09-09-communities-core-design.md` for the full reasoning.

## Two things the reference cannot simply be copied on

**Live rooms (Phase 7).** The mockup's `LiveRoomPage` shows a multi-participant
video call: a speaking-participant strip, per-participant mute state, mic and
camera toggles. This repo streams via WHIP ingest to MediaMTX and plays back
over HLS — one publisher, many viewers, with seconds of latency. These are
different technologies, not different styling. Phase 7 must first decide
whether the product needs real multi-party conferencing (an SFU: LiveKit,
mediasoup, Janus) or whether the mockup's UI should be re-read as a broadcast
studio over the existing pipeline. Do not start Phase 7 without that decision.

**DECIDED, 2026-09-12, by the repo owner: a BROADCAST STUDIO.** Creators
broadcast and members watch; there is no multi-party conferencing in this
product. No SFU is adopted, no new server software is introduced, and no new
operational cost is taken on. `LiveRoomPage` is therefore re-read as a watch
page over the existing WHIP/MediaMTX/HLS pipeline, and the mockup's
participant strip — the one element that only makes sense in a call — is not
built, because in a broadcast there is exactly one person on camera and the
strip would have nothing to show.

Two further things the mockup shows do not follow from that decision and are
recorded in `2026-09-12-live-room-design.md` rather than here: the chat panel
(which needs the realtime layer Phase 8 owns) and the viewer count (which
needs MediaMTX's control API enabled — infrastructure this phase declined to
change).

**Accessibility of the palette.** Measured, not assumed:

| Pair | Ratio | WCAG AA (4.5:1 normal text) |
|---|---|---|
| `--ink-500 #6c8298` on `--awan #f4f7fa` | 3.70:1 | fails |
| `--ink-300 #a9b7c4` on `--awan #f4f7fa` | 1.90:1 | fails |

The reference sets all meta text at 12–12.5px in `--ink-500` and timestamps at
11.5px in `--ink-300`. This repo's stylesheet carries a comment recording that
`--ink-faint` was tuned to `oklch(0.53 …)` precisely to reach 4.61:1 on
`--canvas`, because `.muted` lands on that background in seven components.
Adopting the reference's neutrals verbatim would discard that work and drop the
app below AA.

The program therefore deviates from the reference on exactly this point:
`--ink-500` becomes `#5d7189` (4.66:1, same hue family, one step darker), and
`--ink-300` is demoted to non-text use — borders, disabled icons — with
timestamps moving to `--ink-500`. Every other Udara value is taken as-is.

## Working agreement

- One phase per branch, named `feat/udara-<phase>`, merged with a descriptive
  merge commit as this repo already does.
- `bun test` and `bun run typecheck` green before any merge. There is no CI
  test gate on this repo — a push to `main` deploys — so green-before-push is a
  real obligation, not a formality.
- Nothing is pushed to `origin` without the repo owner saying so for that push.
- Where a phase must break an existing test invariant, it updates the test
  deliberately, with a comment recording why, rather than deleting or weakening
  it quietly.
