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

### 4.2 The credential-lifecycle invariant

> **At most one live invite link per `(member, channel)` may exist at the provider at any
> time, and every link that exists is recorded in `channel_membership.invite_link`.**

Added after the final whole-branch review (2026-08-09). §4.1 above was stated as a property
of **our database** — one membership row, one link — and that is not the same property, so
the implementation satisfied §4.1 while leaking credentials. Both halves of the invariant
above are load-bearing, and the **second** is the one §4.1 never said:

- An **unrecorded** link is worse than a duplicate we know about. It is a bearer token for a
  paid group that the system cannot revoke, cannot attribute to a joiner (the `chat_member`
  webhook resolves it to `unknown_invite_link`, so no `external_member_id` is ever
  captured), and therefore can never remove from the group.
- Telegram's `revokeChatInviteLink` takes the link's **value**, and no Bot API method
  enumerates the links a bot created. A link whose value we lost is **unkillable**. This
  asymmetry is why the rules below are shaped the way they are.

**What was measured against the pre-fix implementation**, counting links at the provider
rather than rows in the database:

| Scenario | Live links at provider | Membership rows |
| --- | --- | --- |
| `recordGrant` fails after a successful mint, across the full 5-attempt retry bound | **5** (one per attempt, all single-use, all valid 24h, **none recorded**) | 1, with `invite_link = NULL` |
| Two concurrent grants for one `(member, channel)` | **2**, both delivered to the member | 1 |

The leak scaled linearly with `maxAttempts`. The whole suite passed throughout.

**The rules this imposes.** No one of them is sufficient; the first two were absent entirely.

1. `MessagingProviderPort` must expose **`revokeInviteLink`**. Without a way to unmint, a
   `recordGrant` that fails after a successful mint can only leak.
2. A **mint marker** (`channel_membership.link_minted_at`) must be written **in the same
   statement as the claim**. `invite_link IS NULL` on a claimed row otherwise conflates
   three states — nobody has minted, somebody is minting, somebody minted and lost it — and
   reading all three as "finish the grant" is what produced the table above.
3. Marker set with no link means **a link MAY be live and unrecorded, so do NOT mint
   another**. This **fails closed**: it is reported as `manual` with an `activity_log`
   reason for a deliberate reissue. A caller that died between the claim and the provider
   call lands here too, and a spurious manual reissue is the correct price for never
   issuing a second key.
4. `mint_lease_until` **classifies** the excluded caller — live lease → retryable "grant in
   progress", lapsed lease → fail-closed "minted and lost". It does **not** provide the
   mutual exclusion; rule 2 does, because the marker is written in the claim itself and the
   second caller's `DO UPDATE` predicate is re-evaluated against the locked tuple. (An
   earlier version of this spec and of the column's docstring credited the lease with
   serialisation. The re-review demonstrated otherwise, and a misleading invariant note is
   how the next person removes the wrong guard.)
4b. **The marker must be RELEASED when nothing can have been minted**, and that requires the
   adapter to say whether **a response was received**. A `grantAccess` that fails with an
   HTTP response — a Telegram `ok: false`, any non-2xx — minted nothing, so
   `link_minted_at` and `mint_lease_until` go back to NULL and the retry mints normally.
   Only a request that **never completed** (abort, timeout, process death) or completed
   unreadably keeps the marker.

   This is not a refinement; without it the invariant's own enforcement becomes the outage.
   Measured with the marker always kept, one transient provider failure followed by a
   perfectly healthy provider: 5 retries, outbox `failed`, **0 links minted, 0 WhatsApp
   messages, 0 `activity_log` rows**, and three further `execute` calls that minted
   nothing — a paying member permanently ungrantable, silently, with no reissue tool. The
   distinction is carried by a **typed error** (`ProviderCallError.outcome`), never sniffed
   from a message string, and anything unclassified is treated as ambiguous so fail-closed
   is reached by *not knowing*.
5. `recordGrant` must be **conditional on `invite_link IS NULL`** and report whether it
   recorded. A loser that overwrites the winner's link orphans a credential that has
   already reached a member.
6. Revocation must **revoke the link at the provider too**. `revoke` nulls
   `invite_link` — correctly, a revoked row must not carry a live credential — so without
   this an unused link goes on admitting whoever holds it, unrecorded, until it expires.
   `member_limit: 1` does not help a link nobody used, which is exactly the never-joined
   case.

**Testing consequence.** A test of this invariant must count **links minted at the
provider**, not memberships in the database. `expect(memberships).toHaveLength(1)` is not
evidence: it passed against four live unrevocable credentials. See §10.

## 5. Schema changes

One generated Drizzle migration:

- **`outbox`** — `id`, `event_type`, `payload` (jsonb), `status`
  (`pending`/`processing`/`sent`/`failed`), `attempts`, `next_attempt_at`, `last_error`,
  `created_at`, `updated_at`.
- **`channel_membership`** — `id`, `member_id`, `channel_id`, `status`
  (`active`/`revoked`), `invite_link`, `granted_at`, `revoked_at`, with a **unique
  `(member_id, channel_id)`**. Plus, from the final review (see §4.2):
  `external_member_id` (the platform user id `banChatMember` needs, learned at join
  time), `link_minted_at` (the mint marker) and `mint_lease_until` (the per-membership
  mint lease). A partial unique index on `invite_link` keeps the credential an
  unambiguous lookup key.
- `channel` already has `external_group_id`, `invite_link`, and `bot_status` from Phase 1.
  **`POST /communities/:id/channels` now requires a NUMERIC `external_group_id` for
  `platform: "telegram"`** — a tightening of an existing endpoint, with a validation
  message naming the numeric chat id. Telegram accepts `@channelusername` as a `chat_id`,
  so such a channel granted access perfectly; but the inbound `chat_member` update carries
  `chat.id` as a **number**, and §4.2's chat-scoped membership lookup then never matches.
  Measured: stored `@kelasbudi`, update with `-1001234567890` → `unknown_invite_link`,
  `external_member_id` stays NULL, and every revocation for that community reports
  `no_provider_member_id_recorded` **forever** — a log line documented as ordinary noise.
  Members grantable and never removable, with nothing to notice. Normalising instead would
  need a `getChat` round-trip from a shared validation schema; constraining at the door
  tells the creator while they can still go and find the right id. WhatsApp is untouched
  (`120363…@g.us`, and `canGateAccess` is false, so nothing inbound is matched).

## 6. Architecture

### 6.1 `MessagingProviderPort`

```
capabilities(): { canGateAccess: boolean }
grantAccess(input): Promise<{ inviteLink: string }>
revokeInviteLink(input): Promise<void>      // see §4.2 — required, not optional
revokeAccess(input): Promise<void>
notify(input): Promise<void>
```

`revokeInviteLink` is what makes §4.2's invariant enforceable at all: minting is an HTTP
call and recording is a separate database write, so there is a window in which a credential
exists and our record does not, and without a way to **unmint** that window can only be
closed by leaking. It throws `UnsupportedOperationError` on a notify-only adapter, exactly
like `grantAccess`.

`capabilities()` is how WhatsApp's limitation is expressed **in the type system rather than
in a comment**. `FonnteWhatsAppAdapter` reports `canGateAccess: false`, and
`grantAccess`/`revokeAccess` throw `UnsupportedOperationError` rather than silently
succeeding. A silent no-op here would mean a member who paid appears to have been granted
access and was not — the worst failure mode in the phase.

### 6.2 Adapters

- `TelegramBotAdapter` — `createChatInviteLink` (`member_limit: 1`, `expire_date`),
  `revokeChatInviteLink`, `banChatMember`, `unbanChatMember`. **Unverified against the live
  API** — no bot token
  exists yet, though unlike Xendit this one is free and instant to obtain, so verification
  should happen early.
- `FonnteWhatsAppAdapter` — `notify` only.
- `FakeMessagingAdapter` — records every call; drives all tests.

### 6.3 Use-cases

`GrantChannelAccess`, `RevokeChannelAccess`, `RetryChannelAccessRevocation` (the worker's
`revoke_access` handler, added by the final review — see §9), `ProcessOutbox` (the worker's
entry point).

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
| **Telegram rejects the invite creation (a response was received)** | **mint window released — nothing was minted — then outbox retry, which mints cleanly** |
| **The invite request never completed (timeout/abort), or answered unreadably** | **marker kept; later attempts report `mint_lost` for a deliberate reissue** |
| **A telegram channel connected by `@username` instead of a numeric chat id** | **400 at connect time, naming the numeric id** |
| Member already has active access | idempotent no-op |
| Revoking a member with no membership | 404 |
| **Member already holds an active subscription to this tier** | **409, BEFORE the invoice is created** |
| **A concurrent grant holds the mint lease** | **reported, outbox retry — never a second mint** |
| **A link was minted and could not be recorded** | **revoked at the provider; window reopened for a clean retry** |
| **…and the revoke also failed** | **reported `manual` (`invite_link_minted_but_not_recorded`); no replacement ever minted** |
| **Provider removal fails during revocation** | **membership still revoked, `revoke_access` outbox row enqueued, bounded retry** |
| **A removal that can never be automated** | **`revocation_manual_required` in `activity_log`; not retried** |

Three of these were added by the final whole-branch review, and two are worth stating as
decisions rather than table rows:

- **Re-paying for a tier you already hold is refused before any money moves.** It used to be
  charged, then `superseded` on activation: the subscription was `cancelled`, no outbox row
  was enqueued so **no message was sent at all**, and the status page read `cancelled`. Money
  in, nothing out, member never told — and re-paying is exactly what someone does when the
  invite did not arrive. The `superseded` path remains as the backstop for the genuine race.
- **Revocation is synchronous but a failed platform removal is not dropped.** The creator is
  still told `automated: false` immediately, because they are waiting for an answer. The
  outstanding removal becomes a `revoke_access` outbox row so the person actually leaves the
  group. Without it a churned member stays in the paid group forever with no durable record
  that a removal is owed — which is what Phase 5's churn job would have inherited.

## 10. Testing

- Use-case unit tests with `FakeMessagingAdapter`
- Integration tests for the worker against real Postgres, including a **claim race** proving
  two workers cannot both send
- A test proving `grantAccess` on a notify-only adapter **throws** rather than no-ops
- A test proving an invite link never appears in a log or a response body
- Idempotency proven by mutation: remove the unique constraint reliance and a test must fail
- End-to-end: pay → outbox row → worker → membership + invite + notification
- **Grant idempotency must be tested as a CONCURRENT property, and by counting links minted
  AT THE PROVIDER** (added by the final review). Two specific cases, neither of which
  existed and both of which failed when written:
  1. `recordGrant` failing across the **full retry bound** — 5 live links before the fix,
     0 after.
  2. **Two concurrent** `execute` calls for one `(member, channel)`, with the interleaving
     **forced** rather than raced — 2 live links before, 1 after. Written first as two bare
     concurrent calls, this PASSED against the broken code because the scheduler happened
     to order them safely; a concurrency test that depends on the scheduler proves nothing.
- A test proving a link that cannot be recorded is **revoked at the provider**, and that
  when that cleanup ALSO fails no replacement is ever minted on top of the orphan.
- **A fail-closed guard needs a test for the RECOVERY case too, not only the refusal**
  (added by the scoped re-review, which found rule 4b missing). The two must be a pair, and
  each fails against the other's implementation:
  1. `grantAccess` failing **with a response received** on the first attempt and succeeding
     on the second → exactly **1 live link**, a granted membership, the member notified.
     Before rule 4b: 0 minted, outbox `failed`, 0 notifications, marker still set.
  2. `grantAccess` failing with **no response** → marker retained, **no second mint** on any
     later attempt, reported as manual.

  The general lesson: a guard that refuses to act is only correct if the path back is
  tested. Asserting only that nothing bad happened cannot distinguish "safe" from "broken".
- **A concurrency barrier must be CAUSAL, not temporal.** The forced-interleaving test above
  originally released its first caller after a 250 ms timeout whether or not the second had
  claimed, so on a slow database it could pass **vacuously** without the race occurring. It
  now counts completed `claim` calls, and its safety timeout **rejects** rather than
  releasing.

## 11. Carry-forward items to address here

From Phase 3's ledger:
- **`POST /payment-account`'s pre-provider-call window** — simultaneous requests mint
  orphaned Xendit sub-accounts. Three options were written up; pick one.
- **`markPaid`'s zero-row path** treats any non-`pending` status as "already settled" — fix
  before any phase writes `failed`.
- **Duplicate pending subscriptions** — decide which subscription is authoritative, because
  this phase is the first to act on one.
