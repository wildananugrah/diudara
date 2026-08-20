# Task 6 review — starting a subscription (`POST /users/:handle/subscribe`)

Reviewed: `2584071..3aa98f5` (`bde2940`, `3aa98f5`) on `feat/memberships`, worktree
`.worktrees/memberships`. Inputs: `task-6-brief.md`, `task-6-report.md`,
`review-2584071..3aa98f5.diff`, spec §6 and §7.

## Verdicts

**1. Spec compliance (§6, §7): ✅**

**2. Task quality: approved with findings** — 0 Critical, 2 Important, 3 Minor. Nothing here
blocks the commit; F1 must be decided before this adapter is ever pointed at live Xendit, which
is already gated by the adapter's own UNVERIFIED banner.

## What I ran (no full api suite)

| command | result |
|---|---|
| `bun test src/domain/user-payment.test.ts src/application/use-cases/start-user-subscription.test.ts` | 22 pass / 0 fail (1.9 s) |
| `bun test src/routes/users.test.ts src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts` | 146 pass / 0 fail (70 s) |
| `bun test src/bootstrap.test.ts` | 163 pass / 0 fail (2.3 s) |
| `bun run typecheck` | clean |

The one `unhandled error: Error: fake payment provider: createInvoice failed` line in the route
run is `http/error-handler.ts`'s own sanitised `console.error` for the deliberate 500 in the
ordering test, not an unhandled rejection.

## §6 / §7 compliance, point by point

| §6 requirement | where | verified |
|---|---|---|
| Buying is signed-in only | `routes/users.ts:503` `requireAuth` | 401 test, provider untouched |
| Refuses the owner buying their own tier | use case, `ConflictError` before any write | ✅ |
| Refuses an inactive tier | `if (!tier.isActive)` | ✅ |
| Refuses an owner with no payout account | `isConnectedPaymentAccount` gate | ✅ (NULL **and** sentinel) |
| Refuses an existing active membership | `findActiveFor` → `ConflictError` | ✅ clean 409, see below |
| Creates a `pending` `user_subscription` | `subscriptions.create`, status defaults `pending` | ✅ asserted in DB |
| Invoice against the OWNER's sub-account, split rule | `forAccountId` from `findPayoutAccount(owner.id)`; split header is the adapter's | ✅ |
| Returns the invoice URL | 201 `{ invoiceUrl, subscriptionId, transactionId, externalId }` | ✅ |

§7's half of the contract — the `external_id` namespace, unrecognised prefix ignored rather than
guessed — is `domain/user-payment.ts`, verbatim from the brief, and is the shape actually minted
(`userSubscriptionExternalId(transaction.id)` is the only producer). Amount verification and
idempotency are Task 7's; this task supplies both inputs they need (`user_transaction.amount` is
read from the tier server-side, never from the body; `gateway_reference_id` is written).

## 1. The sentinel — verified, with a killed mutant

- The gate is `if (!isConnectedPaymentAccount(forAccountId))` at
  `application/use-cases/start-user-subscription.ts:724` (diff line), bound to a local first so
  the type predicate narrows for `forAccountId` below.
- Grepped the whole diff for every read of the payout column
  (`xenditAccountId|payout\.|forAccountId`, added lines only): the only production read is that
  one. No truthiness check on the column exists anywhere in the diff, in the use case or in the
  route.
- **Mutation applied:** `if (!isConnectedPaymentAccount(forAccountId))` → `if (!forAccountId)`.

  Killed at both levels:
  - unit: `StartUserSubscription — the refusals > THE SENTINEL IS NOT AN ACCOUNT: a
    mid-provisioning owner's tier cannot be bought` — *"Expected promise that rejects, received
    promise that resolved"* (16 pass / 1 fail).
  - HTTP: `POST /users/:handle/subscribe (Task 6) > THE SENTINEL IS NOT AN ACCOUNT: a
    MID-PROVISIONING owner's tier cannot be bought` — *Expected 409, received 201*.

  The NULL-payout tests stayed green under the mutant, exactly as predicted — only the sentinel
  case distinguishes the two gates.

- Both sentinel tests start from the column *genuinely* holding the sentinel (the HTTP one via
  `beginXenditAccountProvisioning`, then reads the column back and asserts it against the string
  literal `"provisioning:in-progress"`, never the imported constant), and both assert
  `payments.invoices` is **empty** — the provider was not called at all, so the sentinel cannot
  have gone out as `for_account_id`. The happy-path HTTP test additionally asserts the real
  account id **and** `not.toBe(SENTINEL)`.

Reverted; tree restored.

## 2. Row before provider — verified, with a killed mutant

Ordering in `execute()`: `subscriptions.create` → `createTransaction` → `payments.createInvoice`
→ `attachGatewayReference`, with an explicit `// ---- Everything below this line changes state.
Rows FIRST, provider last.` marker.

**Mutation applied:** the invoice call moved above both inserts, minting `externalId` from a
pre-generated `crypto.randomUUID()` (the faithful reverse ordering, since the real transaction id
does not exist yet).

Killed:
- unit: `the row exists before the provider is called > leaves a PENDING subscription and
  transaction behind when the provider call fails`, plus collateral in `the happy path > mints an
  external_id of usub_<transactionId>` (2 fail).
- HTTP: `THE ROW EXISTS BEFORE THE PROVIDER IS CALLED: a failed invoice leaves a pending
  subscription behind`.

The failure-path assertions are the right ones: one `pending` subscription, one `pending`
transaction with `gatewayReferenceId === null`, and zero invoices at the provider.

Reverted; tree restored.

## 3. The `external_id` namespace — matches `domain/user-payment.ts` exactly

- Minted shape: `usub_<user_transaction.id>`, produced only by
  `userSubscriptionExternalId(transaction.id)`; the route returns it as `externalId` and the HTTP
  test pins `payments.invoices[0].externalId === "usub_" + body.transactionId` against the string
  literal.
- `userTransactionIdFromExternalId` returns `null` for a bare uuid (the community handler's own
  shape), for `""`, for `sub_1234`, and for `inv-usub_<uuid>` — `startsWith`, not `includes`.
- **Mutation applied:** `startsWith` → `includes`. Killed by
  `userTransactionIdFromExternalId > returns null for anything else, rather than guessing`.
  Reverted.
- Task 7 gets the prefix as an exported constant and both directions of the conversion. No
  mismatch. One rough edge in the reverse direction: see F3.

## 4. The refusals — all five, all clean

| refusal | status | copy |
|---|---|---|
| signed out | 401 | middleware |
| self-subscription | 409 | Bahasa, names the remedy |
| inactive tier | 409 | Bahasa, names the remedy |
| unconnected payout (NULL or sentinel) | 409 | Bahasa, names the remedy |
| already an active member | 409 | Bahasa, names the remedy |
| unknown handle / another owner's tier | 404 | `NotFoundError`, English |
| no tier id / bad JSON | 400 | Bahasa |
| box with no payment provider | 503 | Bahasa, byte-identical to `POST /users/me/payout`'s |

The duplicate refusal is the clean one asked for. `REFUSES a second membership to the same owner
CLEANLY — a 409, not the unique index's 500` buys once over HTTP, activates the row through the
repository (standing in for Task 7's webhook), buys again, and asserts **409 with the exact
Bahasa sentence**, `user_subscription` still holding exactly **one** row and the provider having
seen exactly **one** invoice. It is refused by `findActiveFor` in the use case;
`user_subscription_one_active` never fires and is never the mechanism. Two companion tests pin
the scope: a `cancelled` past membership does not block a repurchase, and an active membership to
a *different* owner does not either.

## 5. Your two rulings — both confirmed

**`attachGatewayReference` beyond the brief: agreed, and it earns its place.**
- It mirrors the community port method exactly — same signature, same single conditional UPDATE
  `where id = ? and gateway_reference_id is null`, same `rows.length > 0` boolean, same
  write-once rationale in the docstring. The only difference is the community version's
  `UUID_PATTERN` pre-check (which exists there because that id arrives off a public URL; here it
  arrives from an insert two statements earlier) and `updatedAt`, which `user_transaction` does
  not have.
- It **is** called on the success path, and a failed attach throws rather than being swallowed.
  **Mutation applied:** the call replaced by `if (false)`. Killed by `the happy path > records
  the provider's invoice id against the transaction, so the webhook has an anchor`. Reverted.
- Repository-level coverage is honest: write-once proven by a second attach returning `false`
  with the *first* value still standing, plus a `false` for a non-existent transaction.

**`successRedirectUrl` = the owner's profile: I agree.** 5a has no status page (§9), the field is
required precisely so nobody is stranded on Xendit's receipt, and the profile is where the
membership becomes visible once Task 7 activates it. Built from the canonical `owner.handle`, not
`input.handle`, and `encodeURIComponent`'d before it is handed to a third party. The HTTP test
pins `${deps.appBaseUrl}/@wildan`.

## Findings

### F1 (Important) — `payerWhatsappNumber: subscriber.whatsappNumber ?? ""` sends a value this codebase itself classifies as invalid

This is the item you asked me to judge, so the reasoning is below in full. Short form: **not
safe, not provably fatal, and not unknowable in the part that matters** — the honest handling is
determinable without the provider.

What is knowable from here:

- `packages/shared/src/auth.schema.ts:35` — signup: `whatsappNumber: z.string().trim().min(8)
  .max(20).regex(/^[+0-9][0-9]{7,19}$/).optional()`. Optional, so `NULL` is the default state for
  anyone who skipped it.
- `packages/shared/src/community.schema.ts:124` — community checkout: the **same** regex, **not**
  optional, commented "this only rejects obvious junk". The only other caller of
  `CreateInvoiceInput.payerWhatsappNumber` therefore *always* sends a well-formed number.
- `XenditPaymentAdapter.createInvoice` passes the field straight through as
  `customer.mobile_number`, and that adapter carries `!!! UNVERIFIED AGAINST THE LIVE XENDIT
  API !!!`.

So `""` is a shape the adapter has never sent to Xendit, and one that this repository's own
validation rules would reject as junk if a client submitted it. Whether Xendit's
`POST /v2/invoices` rejects `customer.mobile_number: ""` (its `customer` fields are documented as
optional and E.164-shaped) cannot be settled from this repository — but that uncertainty argues
*against* sending it, not for it. And the blast radius is the worst kind: it fails for exactly
the buyers who never filled the field in — the default state of every signup — while succeeding
for the ones who did, and it fails at the "Jadi anggota" tap, invisible to every test because
`FakePaymentAdapter` accepts anything.

**Recommended handling: omit the field, do not refuse and do not ship `""`.** Widen the port to
`payerWhatsappNumber?: string` (or `string | null`), have the adapter build `customer` with the
key present only when there is a number, and pass `subscriber.whatsappNumber ?? undefined` here.
An absent optional field is the shape the provider documents for "we have no number"; an empty
string is a value that must survive format validation. The community flow is unaffected — it
always has a number.

Refusing the purchase with a Bahasa "add a WhatsApp number first" is the wrong trade: it blocks
the product's own default state on a guess about the provider, for a field signup deliberately
made optional. Shipping `""` and letting the sandbox find out is acceptable *only* if the
no-number case is added, in writing, to the pre-live Xendit verification checklist alongside the
adapter's UNVERIFIED banner — otherwise the first person to find it is a paying buyer.

### F2 (Important) — nothing dedupes *pending* subscriptions, and Task 7 inherits the consequence

`findActiveFor` refuses only an `active` membership. Two taps of "Jadi anggota" (or a back-button
retry) create two `pending` `user_subscription` rows and two live Xendit invoices for the same
(subscriber, owner). If both are paid, Task 7 activates the first and the second activation hits
`user_subscription_one_active` — a constraint violation surfacing as a 500 on the webhook
endpoint, which Xendit will then retry, and 5a has no refund path.

The community flow avoids the equivalent by reusing the current subscription row
(`current ?? createPending(...)` in `start-checkout.ts`). Task 6 is still spec-compliant — §6
names only the active-membership refusal — so this is a hand-off, not a defect in the diff:
either reuse an existing `pending` row for the same (subscriber, tier) here, or Task 7 must treat
"another active membership already exists for this pair" as a *recorded refusal*, not an
exception. Worth stating explicitly in the Task 7 brief, because Task 7 cannot see this decision.

### F3 (Minor) — the reverse conversion can return a non-uuid, and the repository has no shape guard

`userTransactionIdFromExternalId` is verbatim from the brief, so this is not a deviation — but I
measured the edge:

- `userTransactionIdFromExternalId("usub_")` → `""`, and `("usub_not-a-uuid")` → `"not-a-uuid"`.
  Non-`null`, so a caller reads them as "this is one of ours".
- `DrizzleUserSubscriptionRepository.findTransactionById` has **no** `UUID_PATTERN` guard (the
  community repository has one, precisely for ids that arrive off a public surface). I ran both
  values through it against a live test database: both **throw** at the driver (`Failed query:
  ... where "user_transaction"."id" = $1`, params `` and `not-a`).

`external_id` on a webhook is attacker-chosen, so once Task 7 routes on this the pair becomes a
500 vector on a public endpoint (plus provider retry storms). Fix is one line in either place:
return `null` when the remainder is not uuid-shaped, or shape-check in the repository the way the
community one does.

### F4 (Minor) — a provider failure reaches the buyer as an English generic 500

`createInvoice` throwing surfaces as `{ "error": "internal server error" }` — the one
user-reachable non-Bahasa string on this path. Identical to what `/c/:slug/checkout` already
does, so it is consistent rather than a regression, and the sanitised handler is deliberate. Only
worth a Bahasa "gagal membuka pembayaran, coba lagi" if the web client does not already map 500s
itself.

### F5 (Minor, observation) — the duplicate check keys on `status` alone

`findActiveFor` matches `status = 'active'` with no `current_period_end > now()`, which matches
`user_subscription_one_active`'s predicate exactly — the pre-check and its backstop agree, which
is the right call. The consequence, per §9, is that a member whose period has lapsed (nothing
expires them in 5a) still reads as active and cannot re-buy. The refusal copy already anticipates
it ("jika Anda belum bisa melihat kontennya, hubungi kreator tersebut"). 5b's renewal pass owns
the real fix; noted so it is not rediscovered as a bug.

## Also verified

- **`/dashboard/*` untouched.** The commit range touches 11 files, all under `apps/api/src`, none
  of them `routes/dashboard.ts`, `start-checkout.ts` or `handle-payment-webhook.ts`
  (`git diff` over those three paths: 0 lines). No schema change at all — `community`,
  `membership_tier`, `member`, `subscription`, `transaction`, `creator` are all untouched, and so
  is `apps/web`. The only shared-surface edits are additive: a new port method, a new
  `Dependencies` field, and a new route on an existing router.
- **No test contacts Xendit.** Every test uses `FakePaymentAdapter`, directly or through
  `bootstrap()`; and `src/test-env-preload.ts` *deletes* `XENDIT_SECRET_KEY` /
  `XENDIT_SPLIT_RULE_ID` from the environment, so `selectPaymentProvider` cannot pick the real
  adapter under `bun test` even on a developer box that has them set.
- **Copy.** Every user-facing message is Bahasa Indonesia and names a remedy; the two
  `NotFoundError`s ("user not found", "tier not found") are English, matching every other call
  site in this codebase.
- **Tests assert literals.** `SENTINEL = "provisioning:in-progress"` and `PREFIX = "usub_"` are
  re-declared as string literals in all three suites rather than imported, the Bahasa sentences
  are spelled out in full, and amounts/ids are compared against concrete values.
- **Bootstrap wiring.** `startUserSubscription` is `undefined` exactly when `payments` is `null`,
  with the route staying registered and answering 503 (pinned by its own test, added in `3aa98f5`
  after the implementer's own mutation sweep found it unpinned — that is the sweep working).

## Hygiene

Four mutations applied and reverted with `git checkout --` (payout gate → truthiness; provider
before rows; `attachGatewayReference` call removed; `startsWith` → `includes`). Final
`git status --short` is **empty**, `git stash list` empty, `HEAD` still `3aa98f5`, `bun run
typecheck` clean. Scratch probes were written outside the repository.
