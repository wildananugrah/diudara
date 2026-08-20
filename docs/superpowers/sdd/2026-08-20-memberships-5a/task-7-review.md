# Task 7 review — routing user-subscription invoices through the payment webhook

**Range:** `1b659cb..cdeeb94` (`9fd1fbe` implementation, `cdeeb94` mutation-driven test)
**Reviewed at:** worktree `/home/wildandev/repo/diudara/.worktrees/memberships`, branch `feat/memberships`

## Verdicts

1. **Spec compliance (§7): ✅**
2. **Task quality: approved.** No Critical, no Important. Three Minor notes, all
   already on the implementer's own record; none blocks the merge.

---

## THE QUESTION: can anything here change what happens to a community invoice?

**No — and this is the strongest form of that answer available: the community body is
byte-identical and the set of external ids whose behaviour changed is provably disjoint
from the set that could ever match a community transaction row.**

### 1. Zero deletions in the production file — verified independently

`git diff --numstat 1b659cb..cdeeb94` per file:

| file | deletions |
|---|---|
| `application/use-cases/handle-payment-webhook.ts` | **0** |
| `application/ports/payment-activation-unit-of-work.port.ts` | 0 |
| `infrastructure/repositories/drizzle-payment-activation.unit-of-work.ts` | 0 |
| `bootstrap.ts` | 0 |
| `domain/user-payment.ts` | 0 (new file) |
| `routes/webhooks.test.ts` | 4 (test) |
| `application/use-cases/handle-payment-webhook.test.ts` | 1 (test) |

Every deleted line in the whole range is in a test file. The claim holds.

The mechanism is worth naming, because "zero deletions" for a moved body is otherwise
suspicious: the old `async execute(...)` signature line was **kept** and became the new
`execute`'s; a new `private async settleCommunitySubscription(...)` signature was
**inserted** immediately above the old body. Both methods sit at the same indentation, so
the body did not need to move a column. That is why the move cost nothing.

### 2. The moved body is genuinely unchanged, not "unchanged apart from"

Checked mechanically rather than by eye:

```
git show 1b659cb:.../handle-payment-webhook.ts  lines 117-378  (old execute body → EOF)
HEAD          .../handle-payment-webhook.ts  lines 403-664  (settleCommunitySubscription body → EOF)
diff → IDENTICAL
```

262 lines, byte-for-byte. Not one comment, guard, or ordering changed.

### 3. Mutation, both directions

| mutation | unit result | route result |
|---|---|---|
| **user** amount check → `input.amount !== input.amount` | 4 fail, **all in the user describe block**; 0 community tests red | 2 fail, both in `POST /webhooks/xendit — user subscriptions`; 0 community tests red |
| **community** amount check → `input.amount !== input.amount` | 3 fail, **all community**; 0 user tests red | (not needed) |

Isolation is bidirectional and pinned by named tests in both directions.

### 4. The routing set-difference argument (stronger than the implementer's)

The implementer argued from what we mint. There is a tighter argument, and it makes the
change airtight rather than merely likely-safe:

`DrizzleSubscriptionRepository.findTransactionByExternalId` (line 560) has **always**
opened with

```ts
if (!UUID_PATTERN.test(id)) return null;
```

with `UUID_PATTERN` byte-identical to the one `domain/user-payment.ts` now uses (verified:
both are `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, and the same
literal appears in six other repositories).

So the set of `external_id`s that changed answer is **exactly** `{ not a uuid } \ { usub_<uuid> }`
— and every member of that set *already* returned `null` from the community lookup and
therefore *already* 404'd on a row it could never have found. The change is 404 → 200 on a
set that was, by construction, incapable of resolving to a transaction.

---

## Ruling 1 — the 404 → 200 change. **Your reasoning holds; here is the tightened version.**

> *"Is there any id shape a real Xendit invoice could carry that now takes the ignore path
> when it previously 404'd?"*

**No.** Three independent reasons, in increasing order of strength:

1. **Minting.** Exactly two `createInvoice` call sites exist in the codebase
   (`start-checkout.ts:146` → `externalId: transaction.id`, and
   `start-user-subscription.ts:213` → `userSubscriptionExternalId(transaction.id)`).
   `transaction.id` and `user_transaction.id` are both
   `uuid("id").primaryKey().defaultRandom()` (`db/schema.ts:437`, `:1044`), so both wire
   shapes are canonical lowercase-hyphenated uuids. There is no third minting path —
   `renewal-payment` has no use-case file and creates no invoices.
2. **Set difference** (§4 above): the diverted set could never have matched a row anyway.
3. **The alternate-uuid-form worry is closed twice over.** Postgres accepts braces,
   omitted hyphens, and odd hyphen placement as `uuid` input, so in principle
   `{<uuid>}` or a 32-hex string could once have matched a row. It could not: the
   repository's own `UUID_PATTERN` rejected those *before* the query, so they 404'd then
   and are ignored now — same outcome class, no invoice touched.

I exercised the router directly over the edge shapes:

```
""                                        -> unknown
"usub_"                                   -> unknown
"usub_x"                                  -> unknown
"haxx" / "1 OR 1=1"                       -> unknown
"<uuid>"                                  -> community  (unsliced, verbatim)
"USUB_<uuid>"                             -> unknown     (prefix is case-SENSITIVE — correct, we never mint it)
"<uuid>" minus a digit / braces / no hyphens -> unknown
" <uuid> " / "<uuid>\n"                   -> unknown  (moot: requireString trims before routing)
"usub_<uuid>"                             -> user
"usub_usub_<uuid>"                        -> unknown
```

Note the asymmetry that matters and is right: the **prefix** match is case-sensitive
(we mint only lowercase `usub_`), while the **uuid** match is case-insensitive (Postgres
accepts either case for a uuid we really minted). Both choices are documented in the
source.

**Additional check the implementer did not claim:** an unknown *bare uuid* still 404s —
pinned by `routes/webhooks.test.ts:855` `"rejects an unknown external id with 404"`, which
survives unedited. The rewritten test at `:877` keeps its original purpose (none of these
500) and adds that nothing at all is written.

---

## Ruling 2 — the concurrent double activation. **Verified empirically. It genuinely self-heals.**

Your ruling was reasoning; I turned it into measurement. I staged a real race at the route
level against the real database and the real partial unique index — two subscriptions for
one `(subscriber, owner)` pair, each with a pending transaction and a distinct
`gateway_reference_id`, two `POST /webhooks/xendit` deliveries fired through
`Promise.all` — and repeated it over **10 clean rounds**.

**9 of 10 rounds produced a genuine race.** Every one of them:

```
r1: A=500 B=200  events=1          <- loser 500s; only the WINNER's webhook_event row exists
r1: LOSER events-before-retry=1    <- the loser's event id was rolled back with its unit of work
r1: retry=200                      <- the redelivery takes the graceful path
r1: subs=["active","cancelled"]  txs=["paid","paid"]  events=2
```

The one non-racing round serialised naturally and reached the same end state via the
graceful read.

**Every round, without exception, ended at:**

- **exactly one `active` subscription** for the pair, the other `cancelled`;
- **both transactions `paid`** — correct: the money arrived for both, and a refund is owed
  rather than hidden;
- **no duplicate transaction** — the webhook creates none, and the loser's rollback
  reverted its `markTransactionPaid` before the retry redid it;
- **two `webhook_event` rows**, one per distinct delivery, none burned on a failed attempt.

**Can it fail the same way indefinitely?** No, and the mechanism is structural rather than
lucky: the loser's 23505 aborts its unit of work, so by the time any retry arrives the
winner's row is **committed** `active`. `findActiveFor` therefore returns non-null on every
subsequent attempt, and the graceful branch is unconditional from that point. One 500,
one retry, done. Bounded at one.

**Two supporting facts I verified:**

- `DrizzleUserSubscriptionRepository.activate` (line 118) does **not** catch 23505, so the
  violation propagates and `db.transaction` rolls the whole unit of work back —
  `recordIfNew` included, since it runs inside the same `tx`. That is what leaves the
  event id unspent, and the probe confirms it (`events=1` after the race, not 2).
- `DrizzleWebhookEventRepository.recordIfNew` uses `onConflictDoNothing`, not a caught
  exception — so the *other* concurrency shape (two simultaneous deliveries of the **same**
  event id) is arbitrated with no 500 at all. Only the two-distinct-invoices shape can
  reach a 500.

**One thing that makes the ruling more comfortable than stated:** the racing state is
**not reachable through any route today.** It needs two `pending` subscriptions for one
pair, which `user_subscription_one_pending` (`db/schema.ts:1036`) forbids at the database.
I had to stage the second row as `cancelled` to reproduce it at all. So the accepted 500
is confined to rows left behind before that index existed, plus hand-reconciled data.

**Your ruling 2 stands, verified.**

---

## The three money properties

### Amount verification — pinned

Mutant: `if (input.amount !== transaction.amount)` → `if (input.amount !== input.amount)`
(trust the payload).

Killed by, named:

- `refuses a payload claiming a different amount than our own record`
- `refuses an amount HIGHER than ours too, not only lower`
- `logs the amount mismatch with ids and integers only`
- `still compares the amount when the status is not PAID`
- route: `rejects an amount that does not match our own record, and activates nothing`
- route: `rejects an amount HIGHER than our record too`

The comparison reads our `user_transaction.amount` against `input.amount`, and it runs
**before** the unit of work opens — the test asserts `calls.recordIfNew` is empty, so a
forged body cannot burn the event id a genuine delivery needs. The log line carries ids
and integers only; a named test asserts the payer email is absent.

### Idempotency — the survivor is genuinely dead

Mutant M2: the replay guard `if (!isNew)` → `if (false)`.

**Confirmed: `cdeeb94`'s test is the only thing that kills it**, and it kills it cleanly —
1 fail, 70 pass, the named test being
`stops a replay AT the event-id guard, before it can re-read anything it authorises`.

The test is correctly shaped for the mutant that survived the first sweep. It does not
assert the *answer* (which the transaction-status check below also produces); it asserts
**where the work stops** — `findTransactionById` is called 3 times across two deliveries,
not 4, and `findSubscription` once, not twice. That is a property only the guard can
satisfy. Values are literal (`toBe(2)`, `toHaveLength(3)`).

Backed by `does not extend the period even when the redelivery arrives a month later`,
which advances the clock and pins `currentPeriodEnd` to a literal instant — the failure
that would silently hand a member a free extra cycle.

### Only `PAID` activates — pinned

Mutant M3: `input.status !== PAID` → `input.status.toUpperCase() !== PAID`.
Killed by `records but does not activate any status other than PAID` (1 fail, 70 pass).
The test sweeps `EXPIRED`, `PENDING`, `FAILED`, `SETTLED`, `paid`, `Paid` and asserts the
subscription stays `pending`, the transaction stays `pending`, and the event **is**
recorded.

I additionally mutated the second line of defence, `current.status !== TRANSACTION_PENDING`
→ `false` (M8). Killed by two named tests
(`treats an already-PAID transaction as an idempotent no-op, not a second activation`,
`throws a 409 for any OTHER non-pending status rather than answering 200 and losing it`).
This matters more than the sweep table suggests: it is what stops a *second* pending
transaction against an already-active subscription from re-running `activate` and moving
`current_period_end` forward, since `findActiveFor` deliberately excludes the row being
activated.

---

## Routing on a public endpoint — nothing throws

All five shapes you named, plus more, verified at three levels:

- **Domain**, directly: every shape returns a value, none throws (table above).
- **Unit**: `handle-payment-webhook.test.ts:1258` sweeps
  `["haxx", "1 OR 1=1", "usub_", "usub_x", "", "inv_9f2"]`.
- **Route, real DB**: `webhooks.test.ts:877` sweeps
  `["haxx", "1 OR 1=1", "0000", "usub_", "usub_x", "usub_1 OR 1=1"]` → all 200, and
  asserts zero `webhook_event`, zero `outbox`, zero `activity_log` rows;
  `webhooks.test.ts:1209` sweeps behind the namespace —
  `["", "x", "1 OR 1=1", "'; drop table user_transaction; --", "00000000"]` → all 200.
- **A well-formed uuid that does not exist**: bare → 404 (`:855`), namespaced → 404 with
  zero `webhook_event` rows (`:1195`). Correct: those are the shapes a provider should
  retry.

The empty string never reaches the router in production anyway —
`requireString` in `xendit-webhook-payload.ts` trims and rejects empty with a 400 — but the
router handles it as `unknown` regardless, which is the right belt-and-braces.

The uuid guard behind the prefix is the specific fix for Task 6's re-review finding
(`"usub_"` → `""` and `"usub_x"` → `"x"` reaching the driver as
`invalid input syntax for type uuid`), and it is documented as such in the source.

---

## Also verified

- **`attachGatewayReference`'s id is what verifies `body.id`.** The handler compares
  `input.invoiceId !== transaction.gatewayReferenceId`, i.e. the column
  `StartUserSubscription:240` wrote from the provider's own `createInvoice` result — the
  payload is never allowed to identify itself. `gatewayReferenceId === null` **fails
  closed** with a 400 before anything is written, which is the right answer when we have
  nothing of our own to compare against. Route tests read the invoice id back **from the
  column**, not from a helper, so the helper cannot quietly produce a verifiable body.
- **No test contacts Xendit.** No `fetch(`, no `api.xendit.co`, no `XENDIT_SECRET` in any
  of the three test files. Route tests run against `FakePaymentAdapter` under
  `NODE_ENV=test`, and they pass with no network.
- **Tests assert literal values.** `handle-payment-webhook.test.ts` imports no routing
  constant at all — `"usub_9a8b7c6d-…"`, `"inv_user_1:PAID"`, `"PAID"`, `"active"`,
  `"pending"` are all typed out. `domain/user-payment.test.ts` defines its own
  `const PREFIX = "usub_"` literal and pins the export against it
  (`expect(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX).toBe(PREFIX)`) — that is the correct
  direction, not a tautology, and the docstring says why.
- **`NotFoundError` messages are English at every call site.** Swept all ~40 in `apps/api`;
  both new/moved ones in this file read `"unknown transaction"`. Deliberately **identical
  across both namespaces**, so a caller cannot learn which namespace it missed in — a good
  call on a public endpoint. No Bahasa string enters this diff; nothing here is
  user-facing copy (the audience is Xendit).
- **Ports are additive.** `PaymentActivationRepositories` gained two fields; the community
  path's byte-identical body reads neither. `DrizzlePaymentActivationUnitOfWork` constructs
  both against `tx`, which is required — the replay claim and the activation it authorises
  must commit together, and my probe confirms they do.
- **Typecheck clean** (`tsc --noEmit`, exit 0).

---

## Findings

### Minor 1 — nothing guards `user_subscription.status` at activation time

`settleUserSubscription` reads the subscription and activates it without checking its own
status. A `cancelled` subscription whose transaction is still `pending` and whose
`gateway_reference_id` is set would be activated.

I checked the implementer's reachability claim (report note 5) and **it holds**: the only
route that cancels before payment is `StartUserSubscription.openInvoice`'s failure
release, which runs *before* `attachGatewayReference` and therefore leaves
`gateway_reference_id` NULL — and the fail-closed check at step 2 refuses that delivery.
The webhook's own graceful path cancels only after `markTransactionPaid`, so that row's
transaction is `paid`, not `pending`.

So this is not reachable today. It is Minor rather than nothing because it is the one place
where a hand-reconciled row could resurrect a cancelled membership silently, and because I
had to construct exactly that state to reproduce the race above. A one-line guard would
close it; the current state is defensible as documented.

### Minor 2 — `markTransactionPaid` is unconditional (report note 4)

No `where status = 'pending'`. The implementer's argument is sound — two concurrent PAID
deliveries for one transaction share `provider_event_id` (`<invoice id>:<status>`) and are
arbitrated by `recordIfNew`'s `onConflictDoNothing`, and a delivery with a different
invoice id is refused by the gateway-reference check — and the in-transaction status
re-read (M8, pinned) is the backstop. Recorded as an assumption, correctly.

### Minor 3 — the concurrent-race self-heal is reasoned in the source but not tested

The 500-then-graceful-retry chain is documented at length in the code comment and in the
report, and it is real (I measured it, 9/9). It has no test, because the state it needs
cannot be created through any route now that `user_subscription_one_pending` exists. Worth
one line in the source comment noting that unreachability — it is the reason the accepted
500 is confined to legacy rows, and it is the strongest part of the argument.

---

## Method

- Ran only the covering files: `domain/user-payment.test.ts` + `handle-payment-webhook.test.ts`
  (**88 pass / 0 fail**, matching the report's 17 + 71) and `routes/webhooks.test.ts`
  (**67 pass / 0 fail**). Full api suite not run, per instructions.
- Six mutations applied and reverted: user amount check, community amount check, user
  replay guard, `PAID` case-sensitivity, transaction-status guard, plus the concurrency
  probe appended to and then removed from `routes/webhooks.test.ts`.
- `git checkout --` after each; the route test file was restored from a byte copy taken
  before the probe was appended.
- **Tree confirmed clean:** `git status --porcelain` empty, `git diff --stat` empty,
  `HEAD` still `cdeeb94`. Both covering suites re-run green after every restore.
