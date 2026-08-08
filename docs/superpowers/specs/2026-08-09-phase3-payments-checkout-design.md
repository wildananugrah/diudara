# Phase 3: Payments & Checkout — Design Spec

Date: 2026-08-09
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phase 1 (merged, `d0904b8`) and Phase 2 (merged, `565d43a`)

## 1. Purpose

Phase 3 makes DIUDARA actually monetize. A member opens a creator's public checkout page,
picks a paid tier, pays with a local Indonesian method, and ends up with an active
subscription — with the money settling into the **creator's** account, never the platform's.

This is the product's core thesis. Everything before it was scaffolding.

## 2. The regulatory constraint that shapes everything

The PRD is explicit: the moment the platform receives or forwards member funds, it may fall
under Indonesia's *Penyelenggara Jasa Pembayaran* (PJP) regime and require a Bank Indonesia
licence. The mitigation is architectural, not procedural.

**Xendit xenPlatform** is how we satisfy it:

- Each creator becomes a Xendit **sub-account**.
- Invoices are created **on behalf of** that sub-account (`for-user-id`), with a
  **split rule** (`with-split-rule`) that routes DIUDARA's platform fee to the master
  account.
- Member funds settle into the **creator's** sub-account balance. DIUDARA never holds them;
  it only ever receives its own fee.

**This is a hard constraint, not a preference.** Any implementation that lands member funds
in a platform-owned account — even temporarily, even in development — is wrong and must be
rejected in review.

Note: a 100% split rule fails at settlement, because Xendit deducts transaction fees from
the remainder. Fee configuration must always leave a remainder.

## 3. Scope

**In scope:**
- `creator.xendit_account_id` and a payment-onboarding use-case (stubbed adapter — see §7)
- `PaymentProviderPort` with a Xendit adapter and a fake adapter
- Public checkout: `GET /c/:slug` data endpoint, `POST /c/:slug/checkout`
- Webhook endpoint with token verification, idempotency, and amount re-verification
- Subscription and transaction lifecycle up to **first successful payment**
- `activity_log` entries for payment events — the first real use of the audit table
- `apps/web`: a minimal Vite + React public checkout page and confirmation page

**Out of scope (with the phase that owns it):**
- Recurring renewal, retry schedule, churn detection — **Phase 5**
- WhatsApp/Telegram invite on successful payment — **Phase 4**
- Refunds and cancellation
- Real Xendit KYC sub-account onboarding (see §7)
- Creator dashboard UI — its own later phase

## 4. Decisions settled during brainstorming

| Question | Decision | Reason |
|---|---|---|
| Xendit access | No account yet — build against a fake adapter | Nothing blocks; swapping real keys is a config change |
| Checkout frontend | Backend + **minimal** page | A payment flow you cannot click through is not verifiable |
| Phase boundary | First payment only; subscription left `active` | Phase 5 owns renewal; `next_billing_date` already exists |
| Creator sub-accounts | Add the column, stub the onboarding | Real KYC fields cannot be confirmed without an account |

## 5. Schema changes

One generated Drizzle migration:

- `creator.xendit_account_id` — varchar, **nullable**. Null until payment onboarding
  completes. A creator without one **cannot** accept payments; checkout must reject this
  case explicitly rather than falling back to a platform account.
- **New table `webhook_event`** — `id`, `provider`, `provider_event_id` (unique),
  `event_type`, `payload` (jsonb), `processed_at`. Existence of a row means "already
  handled".

`subscription` and `transaction` already carry everything else from Phase 1
(`status`, `next_billing_date`, `started_at`, `gateway_reference_id`, `paid_at`,
`retry_count`, `last_attempt_at`).

## 6. Architecture

Follows the ports-and-adapters layering Phases 1-2 established.

### 6.1 `PaymentProviderPort`

```
createPaymentAccount(input): Promise<{ accountId: string }>
createInvoice(input): Promise<{ invoiceId, invoiceUrl }>
```

`createInvoice` takes the creator's `forAccountId`, our own `externalId` (the transaction
id), the amount, and the payer's details. The adapter is responsible for the on-behalf-of
and split-rule mechanics — the use-case must not know about them.

### 6.2 Adapters

- `XenditPaymentAdapter` — real API shapes. **Unverified against the live API** (§7).
- `FakePaymentAdapter` — drives every test; can simulate webhook delivery.

### 6.3 Use-cases

`CreatePaymentAccount`, `GetPublicCommunity`, `StartCheckout`, `HandlePaymentWebhook`.

### 6.4 Member identity

Members have no accounts. Identity is the WhatsApp number captured at checkout;
`StartCheckout` finds-or-creates by it. `member.whatsapp_number` is already unique.

## 7. Honest limitation: the Xendit adapter is unverified

Every other layer in this phase is genuinely tested against real Postgres and a fake
adapter that we control. **`XenditPaymentAdapter` is not**, because there is no account.

It is a best-effort transcription of Xendit's published API. Its request shapes, error
handling, and the exact split-rule mechanics are **assumptions until exercised against a
real sandbox**. Reviewers should not treat passing tests as evidence that it works — the
tests prove the port contract, not the integration.

**Before any real payment is accepted**, the adapter must be exercised against Xendit's
sandbox and this section removed.

## 8. Webhook security — the highest-risk surface

Xendit signs webhooks with a **static `X-CALLBACK-TOKEN` header**, not an HMAC of the
payload (verified against Xendit's documentation, 2026-08-09). This differs from Stripe-style
signing and has three consequences the implementation must handle explicitly:

1. **Constant-time comparison.** A naive `===` on the token leaks it byte-by-byte under
   timing analysis. Use a constant-time compare.
2. **No payload integrity.** The token authenticates the *sender*, not the *message*.
   Anyone holding the token can forge any event. Therefore the handler **must never trust
   amounts or statuses from the webhook body** — it looks up our own `transaction` by
   `external_id` and verifies the reported amount matches what we recorded. A mismatch is
   rejected and logged as a security event.
3. **Replay protection is ours to build.** `webhook_event.provider_event_id` is unique;
   a duplicate delivery is a no-op, never a second activation.

Additional requirements:
- The webhook route is **public** (no `requireAuth`) but must be excluded from any future
  CSRF or auth middleware by explicit intent, not by accident.
- Webhook failures must not leak internals. Phase 2's `errorHandler` already redacts, and
  its log-sanitisation must not regress here — Xendit payloads carry payer identifiers.

## 9. Checkout flow

1. Member opens `/c/:slug`. Frontend calls the public data endpoint: community name,
   description, and **active** tiers with prices. No auth. Nothing about the creator's
   revenue, members, or other communities is exposed.
2. Member picks a tier, enters name + WhatsApp number.
3. `POST /c/:slug/checkout` → find-or-create `member` → create `subscription`(pending) +
   `transaction`(pending) → `createInvoice` on behalf of the creator's sub-account →
   return the invoice URL.
4. Member pays on Xendit's hosted page.
5. Xendit POSTs the webhook → verified per §8 → transaction `success` + `paid_at`,
   subscription `active` + `next_billing_date` from the tier's billing cycle,
   `activity_log` entry written.
6. Member returns to a confirmation page that polls subscription status.

**Rejected explicitly at step 3:** a creator with no `xendit_account_id`, an inactive tier,
or an archived community.

## 10. Frontend (`apps/web`)

Minimal Vite + React app, no auth:
- `/c/:slug` — tier selection and payer details
- `/c/:slug/status/:subscriptionId` — post-payment confirmation, polls until active

Mobile-first, since these links are shared into WhatsApp. Imports request/response types
from `packages/shared`. Deliberately unstyled beyond basic legibility — polish belongs with
the dashboard phase.

## 11. Errors

| Condition | Status |
|---|---|
| Unknown slug, archived community | 404 |
| Inactive/unknown tier | 404 |
| Creator not payment-onboarded | 409 |
| Validation failure | 400 |
| Webhook: bad/missing token | 401 |
| Webhook: unknown `external_id`, or amount mismatch | 404 / 400, logged |
| Webhook: already processed | 200 (idempotent no-op) |

## 12. Testing

- Use-case unit tests with the fake payment adapter
- Integration tests for checkout and webhook routes against real Postgres
- **Webhook security tests are mandatory**: wrong token, missing token, replayed event,
  amount mismatch, unknown external id
- A test proving funds are never routed to a platform account — i.e. `createInvoice` is
  always called with the creator's `forAccountId`
- Frontend: enough to prove the page renders tiers and posts checkout correctly

## 13. Carry-forward items to address here

From Phase 2's ledger, these land naturally in this phase:
- `subscription`/`transaction` gain their first writers — add the `updated_at` trigger or
  set it in the adapters (currently it would freeze at creation)
- Extract the duplicated `assertOwnsCommunity` helper if a third copy appears
