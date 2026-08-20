# Task 7 — the webhook

**Commits:** `9fd1fbe` (implementation), `cdeeb94` (one mutation-driven test).
**Base:** `1b659cb`.

## What I built

`HandlePaymentWebhook.execute` now begins with a routing decision and nothing else:

```
routeInvoiceExternalId(external_id)
  usub_<uuid>  → settleUserSubscription   (new)
  <uuid>       → settleCommunitySubscription  (the old body, moved verbatim)
  anything else → IGNORED: one warn line, {activated:false, duplicate:false}, 200
```

`routeInvoiceExternalId` lives in `domain/user-payment.ts` — the module whose whole
purpose is this namespace — with its own unit tests. It is a pure function and runs
before a database is touched.

**The user path**, modelled step for step on the community one rather than re-derived:

1. `findTransactionById(uuid behind the prefix)`. Missing → `NotFoundError` ("unknown
   transaction", English, and the same message the community path uses so a caller
   cannot learn which namespace it missed in). Nothing recorded.
2. `gatewayReferenceId === null` → fail CLOSED (400). Task 6's `attachGatewayReference`
   is the anchor; without it `body.id` is checked against nothing.
3. `body.id !== gatewayReferenceId` → 400.
4. `input.amount !== transaction.amount` → 400 + `[security] webhook amount mismatch`.
   **Our record against their claim, never the reverse.** All four steps are before the
   unit of work opens, so a forged body cannot burn the event id a genuine delivery needs.
5. Inside ONE unit of work: `recordIfNew` → not new means return, touching nothing;
   non-`PAID` means record, warn, do nothing; `PAID` means re-read the transaction,
   check the pair's active slot, settle the transaction and activate the subscription.

`current_period_end` comes from a new `computeUserSubscriptionPeriodEnd`, which reuses
`computeNextBillingDate` for the month arithmetic (so the 31-Jan clamping and the refusal
to guess an unknown `billing_cycle` come for free) and keeps the payment's time of day,
because the column is a `timestamptz` and Phase 6 compares it against `now()` — starting
the last day at midnight UTC would cut hours off every cycle.

**No `activity_log` row and no outbox row.** Those are community concepts (a `member`, a
`community_id`, a Telegram invite). A user membership grants access by BEING active,
which is the single index hit spec §8 asks for. The community harness now hands the user
path throwing fakes and vice versa, so a leak in either direction is loud.

**Ports touched:** `PaymentActivationRepositories` gained `userSubscriptions` and
`userTiers` (additive; the community path never reads them), and
`DrizzlePaymentActivationUnitOfWork` constructs both against `tx`. The replay claim and
the activation it authorises must commit together — the identical reason `webhookEvents`
is already in that bag.

## The red phase

Domain first (`bun test src/domain/user-payment.test.ts` against stubs returning
`{kind:"unknown"}` and `new Date(0)`): **8 pass / 9 fail**, every failure on its own
assertion, e.g.

```
(fail) routeInvoiceExternalId > routes a bare uuid to the COMMUNITY handler, unchanged and unsliced
(fail) computeUserSubscriptionPeriodEnd > clamps to the last day of a short month instead of overflowing into the next one
    Expected: 2026-02-28T08:30:00.000Z
    Received: 1970-01-01T00:00:00.000Z
```

Then the handler, with `settleUserSubscription` stubbed to
`return { activated: false, duplicate: false }` so the file LOADED and each test failed
for its own reason: **45 pass / 25 fail**, e.g.

```
(fail) … > activates a user subscription when its invoice is PAID
    expect(received).toEqual(expected)
    Expected: {activated: true, duplicate: false}
    Received: {activated: false, duplicate: false}
(fail) … > refuses a payload claiming a different amount than our own record
    Expected function to throw, but it did not
(fail) … > is idempotent: the same PAID webhook twice activates once and extends the period once
```

(Full capture in the session scratchpad; the 45 that already passed against the stub —
the IGNORE tests, the "never touches the community tables" tests, the community
regression tests — were re-proved afterwards by mutation, below.)

## How I proved community invoices still resolve unchanged

- **The diff is purely additive in production code.** `git diff 1b659cb..HEAD` over
  non-test `.ts` files contains **zero deleted lines**. The community body did not move a
  character; it changed enclosing function only.
- The existing **38 unit tests** and **50 route tests** in `webhooks.test.ts` all use a
  bare-uuid `external_id`, so they are the regression suite, and they were run green
  BEFORE the user path was written (with the routing skeleton and the throwing user fakes
  already in place) and again after.
- Three new named tests: the external id reaches `findTransactionByExternalId`
  **verbatim**, the full call order is still
  `find → uow:begin → recordIfNew → markPaid → activity → outbox → uow:commit`, and an
  unknown bare uuid still 404s.
- One new route test delivers a user invoice and a community invoice down the same
  stream and asserts both activate, with the community side still writing exactly one
  `activity_log` row and one outbox row.
- The community harness hands `settleCommunitySubscription` user repositories that
  **throw on every method**, so a community invoice reaching into `user_subscription` or
  `user_tier` fails loudly rather than looking correct.
- Mutation M16 (route a bare uuid to the user handler) reddens **43 tests**, mostly the
  pre-existing community ones.

### The one behaviour change, stated plainly

An `external_id` that is **neither shape** (`haxx`, `1 OR 1=1`, `usub_x`) used to be
handed to the community lookup and answered **404**; it is now **IGNORED with a 200**.
Spec §7 and the brief both require this ("an unrecognised prefix is ignored, never
assumed to be either kind"; "not an error to throw on").

**It cannot affect a real invoice.** Every `external_id` this codebase has ever put on
the wire is a bare `transaction.id` uuid or `usub_<uuid>`, so a string matching neither
was never one of ours. An unknown **bare uuid** — the shape a real community invoice has
— still 404s, which is the case a provider should retry. The existing route test
`"404s an external id that is not even a uuid, rather than 500ing"` was rewritten rather
than deleted: it keeps its purpose (none of these 500) and now also asserts nothing at
all is written. This is the one line of the task I would want a second opinion on, and
the reasoning is in the test's own docstring.

## How I proved idempotency

- **Unit, statefully.** The user harness models the UNIQUE constraint: `recordIfNew`
  remembers ids, `markTransactionPaid` really settles, `activate` really activates. Two
  identical deliveries → `{activated:true}` then `{activated:false, duplicate:true}`,
  `activate` called once, `markTransactionPaid` called once, `current_period_end`
  unchanged.
- **A redelivery a month later** (clock advanced) still activates once and does not move
  the period — the failure that would silently hand a member a free extra cycle.
- **Route level, against the real database:** a replayed delivery leaves one
  `webhook_event` row and an unchanged `current_period_end`; **five concurrent
  deliveries** all return 200 and leave exactly one `webhook_event` row and one active
  subscription.
- **Found by mutation and fixed:** deleting the `recordIfNew` early return — the actual
  replay defence — left every one of those green, because the transaction-status check
  below it absorbed the second delivery and produced the same answer. That check is a
  second line of defence, not the defence. Commit `cdeeb94` adds a test that pins the
  guard by where the work STOPS: after two deliveries the transaction has been read three
  times (pooled + in-transaction for the first, pooled only for the second), not four.

## How I proved amount verification

Unit: a claim of 1 and a claim of 500,000 are both refused with
`"webhook amount does not match our record"`; nothing is recorded, `uow:begin` never
appears in the call order, and the check still runs for a non-`PAID` status. A log test
asserts the line contains `expected=50000 claimed=1` and does **not** contain the payer
email from the payload. Route level: 400, subscription still `pending`, transaction still
`pending`, zero `webhook_event` rows.

Mutant M1 (`amount !== amount` → `false`) reddens 4 unit tests and 2 route tests.

## A second PAID for a pair that is already active

Answered **200, never 500**. Inside the unit of work, before activating:
`findActiveFor(subscriberId, ownerId)`, excluding the row being activated (so a
redelivery against that row still works). When another subscription holds the pair's
active slot:

- the transaction is marked **paid** — the money arrived, and hiding it hides a refund
  that is owed, which 5a has no path for;
- the duplicate subscription is **cancelled** — nothing in 5a expires a pending
  `user_subscription`, and `user_subscription_one_pending` means one left behind would
  wedge that buyer out of that creator forever;
- one `[payments] ALERT` line with ids, the amount and nothing else;
- the event is **recorded**, so the provider stops retrying something no fix can resolve;
- returns `{activated:false, duplicate:false}` → 200.

**This read is the graceful path, not the guarantee** — the same division of labour
`markPaid` already records for the community flow. Under READ COMMITTED two concurrent
activations cannot see each other's uncommitted row, so both would pass it;
`user_subscription_one_active` is what arbitrates, and the loser's unit of work rolls
back with the event id unspent, so the provider's retry takes the graceful path above.
That is a bounded, self-healing 500 rather than a repeating one.

Proven at the route level against the real database and the real index: a first
membership is activated through the webhook, then a second payable invoice for the same
pair is planted directly (no route will now create one — `POST /subscribe` refuses an
active pair, which is the point) and delivered. Result: **200**, one active subscription,
the second `cancelled`, its transaction `paid`, two `webhook_event` rows.

## Test counts

| | before | after |
|---|---|---|
| `domain/user-payment.test.ts` | 8 | 17 |
| `application/use-cases/handle-payment-webhook.test.ts` | 38 | 71 |
| `routes/webhooks.test.ts` | 50 | 67 |
| **api suite** | **2314 pass / 0 fail** | **2373 pass / 0 fail** |

Typecheck clean (`tsc --noEmit`) at every commit. Full suite run before each commit.

## Mutation sweep (17 hand-applied mutants, all killed)

Run after the first commit, against the unit + domain files, and the five most
DB-dependent ones re-run against `routes/webhooks.test.ts` as well.

| # | mutant | killed by |
|---|---|---|
| M1 | amount comparison always passes | 4 unit + 2 route |
| M2 | replay guard deleted | **survived at first** → `cdeeb94`; now killed |
| M3 | `PAID` compared case-insensitively | "records but does not activate any status other than PAID" |
| M4 | already-active check dropped | 3 unit + 4 route |
| M5 | already-active refuses the row itself too | "still activates a subscription that is ITSELF the pair's active row" |
| M6 | superseded path stops cancelling | "releases the pending slot" |
| M7 | superseded path stops recording the money | "records the money as collected" |
| M8 | transaction-status guard dropped | 2 unit (route level has no such staging — expected) |
| M9 | invoice-id verification dropped | 1 unit |
| M10 | fail-closed on a missing reference dropped | 1 unit |
| M11 | period measured from wall-clock, not `paidAt` | 4 unit |
| M12 | billing cycle guessed as `monthly` | 2 unit |
| M13 | unknown ids fall through to the community handler | 1 unit + 2 route |
| M14 | a namespaced id treated as a community one | 32 |
| M15 | uuid guard behind the prefix dropped (the 500 vector) | 2 unit + 2 route |
| M16 | a bare uuid routed to the user handler | 43 |
| M17 | period loses the time of day | 9 |

## Things I am unsure about, or decided and want on the record

1. **The 404 → 200 change for a non-shape `external_id`** (above). Required by the spec
   and the brief; cannot touch a real invoice; but it is the one place I changed an
   assertion an earlier task wrote. If the reviewer disagrees, the fix is one branch.
2. **`PaymentActivationRepositories` grew two fields** rather than a second unit-of-work
   port being introduced. I chose the shared bag because there is exactly one transaction
   mechanism for "a payment landed", and a second one would be a second place for the
   record-then-activate ordering to drift. The cost is that the community path now carries
   two repositories it never reads.
3. **The already-active refusal is a read, not a constraint catch.** Absorbing the 23505
   properly needs a savepoint, which only the repository can open (`markPaid` does exactly
   that for the community flow). I did not add a `settlePaidTransaction` outcome method to
   `UserSubscriptionRepositoryPort` because the concurrent case degrades to one 500 that
   the provider's own retry then resolves gracefully — self-healing, and the same
   graceful-path/guarantee split the community handler already documents. If the reviewer
   wants the 500 gone entirely, the shape is `MarkPaidOutcome`'s.
4. **`markTransactionPaid` is still unconditional** (no `where status = 'pending'`). I
   convinced myself the read-then-write is safe here: two concurrent PAID deliveries for
   one transaction must share `provider_event_id` (`<invoice id>:<status>`), so
   `recordIfNew` arbitrates them at the database, and a delivery with a different invoice
   id is refused by the gateway-reference check. The in-transaction status re-read is
   defence in depth for a hand-reconciled row. Stated here because it is an assumption,
   not a proof.
5. **A `cancelled` subscription cannot reach activation** — I checked the reachable
   paths: the only route that cancels before payment is Task 6's failed-provider-call
   release, which leaves `gateway_reference_id` NULL, and that fails closed at step 2. Not
   guarded explicitly; noted rather than assumed away.
6. **Nothing here contacts Xendit**, and no dev server, port or browser was used.
