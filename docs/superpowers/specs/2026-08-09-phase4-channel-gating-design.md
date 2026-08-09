# Phase 4: Channel Gating — Design Spec

Date: 2026-08-09
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phase 1 (`d0904b8`), Phase 2 (`565d43a`), Phase 3 (`c78ad11`)

## 1. Purpose

Phase 3 made DIUDARA take money. **It does not yet deliver anything.** A member pays, their
subscription flips to `active`, and nothing grants them access to the community they bought.

Phase 4 closes that loop: a successful payment produces a single-use group invite, and a
creator can remove a member who should no longer have access. This is the phase that makes
the product's name true.

## 2. A PRD assumption that does not survive contact with the APIs

The PRD's Fase 1 flow assumes automated add/remove on **both** WhatsApp and Telegram.
Researched 2026-08-09:

**Telegram — fully supports it, via the official Bot API:**
- `createChatInviteLink` with `member_limit: 1` and an `expire_date` produces a genuinely
  single-use, short-lived link. Sharing it is pointless, which is exactly the PRD's
  "prevent non-payers using a leaked link" requirement.
- `banChatMember` removes a member and prevents rejoining via any invite link.
- `unbanChatMember` is **required before a returning member can rejoin** — a banned user
  cannot be re-invited. This matters for a churned member who later re-pays.

**WhatsApp — Meta's official Groups API cannot support this product:**
- There is a `DELETE /participants` endpoint and **no `POST /participants`**. You can remove
  a participant; you cannot add one.
- **Groups are capped at 8 participants.** The PRD targets creators with 50–2,000 audience
  members.
- Requires an Official Business Account (green tick).

Unofficial gateways (Fonnte and similar) drive a real WhatsApp account and *can* manage
normal groups — but that directly contradicts the PRD's own risk mitigation ("use official
APIs, avoid unofficial API/scraping techniques"), and a ban would take the **creator's**
WhatsApp account with it, not just ours.

### 2.1 Decision (ruled 2026-08-09)

- **Telegram gets full automated gating.** Single-use invites on payment, removal on
  revocation.
- **WhatsApp is notification-only.** Fonnte is used for what it is uncontroversially good
  at — sending the member a message. WhatsApp *group* access remains creator-managed in this
  phase.
- The `MessagingProviderPort` is shaped so a future real WhatsApp gating adapter is additive,
  not a rewrite.

This is a deliberate narrowing of the PRD, recorded here so it is not mistaken for an
oversight. It should be reflected back into the PRD.

## 3. Scope

**In scope:**
- `MessagingProviderPort` with three adapters: `TelegramBotAdapter` (gating),
  `FonnteWhatsAppAdapter` (notify only), `FakeMessagingAdapter` (drives all tests)
- **Outbox table + `apps/worker`** — the delivery mechanism (§4)
- `GrantChannelAccess` — issues a single-use Telegram invite, notifies via WhatsApp
- `RevokeChannelAccess` — removes from the Telegram group
- `channel_membership` — who currently has access, and the idempotency key
- An authenticated creator endpoint to revoke a member manually
- `activity_log` entries for grant and revoke

**Out of scope (with the phase that owns it):**
- **Automatic** churn-triggered revocation — **Phase 5** owns churn detection; this phase
  builds the capability and exposes it manually
- Real WhatsApp group add/remove (§2.1)
- Scheduled broadcast to all members
- Creator dashboard UI

## 4. The delivery mechanism: outbox + worker

The Phase 3 review was explicit: **the invite send must not join the payment activation
transaction.** It is an external HTTP call; inside `PaymentActivationUnitOfWork`, a Telegram
outage would roll back a paid activation.

So:

1. Activation writes an **`outbox`** row in the *same* transaction as the subscription
   activation. Atomic — if the payment lands, the intent to invite lands with it, and it can
   never be lost.
2. **`apps/worker`** polls the outbox and performs the send, with bounded retries and
   exponential backoff.
3. A provider outage **delays** invites; it never rolls back a payment, and never silently
   drops a paying member.

`apps/worker` is a new package. Phase 1's repo layout anticipated it but never built it —
Phase 5's recurring billing needs the same process, so this is shared groundwork.

### 4.1 Idempotency

The Phase 3 review proved duplicate `activity_log` "joined" rows are producible. So the
worker must **not** assume one row per activation:

- `channel_membership` has a **unique `(member_id, channel_id)`**. Granting is idempotent
  against that constraint — the database arbitrates, not a pre-check.
- Outbox rows are claimed with a conditional UPDATE so two workers cannot both send.
- Sending the same invite twice is a bug, not a cosmetic issue: it means two links for one
  member, either of which could be passed to a non-payer.

## 5. Schema changes

One generated Drizzle migration:

- **`outbox`** — `id`, `event_type`, `payload` (jsonb), `status`
  (`pending`/`processing`/`sent`/`failed`), `attempts`, `next_attempt_at`, `last_error`,
  `created_at`, `updated_at`.
- **`channel_membership`** — `id`, `member_id`, `channel_id`, `status`
  (`active`/`revoked`), `invite_link`, `granted_at`, `revoked_at`, with a **unique
  `(member_id, channel_id)`**.
- `channel` already has `external_group_id`, `invite_link`, and `bot_status` from Phase 1.

## 6. Architecture

### 6.1 `MessagingProviderPort`

```
capabilities(): { canGateAccess: boolean }
grantAccess(input): Promise<{ inviteLink: string }>
revokeAccess(input): Promise<void>
notify(input): Promise<void>
```

`capabilities()` is how WhatsApp's limitation is expressed **in the type system rather than
in a comment**. `FonnteWhatsAppAdapter` reports `canGateAccess: false`, and
`grantAccess`/`revokeAccess` throw `UnsupportedOperationError` rather than silently
succeeding. A silent no-op here would mean a member who paid appears to have been granted
access and was not — the worst failure mode in the phase.

### 6.2 Adapters

- `TelegramBotAdapter` — `createChatInviteLink` (`member_limit: 1`, `expire_date`),
  `banChatMember`, `unbanChatMember`. **Unverified against the live API** — no bot token
  exists yet, though unlike Xendit this one is free and instant to obtain, so verification
  should happen early.
- `FonnteWhatsAppAdapter` — `notify` only.
- `FakeMessagingAdapter` — records every call; drives all tests.

### 6.3 Use-cases

`GrantChannelAccess`, `RevokeChannelAccess`, `ProcessOutbox` (the worker's entry point).

## 7. Flow

**On payment (extends Phase 3's activation):**
1. `HandlePaymentWebhook` activates the subscription **and** writes an `outbox` row
   (`event_type: "grant_access"`) in the same transaction.
2. The worker claims the row, resolves the community's channels, and for each channel whose
   adapter reports `canGateAccess`, calls `grantAccess`.
3. `channel_membership` is created (unique on `(member_id, channel_id)`, so a retry is a
   no-op).
4. The member is notified via WhatsApp with the invite link.
5. `activity_log` records the grant.

**On manual revoke:**
1. Creator calls the authenticated endpoint for a member in a community they own
   (creator-scoped, 404 not 403 — the Phase 2 rule).
2. `RevokeChannelAccess` calls `revokeAccess`, sets `channel_membership.status = revoked`,
   writes `activity_log`.

Revocation is **synchronous** rather than outboxed: a creator removing someone expects to
know whether it worked, and there is no transaction to protect.

## 8. Security and correctness requirements

- **Invite links are single-use and expiring.** A link that outlives its use, or admits more
  than one member, defeats the product's entire purpose.
- **An invite link is a bearer credential.** It must never appear in a log line, an error
  message, or any API response other than the notification to the member who bought it.
  Phase 2 found argon2id hashes leaking through raw error logging; the same discipline
  applies.
- **`grantAccess` must never silently no-op.** An adapter that cannot gate must throw.
- **The worker must be idempotent** at the database level, not by pre-check.
- **Bounded retries.** A permanently failing row must end as `failed` with `last_error`, not
  retry forever.
- Bot tokens are secrets: environment only, no committed defaults, and the same
  `NODE_ENV` allowlist Phase 3 established (only `development`/`test` may relax; everything
  else including unset must throw).

## 9. Errors

| Condition | Result |
|---|---|
| Member/community not owned by caller | 404 |
| Channel's adapter cannot gate access | 409 (`UnsupportedOperationError`) |
| Telegram rejects the invite creation | outbox retry, then `failed` |
| Member already has active access | idempotent no-op |
| Revoking a member with no membership | 404 |

## 10. Testing

- Use-case unit tests with `FakeMessagingAdapter`
- Integration tests for the worker against real Postgres, including a **claim race** proving
  two workers cannot both send
- A test proving `grantAccess` on a notify-only adapter **throws** rather than no-ops
- A test proving an invite link never appears in a log or a response body
- Idempotency proven by mutation: remove the unique constraint reliance and a test must fail
- End-to-end: pay → outbox row → worker → membership + invite + notification

## 11. Carry-forward items to address here

From Phase 3's ledger:
- **`POST /payment-account`'s pre-provider-call window** — simultaneous requests mint
  orphaned Xendit sub-accounts. Three options were written up; pick one.
- **`markPaid`'s zero-row path** treats any non-`pending` status as "already settled" — fix
  before any phase writes `failed`.
- **Duplicate pending subscriptions** — decide which subscription is authoritative, because
  this phase is the first to act on one.
