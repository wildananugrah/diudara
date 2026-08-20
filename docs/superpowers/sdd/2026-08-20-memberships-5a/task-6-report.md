# Task 6 report — starting a subscription (the buy)

Commits:
- `bde2940` — feat(api): buying a membership from a person (Task 6, Phase 5a)
- `3aa98f5` — test(api): pin the subscribe route's 503 on a box with no payment provider (a mutation-sweep finding, see below)

Branch `feat/memberships`, worktree `.worktrees/memberships`. `git status` clean. `bun run typecheck` clean.

## What was built

**New** `apps/api/src/domain/user-payment.ts` — the `external_id` namespace, verbatim from the brief: `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX = "usub_"`, `userSubscriptionExternalId(transactionId)`, `userTransactionIdFromExternalId(externalId)` (returns `null` rather than guessing). Its own test file pins the literal `"usub_"`, the round trip, and that a BARE uuid — the community handler's shape — reads as `null`, as does `inv-usub_<uuid>` (the prefix must be a *prefix*).

**New** `apps/api/src/application/use-cases/start-user-subscription.ts` — `StartUserSubscription`, ports in order: `UserRepositoryPort`, `UserTierRepositoryPort`, `UserPayoutRepositoryPort`, `UserSubscriptionRepositoryPort`, `PaymentProviderPort`, `{ appBaseUrl }`. Sequence:

1. owner by handle (`normalizeHandle`, so `@wildan` resolves) → `NotFoundError("user not found")`;
2. self-purchase → `ConflictError`, Bahasa;
3. tier by id, refused as `NotFoundError("tier not found")` when missing **or owned by someone else**; inactive → `ConflictError`, Bahasa;
4. `findPayoutAccount(owner.id)` → gated on **`isConnectedPaymentAccount`**;
5. `findActiveFor(subscriberId, owner.id)` → the clean duplicate refusal;
6. subscriber record read (payer details);
7. **create subscription → create transaction → `createInvoice` → `attachGatewayReference`**;
8. returns `{ invoiceUrl, subscriptionId, transactionId, externalId }`.

**New route** `POST /users/:handle/subscribe` in `apps/api/src/routes/users.ts`, behind `requireUserAuth` (401 signed out), body `{ tierId }` only — the buyer is the session and the amount is read from the tier server-side, never accepted from a client. 201 (it creates rows). 503 in Bahasa when this box has no payment provider, matching `POST /users/me/payout`'s choice on the same router rather than `/c/:slug/checkout`'s "do not register the route at all".

**Wiring** `bootstrap.ts`: `userSubscriptionRepository` (Drizzle, over `user_subscription`/`user_transaction`) and `startUserSubscription` (`undefined` exactly when `payments` is `null`), plus the `Dependencies` field and its docstring; `bootstrap.test.ts`'s two hand-written `Dependencies` fixtures gain a shallow `fakeUserSubscriptionRepository` and the new field.

`/dashboard/*` and its six tables are untouched. `start-checkout.ts` and `handle-payment-webhook.ts` were read but not edited. No test contacts Xendit — `FakePaymentAdapter` throughout, both in the unit suite and via `bootstrap()` under NODE_ENV=test.

## The one addition beyond the literal brief, and why

`UserSubscriptionRepositoryPort` gains **`attachGatewayReference(transactionId, gatewayReferenceId)`** (+ the Drizzle implementation, conditional on the column still being NULL, + two repository tests).

Task 2's port can only set `gateway_reference_id` at insert time, and the mandated ordering makes that impossible: the invoice id does not exist until after the row does. Leaving the column NULL would hand Task 7 a transaction whose `body.id` is checked against nothing — and `handle-payment-webhook.ts` records that exact hole as measured, not theoretical ("12 concurrent PAID deliveries with 12 distinct `body.id`s all returned 200"). The community port has the identical method for the identical reason, so this mirrors it rather than inventing anything. Task 7 is free to ignore it; it cannot conjure it after the fact.

## Red phase

**Domain** (stub returned the wrong prefix / always `null`):

```
error: expect(received).toBe(expected)   Expected: "usub_"  Received: ""
(fail) userSubscriptionExternalId > exports the prefix Task 7 routes on
(fail) userSubscriptionExternalId > mints `usub_<transactionId>`
(fail) userTransactionIdFromExternalId > reads back exactly what it minted
 2 pass, 3 fail    (the 2 passes are the null-returning cases the stub satisfies trivially)
```

**Use case** — stub `execute()` throwing `not implemented`, so every one of the 17 tests failed on its own assertion (`Expected substring: "fake payment provider: createInvoice failed" / Received message: "not implemented"`, and each refusal test failing on its own Bahasa message):

```
 0 pass, 17 fail
```

**Repository** — the method genuinely did not exist yet:

```
TypeError: subs.attachGatewayReference is not a function
 11 pass, 2 fail
```

**Route** — 9 of the 10 new HTTP tests failed with `Expected: 201/401/409/400/500  Received: 404`, the route not being mounted yet:

```
 123 pass, 9 fail (routes/users.test.ts)
```

Every file loaded in each case; nothing failed to import.

## How the row-before-provider ordering is proved

Two tests, one at each level, both driving `FakePaymentAdapter.failNextInvoice = true`:

- unit (`start-user-subscription.test.ts`, "leaves a PENDING subscription and transaction behind when the provider call fails"): the call rejects with the provider's own error, and afterwards the fake repository still holds exactly one `pending` subscription and one `pending` transaction with `gatewayReferenceId === null`, and `payments.invoices` is empty.
- HTTP (`routes/users.test.ts`, "THE ROW EXISTS BEFORE THE PROVIDER IS CALLED"): the request is a 500, and `select() from user_subscription` / `user_transaction` each return exactly one row, `pending`, with the right subscriber/owner/amount and a NULL gateway reference.

Confirmed lethal: a mutant that calls `createInvoice` first and creates the rows afterwards fails 3 tests, that one among them.

## What the mid-provisioning test asserts

Two of them, and both start from the column genuinely holding `provisioning:in-progress` (asserted as a **literal**, never the imported constant).

- unit: owner's `xenditAccountId` is the sentinel → 409 with the exact Bahasa sentence, **and** `subscriptions`, `transactions` and `payments.invoices` are all empty. The point is not only that it refuses: it is that the provider was never called *at all*, so the sentinel cannot have gone out as `for_account_id`.
- HTTP: `deps.userPayoutRepository.beginXenditAccountProvisioning(ownerId)` is asserted to return `true`, the column is then read back and asserted to equal the sentinel literal, and the tier is seeded through `deps.userTierRepository.create` — because `POST /users/me/tiers` (Task 4) refuses to publish a tier without a connected account, this state is unreachable over HTTP and has to be built underneath it. Result: 409, `payments.invoices` empty, `user_subscription` empty.

The happy-path HTTP test additionally asserts `payments.invoices[0].forAccountId` equals the owner's real account id **and** `not.toBe(SENTINEL)`.

## The `external_id` shape minted

`usub_<user_transaction.id>` — e.g. `usub_7c1a0d2e-6f3b-4a5c-8d9e-0f1a2b3c4d5e`. Asserted at both levels against the literal prefix and against the transaction id in the response, plus `expect(externalId).not.toBe(transactionId)` so it can never collapse to the community handler's bare-uuid shape. It is also returned to the caller as `externalId` (derived from `transactionId`, which is already in the response, so it discloses nothing new).

## Refusals, all in Bahasa, all naming a remedy

- self: `"Anda tidak dapat berlangganan ke diri sendiri. Bagikan tautan profil Anda agar orang lain dapat menjadi anggota."`
- inactive tier: `"Tingkatan keanggotaan ini sudah tidak ditawarkan lagi. Pilih tingkatan lain yang masih tersedia di profil kreator ini."`
- owner cannot be paid (NULL *or* sentinel): `"Kreator ini belum siap menerima pembayaran. Minta mereka menghubungkan akun pembayaran di Pengaturan terlebih dahulu."`
- already a member: `"Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."`
- 401 signed out; 400 `"Pilih tingkatan keanggotaan yang ingin Anda beli."` / `"Isi permintaan harus berupa JSON yang valid."`; 503 `"pembayaran belum dikonfigurasi di server ini."`
- `NotFoundError`s stay English (`"user not found"`, `"tier not found"`), as at every call site in this codebase.

The duplicate-membership refusal is the clean one asked for: the HTTP test activates the first subscription through the repository and then asserts a **409 with that sentence**, that `user_subscription` still holds exactly one row and the provider saw exactly one invoice — never a constraint violation. `user_subscription_one_active` remains the backstop for the race this read cannot see. Two further tests pin the scope of that check: a **cancelled** past membership does not block a new purchase, and an active membership to a **different** owner does not either.

## Test counts

| | tests | files |
|---|---|---|
| before (`bun test` in `apps/api`) | 2257 | 151 |
| after | 2292 | 153 |

+35: 5 domain, 17 use case, 2 repository, 11 route. 0 fail, full suite run twice end-to-end (274s / 260s).

## Mutation sweep (after the first commit)

12 mutants applied by hand, all killed:

| mutant | killed by |
|---|---|
| `isConnectedPaymentAccount(x)` → `x === null` (the truthiness bug) | mid-provisioning test |
| provider call moved BEFORE the rows | ordering test (+2 others) |
| `if (!tier.isActive)` → `if (false)` | inactive-tier refusal |
| `if (existing)` → `if (false)` | duplicate-membership refusal |
| `attachGatewayReference` call removed | anchor test |
| `normalizeHandle(handle)` → `handle` | `@wildan` test |
| self-check removed | self-purchase refusal |
| `!tier \|\| tier.ownerId !== owner.id` → `!tier` | another owner's tier 404 |
| `payerName: subscriber` → `owner` | payer test |
| `userSubscriptionExternalId(id)` → `id` | external-id test |
| `startsWith` → `includes` in the domain module | `inv-usub_…` case |
| `"usub_"` → `"usub-"` | prefix literal tests |
| route `requireAuth` removed | 401 test (+3) |
| route 503 guard removed | **nothing — gap found and closed in `3aa98f5`** |

## Things I am not certain about

1. **`payerWhatsappNumber: subscriber.whatsappNumber ?? ""`.** `app_user.whatsapp_number` is nullable (a personal account needs only an email) but `CreateInvoiceInput.payerWhatsappNumber` is a required string. An empty string is the honest "we do not have one" and a test pins it — but `XenditPaymentAdapter` passes it straight through as `customer.mobile_number`, and that adapter is explicitly UNVERIFIED against the live API. Xendit may reject an empty `mobile_number`. If it does, the fix is a decision above my level (refuse the purchase until the buyer adds a number, or omit the customer field), so I left the current behaviour and am flagging it rather than guessing.

2. **`successRedirectUrl` is the owner's profile**, `${appBaseUrl}/@${handle}`. Phase 5a has no status page for a user subscription (spec §9: nothing renews or expires one yet), and the field is required precisely so nobody is stranded on Xendit's receipt. If a later task adds a `/…/status/:subscriptionId` equivalent, this is the one line to change.

3. **`attachGatewayReference`** — the addition described above. If Task 7 does not want the anchor, the method is inert; if it does, it is there. I judged the risk of *not* having it to be much larger, but it is the one thing in this diff the brief did not ask for by name.

4. The unit suite's `fakeUserRepository` implements all ten `UserRepositoryPort` methods with eight of them throwing, so a future version of this use case that starts writing to `app_user` fails loudly. No casts were needed anywhere in the fakes.

---

# Fix round 1 (review: spec ✅, 2 Important, 3 Minor)

Commits:
- `bc876e6` — fix(api): no empty phone number, no second invoice, no 500 from junk ids
- `e71c156` — test(api): kill two mutants the fix-round-1 suites let through

## F1 — omit `payerWhatsappNumber` rather than sending `""`

- `CreateInvoiceInput.payerWhatsappNumber` is now **optional**, with a docstring saying absent means "no number on file" and `""` is not a permitted stand-in. The community checkout is unaffected — `startCheckoutSchema` requires a number, and `string` still satisfies `string | undefined`, so `start-checkout.ts` was not touched.
- `XenditPaymentAdapter` builds `customer` with `mobile_number` included **only** when a non-empty number is present, by explicit spread rather than by relying on `JSON.stringify` dropping `undefined` — the omission is now a decision the code states.
- `StartUserSubscription` spreads the field in only when `subscriber.whatsappNumber !== null`.
- Tests: the adapter suite gains "sends the payer's number when there is one" and "OMITS mobile_number entirely…", the latter covering **both** `undefined` and `""`; the use-case test now asserts `"payerWhatsappNumber" in invoices[0]` is `false` instead of asserting `""`.

Red evidence: the new adapter test could not compile against the old required field — `xendit-payment.adapter.test.ts(99,45): error TS2322: Type 'undefined' is not assignable to type 'string'.`

## F2 — a second tap can no longer mint a second invoice

**Mechanism chosen: reuse.** Refusing while a checkout is pending was rejected outright: 5a has no expiry sweep, no cancel path and no way to clear a pending row, so a buyer who abandoned one invoice would be locked out of that creator permanently.

- **Schema**: `user_transaction.gateway_invoice_url varchar(512)`, nullable — migration `drizzle/0027_cloudy_the_call.sql`, generated with `bunx drizzle-kit generate` (the test preload migrates from this folder, so nothing else was needed).
- **Port**: `attachGatewayReference(transactionId, gatewayReferenceId, invoiceUrl)` writes it in the same statement as the anchor; `UserTransactionRow` gains `gatewayInvoiceUrl`; new `findPendingCheckout(subscriberId, ownerId): PendingUserCheckout | null` (`{ subscriptionId, tierId, transactionId, invoiceUrl }`).
- **Repository**: one join, `subscription.status = 'pending' AND transaction.status = 'pending' AND gateway_invoice_url IS NOT NULL`, newest transaction first, `limit 1`.
- **Use case**, after the `findActiveFor` refusal and before anything is written:
  - same tier → the pending invoice is handed back verbatim (`invoiceUrl`, `subscriptionId`, `transactionId`, `externalId` re-derived); **nothing is created and the provider is not called** — the one path through `execute` that writes nothing;
  - different tier → `ConflictError` in Bahasa: *"Pembayaran keanggotaan untuk kreator ini sedang diproses. Selesaikan dulu pembayaran yang sudah dibuka, atau tunggu tagihannya kedaluwarsa sebelum memilih tingkatan lain."* Returning the other tier's invoice would charge a price the buyer did not choose; opening a new one is the very thing being prevented.
  - HTTP status stays 201 for both, so a client only ever has to follow `invoiceUrl`.
- **`gateway_invoice_url IS NOT NULL` is load-bearing**, not decoration: a failed provider call leaves a pending row with no invoice, and treating that as "a payment is in progress" would lock the buyer out for good. A test pins that a second attempt after a provider failure succeeds and opens exactly one invoice.

### Mutation evidence for the dedupe

| mutant | result |
|---|---|
| `if (pending)` → `if (false && pending)` (guard removed) | **killed** — both new use-case tests fail |
| `if (pending.tierId !== tier.id)` → `if (false)` (reuse any tier's invoice) | **killed** — the different-tier refusal fails |
| `isNotNull(gateway_invoice_url)` dropped from the query | **survived at first**, then killed — see below |

The third mutant survived because the JS `row.invoiceUrl === null` fallback answers identically whenever a subscription has one transaction. `e71c156` adds the case that separates them: an **older** transaction carrying the live invoice and a **newer** one that never got a url — correct behaviour returns the live invoice, "most recent row" alone returns `null` and would let a second invoice be minted while the first is still payable. Re-run with the mutant applied: 16 pass, 1 fail (that test). Same commit also closes a second survivor — the adapter omitting `mobile_number` was indistinguishable from sending it unconditionally, since `JSON.stringify` drops `undefined`; the `""` case is what tells them apart, and with `mobile_number: input.payerWhatsappNumber` restored the F1 test fails.

### The expiry gap (asked for explicitly)

**We cannot tell whether a stored invoice is still payable at the provider.** No expiry is set on the invoice, no expiry is stored, and `gateway_invoice_url` is only cleared by the transaction being settled. So once Xendit expires an invoice (their default is 24h for an unpaid one):

- the buyer taps again, gets handed back the **expired** url, and lands on a dead payment page;
- there is nothing in 5a that mints them a fresh one — no expiry sweep, no cancel, no operator path. They are stuck with that creator until 5b, or until somebody clears the row by hand.

The trade this takes: a **dead link** after ~24h beats a **double charge** with no refund path, and it beats an immediate permanent refusal for anyone who merely abandons a checkout. The clean fixes both belong to 5b — either record the provider's `expiry_date` and mint a new invoice past it, or add the pending-checkout cancel that 5b needs for churn anyway. I deliberately did **not** guess a lifetime and time-bound the reuse: guessing short re-opens the double-charge window, and the window would be an invented policy this spec does not have.

## F3 — uuid guards on the repository

`DrizzleUserSubscriptionRepository` now shape-checks against the same `UUID_PATTERN` the community repository uses, in `findById`, `findTransactionById`, `findActiveFor`, `attachGatewayReference` and `findPendingCheckout`; a miss reads as `null`/`false`. The domain helper is unchanged — it is Task 7's contract and the brief pins its shape verbatim; the guard belongs at the driver boundary.

Red evidence, before the guard (postgres raising on `""`):

```
error: Failed query: select "id", "user_subscription_id", "amount", "status",
  "gateway_reference_id", "paid_at", "created_at" from "user_transaction"
  where "user_transaction"."id" = $1 limit $2
(fail) DrizzleUserSubscriptionRepository > answers null — never throws — for an id that cannot be a uuid at all
 0 pass, 1 fail
```

The test loops `["", "x", "usub_", "not-a-uuid", "00000000-0000-4000-8000-00000000000"]` — the first three being literally what `userTransactionIdFromExternalId` hands back for `usub_`, `usub_x` and a bare prefix — across all four public reads.

## Verification

Covering files only, as instructed — **the full api suite was not run this round**.

```
$ bun run typecheck        # apps/api
$ bun test src/routes/users.test.ts src/application/use-cases/start-user-subscription.test.ts \
    src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts \
    src/infrastructure/payments/ src/domain/user-payment.test.ts src/bootstrap.test.ts src/db/
 433 pass, 0 fail, 1235 expect() calls, 20 files [78.85s]
```

Plus the payment-adjacent suites that touch the changed port, run once after the F1/F2 edits: `routes/checkout.test.ts`, `use-cases/start-checkout.test.ts`, `routes/payment-account.test.ts`, `use-cases/renewal-payment.test.ts`, `use-cases/handle-payment-webhook.test.ts`, `routes/webhooks.test.ts`, `drizzle-subscription.repository.test.ts` — **206 pass, 0 fail**. Typecheck clean; `tsc` covers every remaining caller of the widened port.

New tests this round: 8 (2 adapter, 3 use case, 4 repository — one added by `e71c156` — minus none removed), plus 2 route tests.

`git status` clean at both commits; nothing under `.superpowers/` was force-added.

## Still open / worth knowing

1. The **expiry gap** above is the one behaviour I would want 5b to close first.
2. `activate`, `cancel` and `markTransactionPaid` are deliberately left unguarded: Task 7 reaches them only with ids it just read back from a guarded read, exactly as the community repository does it.

---

# Fix round 2 — the concurrent double tap

Commits:
- `2227770` — fix(api): let the database arbitrate the double tap, not a read
- `1b659cb` — test(api): prove the claim's catch is narrow, not blanket

## The migration

`drizzle/0028_lowly_kat_farrell.sql`, generated by `bunx drizzle-kit generate` from `db/schema.ts`:

```sql
CREATE UNIQUE INDEX "user_subscription_one_pending" ON "user_subscription"
  USING btree ("subscriber_id","owner_id") WHERE "user_subscription"."status" = 'pending';
```

Partial, exactly like Task 2's `user_subscription_one_active` — so a settled or released subscription never blocks a later purchase. The schema comment records the measurement that produced it.

## The catch

`DrizzleUserSubscriptionRepository.claimPending(input)` → `{ subscription, created }`. It INSERTS first and lets the index decide:

```ts
try {
  return { subscription: await this.create(input), created: true };
} catch (err) {
  if (uniqueViolationConstraint(err) !== PENDING_SUBSCRIPTION_CONSTRAINT) {
    throw err;
  }
  const existing = await this.findPending(input.subscriberId, input.ownerId);
  if (!existing) throw err;          // holder settled/released between the two
  return { subscription: existing, created: false };
}
```

- **Narrow by construction.** `uniqueViolationConstraint` (the existing `pg-errors.ts` helper) returns a name **only** for SQLSTATE `23505`, and only the literal `"user_subscription_one_pending"` is turned into a claim result. Every other error — different constraint, different SQLSTATE, driver failure — is rethrown untouched.
- Documented as **not safe inside an enclosing transaction** (a unique violation aborts it), the same caveat `DrizzleFollowRepository.follow` and `DrizzleJoinRequestRepository` carry. Nothing calls it inside one.
- `create()` stays as the raw insert for fixtures, and now rejects on a second pending row — pinned by its own test.

**In the use case**, the pre-read guard is gone; the claim is the guard. `created: false` routes into `resolveExistingCheckout`, which is the round-1 reuse path reached from the concurrent case:

| winner's state | answer |
|---|---|
| live invoice, same tier | hand it back — 201, nothing created, no provider call |
| live invoice, different tier | 409, the round-1 Bahasa refusal |
| no invoice yet (winner between INSERT and provider call) | 409, transient: *"Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — jangan menekan tombol berkali-kali agar Anda tidak ditagih dua kali."* |

**A failed provider call now releases the claim** (`cancel`, with an ids-only warning if the release itself fails). This is not decoration: a pending row holds the pair's only pending slot and nothing in 5a expires or clears one, so keeping it after a failure would wedge that buyer out of that creator permanently — for a purchase nobody charged them for. It is the same reasoning `ConnectUserPayout` records for `abandonXenditAccountProvisioning`. The transaction row is deliberately left behind with a null gateway reference, so the ordering guarantee ("the rows exist before the provider is called") still has its inspectable record; round-1's two failure tests now assert `status: "cancelled"` on the subscription and explain why.

## The concurrency tests, and the contender counts

**Repository level — 30 latched contenders** (`drizzle-user-subscription.repository.test.ts`): `ArrivalLatch(30)` holds every caller until all thirty have arrived, then each calls `claimPending`. Asserts exactly one `created: true`, `latch.arrived === 30`, every loser handed the **same** row id, and one row in the table. Thirty because that is what the payout race settled on against this same database (Task 3's F1: four contenders let check-then-act pass 27 times out of 30), and keeping one number for the phase beats inventing a second.

**HTTP level — 20 concurrent taps** (`routes/users.test.ts`): twenty real `POST /users/:handle/subscribe` requests through the real router, database and repository, fired in one `Promise.all`. Asserts **one invoice at the provider, one subscription row, one transaction row**, every response either 201 or 409 (never a 500), every 201 carrying the **same** invoice url, and every 409 in Bahasa.

Twenty is measured, not guessed. With `user_subscription_one_pending` dropped (i.e. the pre-fix read-then-write), three runs at 2, 4 and 20 contenders:

```
[measure] contenders=2  invoices=2  subs=2  txns=2
[measure] contenders=4  invoices=4  subs=4  txns=4
[measure] contenders=20 invoices=20 subs=20 txns=20      (identical across all three runs)
```

One invoice per contender, every time — the defect the re-review saw once in five, reproduced here in every run. Twenty is chosen because hiding the bug would require **all twenty** requests to serialise, not just two, and because at HTTP level each contender costs real time; the repository test carries the higher count where it is cheap.

With the fix in place, the same harness across three runs:

```
[measure] contenders=2  invoices=1 subs=1 txns=1 statuses={"201":2}
[measure] contenders=4  invoices=1 subs=1 txns=1 statuses={"201":3,"409":1}
[measure] contenders=20 invoices=1 subs=1 txns=1 statuses={"201":17,"409":3}
[measure] contenders=20 invoices=1 subs=1 txns=1 statuses={"201":16,"409":4}
[measure] contenders=20 invoices=1 subs=1 txns=1 statuses={"201":20}
```

Always exactly one invoice; most contenders are handed it back, a few land in the transient window and are told to wait. (The measurement harness was a scratch file, deleted — the committed tests assert the invariant rather than a status split, which is why the run-to-run 201/409 mix does not make them flaky.)

## Mutation sweep (after `2227770`)

| mutant | result |
|---|---|
| drop the constraint-name check (blanket catch) | **survived** → killed in `1b659cb`, see below |
| `PENDING_SUBSCRIPTION_CONSTRAINT` → `"user_subscription_one_active"` | killed — the sequential reuse test and the 30-way race both fail |
| release-the-claim removed on provider failure | killed — both failure tests fail |
| read-then-write reinstated *in front of* the insert | **survived, and equivalent** — see below |

**The blanket catch** could not be killed by a double-fault insert: probed, an insert that violates both the pending index and the tier foreign key reports `23505` on the index, never `23503`. So `1b659cb` injects the failure through a stubbed `DatabaseExecutor` — an insert that dies while a pending row genuinely exists — where a blanket catch answers `created: false` and tells the buyer to wait for an invoice nobody is opening. With the check removed that test fails; with it, green.

**The surviving read-then-write mutant is genuinely equivalent**, and it is worth saying why rather than chasing it: putting a `findPending` in front of the insert changes nothing, because the INSERT is still the arbiter. Both callers of a race read nothing, both insert, one wins, the loser is routed by the violation exactly as before. That is the property the fix is for — the read is now an optimisation that cannot be load-bearing, which is the opposite of the pre-fix code where it was the only thing there.

## Verification

Covering files only — **the full api suite was not run this round.**

```
$ bun run typecheck        # apps/api — clean
$ bun test src/routes/users.test.ts src/application/use-cases/start-user-subscription.test.ts \
    src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts \
    src/bootstrap.test.ts src/db/ src/domain/user-payment.test.ts src/infrastructure/payments/
 441 pass, 0 fail, 1289 expect() calls, 20 files [83.63s]
```

`git status` clean at both commits; the measurement and probe files were scratch and are deleted.

## Still open

1. The **invoice-expiry gap** from round 1 is unchanged and unaffected by this fix.
2. **A crash between the claim and the release** (process killed mid-provider-call) leaves a pending row nobody will clear, and that pair then sees the transient "sedang disiapkan" until somebody clears it by hand. Same class as `ConnectUserPayout`'s own documented caveat, and it needs the same thing 5b needs anyway: a way to expire or cancel a pending checkout.
