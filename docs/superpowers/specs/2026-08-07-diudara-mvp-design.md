# DIUDARA MVP — Design Spec

Date: 2026-08-07
Status: Approved for planning
Source docs: `docs/DIUDARA - PRD.docx.pdf`, `docs/DIUDARA - PROPOSAL.pdf`

## 1. Product summary

DIUDARA ("Paid Community Gateway") is a layer of monetization and automation on top of
existing WhatsApp/Telegram communities — not a new walled-garden app members must migrate
to. A **Creator** connects an existing WA/Telegram group, defines paid membership tiers,
and the system gates group access behind local Indonesian payment methods (QRIS, e-wallet,
VA, cards), auto-adding/removing members based on payment status, handling recurring
billing and retries, and offering an AI co-builder (Bahasa Indonesia) to speed up
onboarding.

## 2. Scope for this build

**In scope** — the PRD's full Fase 1 MVP, plus two additions pulled forward from later
phases at the user's request:

- AI co-builder / onboarding chat (niche interview, welcome message generation, channel
  structure suggestions, checkout copy generation)
- WhatsApp + Telegram group integration (auto add/remove, one-time invite links, scheduled
  broadcast)
- Local payments (QRIS, e-wallet, VA, cards) with recurring billing + automatic retry
  (day 1/3/7) + churn detection
- Creator dashboard (member/revenue/churn metrics, tier distribution, activity log)
- Public checkout/landing page per community (mobile-first, PWA-installable)
- **Self-hosted live streaming** (pulled forward from Fase 3) — creators can go live to
  paying members, with recording + replay
- PWA support (installable, offline app-shell) for both the creator dashboard and the
  public checkout/watch pages

**Explicitly out of scope** (deferred, per PRD roadmap — Fase 2+): course builder (drip
content, progress tracking, certificates), structured event RSVP/ticketing beyond the
live-stream flow itself, gamification (points/leaderboard/badges), affiliate/referral
program, the full "Pulse-ID" prompt-to-page AI co-builder, advanced analytics (cohort
retention, churn prediction), open data export API.

## 3. Tech stack

- Database: PostgreSQL
- Backend: Bun + Hono, layered per SOLID principles
- Frontend: Vite + React (single app, two route trees), PWA via `vite-plugin-pwa`
- File storage: AWS S3 (community/creator branding assets, invoice/receipt exports,
  member data exports, live-stream recordings)
- ORM: Drizzle
- Payment gateway: Xendit (split-payment/marketplace mode — platform never holds member
  funds directly, per PRD's PJP-licensing risk mitigation)
- WhatsApp integration: Fonnte
- Telegram integration: official Telegram Bot API
- AI/LLM: OpenRouter (model-agnostic gateway)
- Live streaming: self-hosted MediaMTX (RTMP ingest → HLS playback), on the same VPS
- Deployment: Docker Compose on a self-managed VPS

## 4. Repo layout

```
apps/api/        Hono backend (routes, use-cases, domain, ports, adapters)
apps/web/        Vite + React frontend (creator dashboard + public checkout/watch pages)
apps/worker/      Billing/retry cron worker, shares domain/use-case code with api
packages/shared/  Zod schemas & shared TypeScript types (DTOs) used by api/web/worker
infra/            docker-compose.yml, nginx config, MediaMTX config, DB migrations
```

Bun workspaces tie the packages together; `packages/shared` is the single source of truth
for request/response shapes so frontend and backend can't drift.

## 5. Backend architecture (ports & adapters, SOLID)

This is the layering that actually satisfies SOLID's O/L/I/D principles, and matches the
PRD's own non-functional requirement that "each component (payment, messaging, AI) can be
replaced without reworking the core system."

- **Domain**: plain entities — `Creator`, `Community`, `MembershipTier`, `Channel`,
  `Member`, `Subscription`, `Transaction`, `ActivityLog`, `LiveSession` (extends the
  PRD's stubbed `Event`/`EventRsvp` concept). No framework dependencies.
- **Application (use-cases)** — one class per business action, each depending only on
  interfaces, never concrete SDKs:
  - `RegisterCreator`, `AuthenticateCreator`
  - `RunAiOnboardingStep`, `GenerateWelcomeMessage`, `GenerateChannelSuggestions`,
    `GenerateCheckoutCopy`
  - `CreateCommunity`, `DefineMembershipTier`, `ConnectChannel`
  - `PurchaseSubscription`, `HandlePaymentWebhook`, `ProcessBillingCycle` (worker entry
    point), `RetryFailedPayment`, `MarkSubscriptionChurned`
  - `GrantChannelAccess`, `RevokeChannelAccess`, `SendScheduledBroadcast`
  - `ScheduleLiveSession`, `HandleStreamPublished`, `HandleStreamEnded`,
    `IssueSignedWatchLink`
- **Ports** (interfaces owned by the application layer):
  - `PaymentProviderPort` — `createCharge`, `verifyWebhook`, `refund`
  - `MessagingProviderPort` — unified across WA/Telegram: `inviteMember`,
    `removeMember`, `sendMessage`, `broadcast` (one implementation per platform)
  - `AiProviderPort` — `converse`, `generateText`
  - `StoragePort` — `putObject`, `getSignedUrl`
  - `StreamingProviderPort` — `createSession` (returns RTMP URL + stream key),
    `getPlaybackUrl`, `finalizeRecording`
  - Repository interfaces per entity
- **Adapters (infrastructure)**: `XenditPaymentAdapter`, `FonnteWhatsAppAdapter`,
  `TelegramBotAdapter`, `OpenRouterAiAdapter`, `S3StorageAdapter`, `MediaMtxAdapter`,
  Drizzle-based Postgres repositories.
- **Presentation**: thin Hono route handlers — validate input with Zod, call exactly one
  use-case, map the result to an HTTP response. No business logic in routes.
- Composition root (`apps/api/src/bootstrap.ts`) wires concrete adapters into use-cases at
  startup via plain constructor injection — no DI framework needed at this scale.

## 6. Frontend architecture

Single Vite + React app, two route trees:

- `/app/*` — creator dashboard, JWT-authenticated (email + password login).
  AI onboarding chat, community/tier/channel management, analytics dashboard, live
  session scheduling/controls.
- `/c/:communitySlug` — public checkout/landing page, no auth. Tier preview, payment
  method selection, WA number capture, redirect to Xendit-hosted payment, confirmation
  screen.
- `/watch/:token` — public watch page for live streams/replays, gated by the signed,
  time-limited token sent via WA (see §8.5).

Shared tooling: TanStack Query for server state, Zod (shared with backend) for form
validation, Tailwind for styling, `hls.js` for stream playback, `vite-plugin-pwa` for the
installable app shell (manifest + service worker) across both route trees. Offline support
is app-shell only — checkout, payment status, and live playback all require network and are
not expected to function offline.

## 7. Database schema

Base schema is the PRD's Fase 1 tables, used as-is: `creator`, `community`,
`membership_tier`, `channel`, `member`, `subscription`, `transaction`, `activity_log`.
`course`, `enrollment` stay stubbed/unused (Fase 2, out of scope here).

Additions needed beyond the literal PRD schema for the features pulled into this build:

**`subscription`** — add billing-retry bookkeeping:
- `retry_count` (integer, default 0) — resets to 0 on successful payment
- `last_attempt_at` (timestamp, nullable) — drives the day 1/3/7 retry schedule

**`event`** (activated for this build, not left stubbed) — add live-streaming fields:
- `stream_key` (varchar, secret, unique, rotated per session)
- `status` (varchar: `scheduled` / `live` / `ended`)
- `hls_playback_path` (varchar, nullable)
- `recording_url` (varchar, nullable — S3 location once finalized)

`event_rsvp` is used as originally scoped (member registers interest in a live session).

**`activity_log`** — relax `member_id` to nullable. The PRD's original log entries
(joined/upgraded/payment_failed/churned) are always member-scoped, but stream lifecycle
events (`stream_started`/`stream_ended`) and future system-level entries are
community-scoped only, with no single member to attach them to.

## 8. Key flows

### 8.1 Creator onboarding (AI co-builder)
Creator registers (email/password) → chat UI walks through niche/target audience/pricing
→ each turn forwarded to OpenRouter with a Bahasa Indonesia system prompt → structured
draft returned (community name/description, suggested channels/topics, draft welcome
message) → creator edits/confirms → persisted as `Community`/`Channel`/welcome-message
content.

### 8.2 Checkout & payment
Member opens `/c/:slug` → picks a tier + payment method, enters name + WA number →
backend creates `subscription` (pending) + `transaction` (pending) → `PaymentProviderPort`
creates a Xendit charge/invoice (idempotency key attached) → member completes payment on
Xendit's hosted flow → Xendit webhook (signature-verified) confirms → transaction/
subscription marked active, `next_billing_date` set → `GrantChannelAccess` invites the
member via the right `MessagingProviderPort` implementation (Fonnte for WA, Telegram bot
for Telegram) → `activity_log` entry written.

### 8.3 Recurring billing, retry, churn
Worker cron scans subscriptions where `next_billing_date` is due → creates a new
transaction + Xendit charge → sends a WA payment reminder. On failure: retries at
+1/+3/+7 days (tracked via `retry_count`/`last_attempt_at`), notifying the member via WA
at each attempt. If still unpaid after the retry window: `subscription.status = churned`,
`activity_log` entry written, `RevokeChannelAccess` kicks the member from the group.

### 8.4 WA/Telegram gating
One-time-use invite links only, generated per successful payment — never shared statically
— preventing non-payers from joining via a leaked link. Removal is synced automatically on
churn/refund.

### 8.5 Live streaming
Creator schedules a session → `ScheduleLiveSession` generates an RTMP URL + stream key via
`MediaMtxAdapter` → creator streams from OBS/phone. On go-live, MediaMTX's on-publish
webhook triggers `HandleStreamPublished` → `event.status = live` → WA broadcast to active
subscribers/RSVP'd members with a **signed, time-limited watch link** (no persistent member
login exists, so access control rides on the same invite-link pattern already used for
group gating) → members watch via `hls.js` on `/watch/:token`. On stream end, MediaMTX's
on-unpublish webhook triggers `HandleStreamEnded` → recording uploaded to S3 →
`event.status = ended`, `recording_url` set → the same signed-link mechanism gates replay
access.

**Known scaling constraint**: a single self-hosted VPS realistically supports low hundreds
of concurrent HLS viewers (bandwidth/CPU bound). v1 ships single-quality passthrough (no
adaptive bitrate/transcoding) to keep load predictable — a deliberate MVP tradeoff.

## 9. Authentication

- **Creator**: email + password, JWT session (hashed with argon2/bcrypt).
- **Member**: no persistent account. Identity is the WA number captured at checkout;
  access to groups, live streams, and replays is granted via one-time or signed
  time-limited links sent over WA — consistent across all three gated surfaces.

## 10. Non-functional requirements

- **Security**: no card/payment data ever stored by our system — only Xendit references
  (`gateway_reference_id`); all inbound webhooks (Xendit, MediaMTX, Fonnte where
  applicable) are signature/secret-verified; stream keys are treated as secrets and
  rotated per session.
- **Reliability**: add/remove-member operations retry with backoff on messaging-API
  failure rather than failing silently.
- **Auditability**: every membership status change (join/upgrade/payment-failed/churned)
  and every live-session state change is written to `activity_log` with a timestamp.
- **Scalability (Fase 1 target)**: hundreds of communities, up to a few thousand members
  each — no need for enterprise-scale architecture yet; the live-streaming constraint in
  §8.5 is the one deliberate exception to flag to the user post-launch.

## 11. Testing strategy

- `bun test` for use-case unit tests, using fake adapters implementing each port (no real
  Xendit/Fonnte/Telegram/OpenRouter/MediaMTX calls).
- Integration tests for API routes and Drizzle repositories against a real test Postgres
  instance.
- Adapter contract tests mocked against recorded provider responses (Xendit webhook
  payloads, Fonnte send responses, Telegram Bot API responses, MediaMTX hook payloads).

## 12. Deployment

Docker Compose on the existing self-managed VPS, containers: `postgres`, `api`, `worker`,
`web` (static build served via nginx), `mediamtx`. Migrations run via Drizzle Kit as part
of deploy.
