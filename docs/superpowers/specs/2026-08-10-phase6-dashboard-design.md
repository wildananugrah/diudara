# Phase 6: Creator Dashboard & Analytics — Design Spec

Date: 2026-08-10
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phases 1-5 (merged: `d0904b8`, `565d43a`, `c78ad11`, `e722276`, `8f3acff`)

## 1. Purpose

Five phases in, **no creator can use this product.** Signing up, creating a community, defining
tiers, connecting a Telegram channel, connecting payments, revoking a member — every one is
curl-only. `apps/web` exists but holds only the public checkout pages a *member* sees.

Phase 6 gives creators a dashboard: the screens for what already works, plus the metrics the PRD
says a creator sees on login (member counts, revenue, churn, activity log, tier distribution) and
a member CSV export.

This is the phase that makes the product operable by a human being.

## 2. Scope

**In scope:**
- **Creator dashboard** in `apps/web`: login, community list/create, and a community detail view
  covering tiers, channels, members and metrics — including the actions that exist today with no
  UI (connect payments, define a tier, connect a channel, revoke a member)
- **Metrics API**, creator-scoped:
  - member counts by status, revenue total, churn (PRD P0)
  - member activity feed (PRD P0)
  - tier distribution (PRD P1)
  - member CSV export (PRD P2)
- The `activity_log` index the dashboard queries actually need (§4)

**Out of scope (with the phase that owns it):**
- Advanced analytics — cohort retention, churn prediction (PRD Fase 3)
- AI co-builder — Phase 7
- Live streaming — Phase 8
- PWA — Phase 9
- Editing a community's slug or status from the UI beyond what Phase 2's API already exposes
- Refunds, plan changes, proration

## 3. Decisions settled during brainstorming

| Question | Decision | Reason |
|---|---|---|
| Phase 6 scope | Dashboard UI **plus** the P0/P1/P2 metrics | Metrics nobody can see are not a feature; the product needs to be usable |
| Design direction | Clean, functional, minimal hand-written CSS | Consistent with the shipped checkout pages, no new dependency surface |
| Token storage | `localStorage`, sent as `Authorization: Bearer` | Matches what `requireAuth` already expects; no API change (§6) |
| CSV export | **Streamed from the endpoint, not via S3** | No S3 bucket or credentials have ever been configured; a creator downloading their own member list does not need object storage in between. S3 returns if exports ever need async generation. |

## 4. The index comes first

`activity_log` currently has only single-column indexes on `member_id` and `community_id`. Every
dashboard query is shaped `community_id + event_type + created_at range`.

**Corrected 2026-08-10 by measurement (Task 1/3 implementation).** This section originally
prescribed `(community_id, event_type, created_at)`. Measured on PostgreSQL 16.13 with 300k rows,
that index **does not serve the feed at all**:

| Index | Time | Buffers |
|---|---|---|
| `(community_id, event_type, created_at)` | 15.9 ms | 1277 |
| *that index dropped* | 12.5 ms | 1277 (same plan) |
| `(community_id, created_at)` | **0.12 ms** | **5** |

The feed filters `event_type IN (…8 values…)` and orders by `created_at`; a SAOP on the **middle**
column cannot satisfy the ORDER BY, so Postgres ignored the index entirely. `(community_id,
created_at)` is the one the feed needs, and the measurement lives in a schema comment so nobody
"tidies away" the one that works.

**Corrected again 2026-08-10 by the final review.** This section then said both indexes were kept,
because the original "still answers a single-event-type plus date-range query". **No such query
exists.** The only read of `activity_log` anywhere in the API is the feed; everything else is an
`insert`. So `(community_id, event_type, created_at)` served nothing and was pure write
amplification on the fastest-growing table in the product — and measured independently, with
**only** that index present the feed ran **145 ms / 3676 buffers** against **17 ms with no
composite index at all**, because it lured the planner into a bitmap scan over 50 000 rows. It was
dropped in migration `0015`. Add it back in the migration that adds the query that needs it, not
before. *An index kept for an anticipated caller is a cost paid every day for a benefit that may
never arrive.*

The underlying point stands: the activity feed is the most-viewed screen and the table grows with
every payment, reminder, revocation and grant, so getting the index wrong means the dashboard
degrades exactly as a creator becomes successful. **Measure it rather than reasoning about it** —
this plan asserted a shape and was 130x wrong.

Note the identifiers analytics might want later — `subscriptionId`, `tierId`, `stage` — live in
unindexed `jsonb`. That is acceptable for this phase's queries; it is a reason not to build
filtering on them yet.

## 5. Creator scoping lives in the repository

These are the **first creator-scoped reads of a table the worker writes unscoped.** The worker
writes `activity_log` as the system; the dashboard reads it as one specific creator.

Scoping belongs in the **repository**, not at the call sites — the shape Phase 2 established with
`findByIdForCreator`, for the same reason: it makes the unscoped read hard to write by accident.
Phase 4's review praised `CommunityRepositoryPort` for having no unscoped lookup, and Phase 3's
single sanctioned exception (`findBySlug`, for public checkout) is documented at the port. Follow
that pattern.

Cross-creator access returns **404, not 403**, throughout.

## 6. Browser auth, and its honest tradeoff

The dashboard stores the Phase 2 JWT in `localStorage` and sends it as `Authorization: Bearer`.
This needs no API change.

**The tradeoff is real and should not be described as free:** a XSS bug could read the token,
where an `httpOnly` cookie could not. It is accepted here because the dashboard loads no
third-party scripts and the attack surface is small — but it is a security *choice*, and if the
product later embeds third-party analytics or user-generated HTML, it should be revisited.

Consequences to implement deliberately:
- A 401 from any endpoint clears the stored token and returns the creator to login. A stale
  7-day token otherwise leaves the UI in a broken half-authenticated state.
- The token is never logged, never put in a URL, and never rendered.

## 7. Revenue is the number most easily got quietly wrong

A creator will trust revenue more than anything else on the page, and it is the easiest figure to
compute incorrectly without anyone noticing.

**Only `transaction.status = 'success'` counts.** Phase 5 can now leave transactions in states
that must **not** be summed:
- `pending` — an invoice created but never paid
- `failed`
- the `pending` row a `subscription_churned` rollback leaves

**Corrected 2026-08-10 (Task 2 implementation).** This section originally also excluded
`superseded`, calling it a rolled-back settlement. **That was wrong.** `markPaid` settles the
*transaction* as `success` and marks only the duplicate *subscription* `superseded` — the money
genuinely arrived and appears on the creator's Xendit statement. Excluding it would understate
revenue and, worse, hide a refund that is owed. Only `subscription_churned` actually rolls back.

There is no refund path yet, so no refund exclusion is needed — but when one arrives it must be
subtracted here, and the plan should note that.

**The revenue figure is gross, not net.** DIUDARA's platform fee is deducted by Xendit's split
rule, so what the creator actually receives is less. The dashboard must either label it as gross
or show the fee — presenting a gross figure as "your revenue" would misstate a creator's income,
which matters more than a rounding bug.

Amounts are **integer Rupiah**; format for Indonesian readers (`Rp 1.250.000`). Never use floating
point on money.

## 8. The two-rows-per-reminder trap

A reminder writes **two** `activity_log` rows — `renewal_reminder_queued` and
`renewal_reminder_sent` — and **only the second means delivered**.

So:
- the activity feed must not show both as separate events to the creator
- any "reminders sent" count must not double
- `renewal_reminder_skipped` and `_not_sent` exist too and mean neither

This is invisible until a creator counts by hand and finds twice what they expected, so it gets an
explicit test.

Related: **`renewal_reminder` rows are deleted on renewal.** They are a lock, not a history — "how
many reminders did we send last month" must come from `activity_log`.

`renewed` and `joined` are deliberately distinct event types and must not be conflated: a renewal
is not a new member.

## 9. Screens

| Screen | Contents |
|---|---|
| Login | Email + password → token stored, redirect to communities |
| Communities | List with member counts; create a community |
| Community → Overview | Member counts by status, gross revenue, churn, tier distribution |
| Community → Members | Roster with status and tier; revoke action; CSV export |
| Community → Tiers | List; create; activate/deactivate |
| Community → Channels | List; connect a Telegram channel (numeric chat id — see §11) |
| Community → Activity | Paginated feed, newest first |
| Account | Connect payments (`POST /payment-account`), showing whether it is connected |

Mobile-aware, but desktop-first is acceptable here — unlike checkout, a creator managing tiers is
plausibly at a laptop.

## 10. Errors

| Condition | Behaviour |
|---|---|
| 401 from any endpoint | Clear token, redirect to login |
| 404 (not the caller's community) | "Not found" — never reveal that it exists |
| 409 (payments already connected, duplicate tier name) | Inline message, form state preserved |
| 400 validation | Field-level messages from the Zod issues the API already returns |
| Network failure | Retry affordance; never a blank screen |

## 11. Things the UI must get right because the API is strict

- **Telegram channels need the numeric chat id**, not `@username` — Phase 4 constrained this so a
  join can be matched back for revocation. The form must say so and explain where to find it.
- **A creator with no payment account cannot sell.** The dashboard should surface that prominently
  rather than letting them build tiers that nobody can buy.
- **A paused community renders its checkout page but rejects purchases**; archived 404s. The UI
  should say which state a community is in and what it means.

## 12. Testing

- Repository tests proving **cross-creator reads return nothing**, against real Postgres
- A test proving the activity feed does not double-count reminders (§8)
- A test proving revenue excludes `pending`, `failed`, and rolled-back transactions (§7)
- Component tests for the dashboard screens against a stubbed fetch
- An end-to-end pass in a real browser: log in, create a community, define a tier, connect a
  channel, connect payments, view metrics, export CSV — the flow a real creator performs on day one

## 13. Carry-forward items to address here

From Phase 5's ledger:
- Both composition roots hard-wire `SystemClock`; an env-driven clock would make end-to-end
  verification much cheaper than seeding dates backwards.
- No deployment plumbing: no `start` script, no Dockerfile, no API/worker services in
  `infra/docker-compose.yml`.
- Still no Xendit account and no Telegram bot token — both adapters remain unverified, now for the
  fourth phase running.
