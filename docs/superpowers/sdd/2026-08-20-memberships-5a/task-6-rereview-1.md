# Task 6 fix round 1 — re-review

Reviewed: `3aa98f5..e71c156` (`bc876e6`, `e71c156`) on `feat/memberships`, worktree
`.worktrees/memberships`. Inputs: `task-6-review.md`, `task-6-report.md` (fix round appended),
`review-3aa98f5..e71c156.diff`.

## Verdict: all three findings ADDRESSED

## F1 (Important) — `payerWhatsappNumber` sent as `""`: **ADDRESSED**

- `CreateInvoiceInput.payerWhatsappNumber` is now `payerWhatsappNumber?: string`
  (`payment-provider.port.ts`), with a docstring stating absence — never `""` — is "no number".
- `StartUserSubscription.execute` spreads the field in only when `subscriber.whatsappNumber !==
  null` (`start-user-subscription.ts`).
- `XenditPaymentAdapter.createInvoice` builds `customer` with `mobile_number` included **only**
  when `payerWhatsappNumber` is defined and non-empty — by explicit conditional spread, not by
  relying on `JSON.stringify` dropping `undefined`.
- **`mobile_number` is genuinely ABSENT from the provider payload, not present-and-empty.** Verified
  at the adapter, not just the use case: `xendit-payment.adapter.test.ts`'s "OMITS mobile_number
  entirely for a payer with no number..." asserts `"mobile_number" in customer` is `false` — key
  absence, the strong assertion, not `mobile_number === undefined`. The use-case test mirrors this
  at its own layer: `"payerWhatsappNumber" in payments.invoices[0]!` is `false`.
- **Mutation confirmed live.** Reverted the adapter's conditional spread to the old unconditional
  `mobile_number: input.payerWhatsappNumber` and reran: `XenditPaymentAdapter.createInvoice >
  OMITS mobile_number entirely for a payer with no number, rather than sending an empty string`
  reddens (`toEqual` fails, received `{ given_names: "Siti", mobile_number: "" }`). Reverted with
  `git checkout --`.
- The community checkout path is untouched — `startCheckoutSchema` still requires a number, and a
  required `string` still satisfies the widened `string | undefined` port field.

## F2 (Important) — two taps, two live invoices: **ADDRESSED** (with a residual gap under real concurrency — see "New finding" below)

- **Reuse mechanism.** `user_transaction.gateway_invoice_url` (migration `0027_cloudy_the_call.sql`)
  is written in the same statement as `gateway_reference_id`
  (`attachGatewayReference(transactionId, gatewayReferenceId, invoiceUrl)`).
  `findPendingCheckout(subscriberId, ownerId)` joins the pair's `pending` subscription to a
  `pending` transaction with a non-null invoice url, newest first, and hands the row back. The use
  case calls it after `findActiveFor`'s refusal and before any write; on the same tier it returns
  the stored `invoiceUrl` verbatim with **no new rows and no provider call**; on a different tier
  it throws `ConflictError` in Bahasa.
- **Second start creates no second row, no second provider call — mutation confirmed.** Reverted
  `if (pending)` to `if (false && pending)` in `start-user-subscription.ts` and reran: both new
  use-case tests redden — `"hands back the invoice already waiting, and creates NO second
  subscription or transaction"` (`second` no longer equals `first`; a second subscription/
  transaction/invoice is created) and `"REFUSES a DIFFERENT tier while an invoice is pending, in
  Bahasa..."` (`buy` no longer rejects). 4 failures total including HTTP-level collateral.
  Reverted with `git checkout --`.
- **The returned URL is the stored one from the first attempt** — asserted directly:
  `findPendingCheckout` test expects `invoiceUrl: "https://pay.test/inv-1"` (the value written by
  the first `attachGatewayReference` call), and the use-case "hands back the invoice already
  waiting" test asserts `second` (from the second `buy()`) `toEqual(first)` byte-for-byte,
  including `invoiceUrl`.
- **The `isNotNull(gatewayInvoiceUrl)` predicate is genuinely load-bearing — mutation confirmed.**
  Dropped it from the repository's `where(...)` clause and reran
  `drizzle-user-subscription.repository.test.ts`: `"findPendingCheckout returns the LIVE invoice
  even when a NEWER transaction never got one"` (added in `e71c156`) reddens — 16 pass, 1 fail,
  the mutant returns `null` instead of the older transaction's live invoice, which is exactly the
  scenario where a second invoice would get minted while the first is still payable. This confirms
  `e71c156`'s stated purpose: it kills a mutant `bc876e6`'s own suite let survive. Reverted.
- **Migration `0027_cloudy_the_call.sql` is additive and nullable.** Read directly:
  `ALTER TABLE "user_transaction" ADD COLUMN "gateway_invoice_url" varchar(512);` — one statement,
  no `NOT NULL`, no default, touches only `user_transaction`. `_journal.json` records it as entry
  `idx: 27` following `0026_brief_richard_fisk`, sequential and additive. No pre-existing table
  (`community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`) is in the
  diff at all.
- **A pending row whose provider call failed does not block a fresh attempt** — asserted:
  `"a pending row whose provider call FAILED does not block a fresh attempt"` fails the first
  invoice (`failNextInvoice = true`), then succeeds on retry with 2 transaction rows but exactly 1
  invoice at the provider.

## F3 (Minor) — 500 on the webhook from junk ids: **ADDRESSED**

- `DrizzleUserSubscriptionRepository` now guards `findById`, `findTransactionById`, `findActiveFor`,
  `attachGatewayReference`, and `findPendingCheckout` with the same `UUID_PATTERN` regex the
  community repository uses; a shape-check miss returns `null`/`false` before the query runs.
- **Both `""` and `"x"` (the exact outputs of `userTransactionIdFromExternalId("usub_")` and
  `("usub_x")`) resolve without throwing** — the repository test loops
  `["", "x", "usub_", "not-a-uuid", "00000000-0000-4000-8000-00000000000"]` through all four
  public reads and asserts `null`/`false`, never a throw.
- **Mutation confirmed.** Removed the `UUID_PATTERN` guard from `findTransactionById` and reran:
  `"answers null — never throws — for an id that cannot be a uuid at all"` reddens with the exact
  failure mode the original review predicted — `PostgresError: invalid input syntax for type
  uuid: ""` (`code: "22P02"`), thrown at the driver rather than caught. Reverted with
  `git checkout --`.

## The known gap (invoice expiry) — accurately described, and does not reopen F2 by itself

The report's claim: no expiry is tracked, so once Xendit's invoice expires (~24h) a re-tap hands
the buyer a dead payment page, and 5a has no path to mint a fresh one. Confirmed:

- `gateway_invoice_url` is only ever set once (write-once via
  `and(eq(id, transactionId), isNull(gatewayReferenceId))`) and only cleared implicitly by the
  transaction leaving `pending` status (paid/activated) — nothing expires it, nothing re-mints it.
- `findPendingCheckout` filters on `subscription.status = 'pending' AND transaction.status =
  'pending'` — a `cancelled` subscription (verified: `"findPendingCheckout ignores a subscription
  that is no longer pending"`, which actually tests the *active* case, not `cancelled` directly —
  see below) is excluded by the status predicate regardless of what URL sits on its transaction, so
  a dead or already-settled URL is never handed back once the subscription has moved off `pending`.
- **Gap in the disclosed test coverage, not in the code**: the repository suite proves
  `findPendingCheckout` excludes a subscription that reached `active` (paid) but has no test that
  builds a `cancelled` subscription with a still-non-null `gateway_invoice_url` and confirms it is
  excluded too. Reading the query directly, the `eq(userSubscriptions.status, "pending")` predicate
  covers `cancelled` identically to `active` — both are `!== "pending"` — so the code is correct,
  it is simply unproven by a `cancelled`-specific test. Minor, does not change the verdict.

## New finding — a genuine concurrency race still mints two live invoices

**Not disclosed in the report.** The second-tap guard is read-then-write with no transactional
isolation and no DB-level constraint on `pending` rows (the schema's only relevant unique index,
`user_subscription_one_active`, is scoped to `status = 'active'` — confirmed by reading
`db/schema.ts:1014`). Two requests that both reach `findPendingCheckout` before either has written
its `pending` row will both see nothing pending and both proceed to create a subscription, a
transaction, and call the provider.

Reproduced directly against the real (test) database, at the HTTP layer, with no repository
mutation: fired two concurrent `POST /users/wildan/subscribe` requests for the same buyer/tier via
`Promise.all`. Four of five runs serialized cleanly (1 invoice), but the fifth produced **two**
live invoices, two `user_subscription` rows, and two `user_transaction` rows for the identical
(subscriber, owner, tier) — i.e. the exact double-charge scenario F2 exists to prevent, reachable
without any test mutation, on stock `e71c156`. Reproduction script was written to a scratch file,
executed, and deleted afterward (`git status` confirmed clean before and after).

This does not make F2 NOT ADDRESSED — the finding as scoped in the original review ("two taps... a
back-button retry") describes the sequential case, which the reuse mechanism closes completely and
provably (verified above). But the task's own instruction to verify "no path where a second live
invoice can still be created" is not fully true under genuine request concurrency (double-click,
a client-side retry fired before the first response lands, or two browser tabs). Worth a follow-up
— e.g. a partial unique index on `(subscriber_id, owner_id) WHERE status = 'pending'` mirroring
`user_subscription_one_active`, or wrapping the read-then-write in `SELECT ... FOR UPDATE` /
a serializable transaction — before this ships against live Xendit, since 5a still has no refund
path.

## Also verified

- **No new breakage.** `bun run typecheck` clean. Full covering-file run:
  `start-user-subscription.test.ts`, `xendit-payment.adapter.test.ts`,
  `drizzle-user-subscription.repository.test.ts`, `users.test.ts`, `bootstrap.test.ts` — 353 pass,
  0 fail (73.9s). The one `unhandled error: Error: fake payment provider: createInvoice failed`
  line is the deliberate provider-failure test's sanitised `console.error`, same as the original
  review noted.
- **`/dashboard/*` and the shared webhook/checkout use cases untouched.**
  `git diff 3aa98f5..e71c156 --stat` over `routes/dashboard.ts`, `start-checkout.ts`, and
  `handle-payment-webhook.ts` is empty. No pre-existing table (`community`, `membership_tier`,
  `member`, `subscription`, `transaction`, `creator`) appears anywhere in the diff.
- **No test contacts Xendit.** Every test uses `FakePaymentAdapter`; unchanged from the original
  review's finding, and nothing in this fix round introduces a real adapter call.
- **Tests assert literals, not the constants they check.** The Bahasa conflict sentence is spelled
  out in full in both the use-case and HTTP test files rather than imported; ids/urls/amounts are
  concrete values (`"https://pay.test/inv-123"`, `"inv-123"`, `50_000`), not re-derived from the
  production code under test.

## Hygiene

Four mutations applied during this re-review, each reverted with `git checkout --` immediately
after observing the red result: the adapter's conditional customer spread, the use case's
`if (pending)` guard, the repository's `isNotNull(gatewayInvoiceUrl)` predicate, and the
repository's `UUID_PATTERN` guard on `findTransactionById`. One scratch test file
(`src/routes/__concurrency_scratch.test.ts`) was created to reproduce the concurrency race, run
five times, and deleted. Final `git status --short` is empty; `git status` reports "nothing to
commit, working tree clean". `.superpowers/` is gitignored; this report was written there without
force-adding anything.
