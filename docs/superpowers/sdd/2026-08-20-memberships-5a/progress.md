# SDD ledger — plan: docs/superpowers/plans/2026-08-20-memberships-5a.md

Phase 5a of the DIUDARA pivot: a user can sell a membership.

- Worktree: `/home/wildandev/repo/diudara/.worktrees/memberships`, branch `feat/memberships`
- Base: `f3aef8a` (on `main`, which contains Phases 1-4)
- Spec: `docs/superpowers/specs/2026-08-20-memberships-5a-design.md` — read, and the binding authority
- Baseline: **3052 pass / 0 fail** (shared 85, worker 52, web 750, api 2165)

**This phase moves money.** The Xendit adapter, its split rule and the claim-first payout sentinel are
reused, never reimplemented. `/dashboard/*` and every table it reads are untouchable.

## Pre-flight scan

| Rows | What was checked | Result |
|---|---|---|
| T1 → T2 | `user_tier`'s `unique (id, owner_id)` vs `user_subscription`'s composite FK | consistent — and T1 Step 2 tells the implementer to verify the index exists, since the FK cannot be created without it |
| T1 → T4, T5, T6 | `UserTierRepositoryPort` produced vs consumed | consistent |
| T2 → T6, T7, T8 | `UserSubscriptionRepositoryPort` (`create`, `activate`, `findActiveFor`, transaction methods) | consistent |
| T3 → T4, T6 | the payout "connected" predicate | consistent, and both consumers are told the sentinel is truthy |
| T6 → T7 | `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX` / `userTransactionIdFromExternalId` | consistent |
| T1, T2, T3 | all three edit `schema.ts` | sequential, disjoint regions |
| T1, T2 | both edit `test-helpers.ts` | disjoint, and ordering (transactions → subscriptions → tiers) is stated |
| T3, T4, T5, T6 | all four edit `routes/users.ts` | sequential, disjoint routes |
| T9, T10 | both edit `apiClient.ts` | sequential, disjoint functions |
| Each task vs itself | tests specified vs code specified | consistent, except **F1 and F2** |

### F1 — my plan mandates reserving two handles that need no reserving. **PLAN DEFECT, MINE.**

Task 3 Step 4 and Task 4 Step 3 tell the implementer to add `payout` and `tiers` to
`RESERVED_HANDLES`, claiming "the route-derived guard will fail until it does."

**That is false.** The guard (`users.test.ts:190`) reads only the FIRST segment after `/users/`:
`route.path.slice("/users/".length).split("/")[0]`. The new routes are `/users/me/payout` and
`/users/me/tiers`, whose first segment is **`me`** — already unregisterable at 2 characters under
`^[a-z0-9_]{3,30}$`. The guard will stay green either way, and nothing collides.

**Ruling: drop both reservation steps.** Instead each implementer RUNS the guard to confirm it stays
green, which is the honest check. *Why:* reserving `payout` and `tiers` would take two ordinary words
away from users to protect against a collision that cannot occur — and `handle.test.ts` already
asserts that segments the pattern makes impossible are deliberately absent from the list, so adding
these would contradict an existing test's stated reasoning. *Cost if wrong:* nil; if a future route
ever puts either word in first position, the guard fails loudly and says so.

`POST /users/:handle/subscribe` (T6) is parameterised in first position, so it introduces no literal
at all.

### F2 — Task 5 leaves a file choice open ("`post-views.ts` or a new `tier-views.ts`").

**Ruling: a new `tier-views.ts`.** *Why:* `post-views.ts` exists to decide the post projection in
exactly one place, and tiers are not posts; widening it would make one file own two unrelated wire
shapes. *Cost if wrong:* one small file.

## Tasks

### Task 1 — `user_tier` and its repository

- BASE `f3aef8a`. Dispatched standard tier: the brief carries the schema verbatim, but the repository
  and its harness are real work.
- Implementer: `0db6afb`, **2172 pass / 0 fail** (api +7). Migration `0024_tired_bullseye.sql`, and it
  verified `user_tier_id_owner_unique` is a clean two-column unique index with no stray modifiers —
  which Task 2's composite FK cannot be created without.
- Disclosed judgement call: `listByOwner`'s secondary sort (active first, then oldest-created) is not
  specified beyond "active first". Harmless; carried to the reviewer.
- Review: spec ✅. Quality: **1 Important.** Fix round 1 dispatched.
- **I1 — `listActiveByOwner`'s test never seeds a second owner, so it cannot prove owner-scoping.**
  Confirmed by mutation: deleting the `ownerId` filter leaves all 7 tests green. This is the method a
  **visitor's public profile** calls, so an unscoped query would show one person's membership offer on
  somebody else's profile — a data-shaped leak that the suite as written would never catch. Exactly
  the vacuity the review dispatch named, found where it was named.
- Verified genuinely pinned, by mutation rather than reading: `listByOwner`'s own scoping (fails when
  its filter is dropped — so only ONE of the two was vacuous), `deactivate` updating rather than
  deleting, the migration's `(id, owner_id)` order with no stray modifiers, and `/dashboard/*`
  isolation — the reviewer diffed the `community` snapshot across the migration and found it
  byte-for-byte identical.
- The ordering call is **incidental**: reversing the secondary sort to newest-first leaves every test
  green. The implementer's disclosure was accurate. No action, since the brief specifies nothing
  beyond "active first".
- Fix round 1: `a8bf3d4`, test-only. Scoped re-review: **I1 ADDRESSED** — deleting the `ownerId`
  filter reddens exactly `"excludes deactivated tiers from listActiveByOwner, and other owners' tiers
  too"` (6 pass / 1 fail), and both of the narrower traps I asked about are closed: the second owner's
  tier is genuinely **active**, so the leak is caught by the `ownerId` filter rather than incidentally
  by `isActive`; and the assertion is `toEqual([active.id])` — contents, not length.

**Task 1: complete** (commits `f3aef8a`..`a8bf3d4`, review clean after 1 fix round).

### Task 2 — `user_subscription`, `user_transaction`, and their repository

- BASE `a8bf3d4`. Standard tier: the schema is given verbatim, but this task's whole value is three
  database constraints, and each is only proven by a test that shows the database REFUSING something.
- Implementer: `4d58473`, **2183 pass / 0 fail** (api +11). Typecheck clean. Migration
  `0025_numerous_thunderbird.sql` verified by eye for all three constraints: the composite FK naming
  both columns, the CHECK, and `WHERE status = 'active'` on the unique index.

**RULING — `cancel(id)` on the port, beyond the brief's stated minimum, is accepted.** It exists
because the partial-index test's second half needs a way to un-set `active`, and there was no other
route through the port. That second half is precisely what proves the index is PARTIAL rather than
plain, so refusing the method would have refused the test that carries the task's value. *Cost if
wrong:* one method 5b would have added anyway for cancellation.
- Review: spec ✅, quality **approved, no findings.**
- **The `rejects.toThrow()` vacuity risk was closed by evidence, not argument.** The reviewer
  instrumented the covering file to log the underlying `postgres.js` error — drizzle buries it under
  `.cause`, the outer error being only "Failed query" — then reverted and confirmed byte-identical
  restoration. Each rejection is caused by the constraint it claims:
  - owner/tier mismatch → `23503` on **`user_subscription_tier_owner_fk`**, the composite FK. Not the
    simple `owner_id → app_user` FK, which could not have fired: the fixture uses a real second user.
  - self-subscription → `23514` on **`user_subscription_no_self`**.
  - second active subscription → `23505` on **`user_subscription_one_active`**, the partial index.
  - the resubscribe-after-cancel half runs green in the same pass — which a plain non-partial unique
    index could not do.
- `/dashboard/*` isolation checked by grepping every dashboard table name outside `user_`-prefixed
  identifiers: no hits, and the only removed lines are file-header noise on pure additions.

**Task 2: complete** (commits `a8bf3d4`..`4d58473`, review clean, no fix round).

### Task 3 — payout onboarding

- BASE `4d58473`. **Most capable model**: this reproduces the claim-first sentinel that exists because
  30 concurrent requests once created 30 Xendit sub-accounts and orphaned 29 — and a managed
  sub-account is a KYC entity with no delete endpoint, so every orphan is permanent. Subtle
  concurrency, irreversible consequences.
- Carries the pre-flight F1 ruling: **do NOT reserve `payout`.** `/users/me/payout`'s first segment is
  `me`, already unregisterable; the guard reads only the first segment and will stay green.
- Implementer: `7436665`, `619fa4d`. **2222 pass / 0 fail** (api +39). Typecheck clean.
- **The concurrency test is genuine.** `Promise.all` over 30 invocations against one shared fake, all
  held at the read by an `ArrivalLatch(30)` so all 30 provably observe an unclaimed column — 1 provider
  call. Positive control: reordering to provider-first produced **`Received length: 30`**, reproducing
  the original incident exactly, then reverted. Postgres's own arbitration is pinned separately by a
  4-way latch test on the real `beginXenditAccountProvisioning`.
- **Its own mutation sweep found the exact bug I warned about**: a truthiness check in an early return,
  masked downstream by `payoutStatusOf`. The sentinel is truthy, so a truthiness check is the bug that
  would let Task 6 send `for_account_id: "provisioning:in-progress"` to Xendit. Two behavioural tests
  now kill it.
- `payout` NOT reserved, per the F1 ruling; the guard read `me` and stayed green either side of the
  mount, with only the filtered-out count moving.

**RULING — the four files beyond the brief are accepted.** A separate `UserPayoutRepositoryPort` keeps
the account id **off `UserRecord`, which is projected into HTTP responses** — that is a leak-shaped
reason, not a stylistic one — and splitting `GetUserPayoutStatus` from `ConnectUserPayout` mirrors the
creator flow, where the read must work on a box that has no payments provider configured at all.
*Cost if wrong:* two small files.

**RULING — POST returning 200 idempotently rather than 201/409 stands.** The brief mandates
idempotency and its own concurrency snippet has no `.catch`, so losing callers must resolve rather
than reject. *Cost if wrong:* a status code, changeable in one line.

**Carried to the reviewer, not ruled by me:** `PaymentProviderPort.createPaymentAccount`'s `creatorId`
field now carries an **app_user** id. The implementer did not rename it because renaming would edit
`create-payment-account.ts`, which is out of bounds — and the adapter never sends the field. That
reasoning holds, but a parameter whose name states the wrong entity is how the next reader is misled.
- Review: spec ✅. Quality: **1 Important, 3 Minor.** Fix round 1 dispatched with F1 and F2.

- **F1 (Important) — the race test cannot fail against the bug it guards.** The repository-level
  `ArrivalLatch(4)` test stayed `14 pass / 0 fail` across 5 runs when the conditional UPDATE was
  replaced by SELECT-then-unconditional-UPDATE. Measured against the real database: **check-then-act
  wins 1 of 4 contenders (green) but 27 of 30 (red)**, while the correct implementation wins 1 of 30.
  The shipped code is right; the guard on it is too small to catch its own bug. `4` → `30` was
  verified 3/3 green at 42-139 ms and verified to kill the mutant. **This is the vacuity pattern of
  this phase in statistical form** — not a missing assertion, an insufficient sample.
- **F2 (Minor, but taken)** — `creatorId` carrying an `app_user` id. The reviewer found an in-bounds
  fix I had not seen, and corrected my "inert" assumption: `FakePaymentAdapter` **interpolates it into
  `fake-acct-N-<app_user uuid>` on every dev box**, so it is not unused.
- **F3 (Minor, phase-level) — deferred, and surfaced to the owner.** Payout onboarding is ungated
  self-service: one permanent, undeletable MANAGED sub-account per open signup, with no eligibility
  gate and no rate limit. Parity with the creator flow, so not a regression — **but the `app_user`
  population is the public one**, which the creator population never was. Not fixable inside this
  task; it is a product decision about who may connect a payout account.
- **F4 — my plan's Step 3 for Task 4 was factually wrong** about `RESERVED_HANDLES`, the same defect
  the pre-flight caught for Task 3. **Fixed in the plan itself (`4f0fa69`)** before Task 4's brief is
  generated from it, rather than carried as a per-dispatch correction again.

**Both my rulings upheld, one on stronger evidence than I had.** The account id is kept off the wire by
**two independent barriers**: `DrizzleUserRepository` uses explicit column lists in every
`select`/`returning` (no bare `.select()` anywhere in the file), and `toOwnProfile` builds an explicit
literal rather than spreading. And the split is real rather than nominal — a route test boots
`createApp({...deps, connectUserPayout: undefined})` and gets a working GET plus a 503 POST.
- Fix round 1: `730a53b`. 340 pass / 0 fail across 8 covering files. Typecheck clean.
  - **F1 evidence exceeded what was asked.** With the mutant applied the raised latch fails 3/3 at
    **30 winners out of 30** (not 27 — every contender's SELECT saw NULL before any UPDATE landed).
    Then, keeping the same mutant, dropping the latch back to 4 gave **5 runs, 5 false passes**: the
    blind spot reproduced exactly as diagnosed rather than merely argued.
  - **F2 taken, and the type system validated my ruling.** The implementer first tried renaming
    `creatorId` to `ownerId` and `tsc` rejected it instantly — the adapters declare the shape inline,
    so a rename would have forced edits into the frozen files. `CreatePaymentAccountInput` extracted
    in the port alone; both adapters and `create-payment-account.ts` needed zero edits.

**RULING — the implementer's new concern is deferred to the final review, not fixed here.** It found
**four other `ArrivalLatch` tests in this repo that also use 4 contenders** (`drizzle-user`,
`drizzle-follow`, `drizzle-join-request`, `drizzle-renewal-reminder`). Each guards a **unique index**,
which arbitrates at any sample size in a way a conditional UPDATE does not — so they are probably
sound. *Why defer:* all four are pre-existing files outside this phase's scope, and "probably sound"
is a judgement worth making deliberately rather than inside a fix round for a different task. *Cost if
wrong:* one of those four is guarding something with the same blind spot F1 had. **The question the
implementer asked is the right one and should be answered: are those numbers evidence, or habit?**
- Scoped re-review: **both ADDRESSED**, reproduced independently rather than read. At latch 30 the
  mutant failed 3/3 with **30, 30, 28 winners out of 30**; with the same mutant and latch back at 4,
  **5 runs, 5 false passes (1 winner each)**. The docstring records the measurement and says "do not
  lower this number", so a future tidy-up has something to read. F2's docstring carries all four
  claims, and `create-payment-account.ts` and both adapters have **zero diff** — the out-of-bounds
  files stayed out of bounds.

**Task 3: complete** (commits `4d58473`..`730a53b`, review clean after 1 fix round).

### Task 4 — managing tiers

- BASE `730a53b`. Standard tier: CRUD over Task 1's repository, gated on Task 3's payout status.
- The plan's Step 3 was corrected in `4f0fa69`, so this brief no longer carries the wrong
  `RESERVED_HANDLES` instruction.
- Implementer: `9b37b86`, **2246 pass / 0 fail** (api +24). Reserved-handle guard green either side of
  the mount with `unprotected: []`, per the corrected instruction.
- **It verified the truthiness trap rather than asserting it**: after committing, it re-broke the gate
  to a truthiness check on the payout column and confirmed the tests catch it, then reverted. That is
  the exact bug Task 3 found in its own code, and the one that would have let a mid-provisioning
  account publish a tier that sends `for_account_id: "provisioning:in-progress"` to Xendit at checkout.
- Review: spec ✅ (§5, §6). Quality: **approved, no Critical or Important.**
  - The truthiness mutation is caught by `"THE SENTINEL DOES NOT COUNT AS CONNECTED: a mid-provisioning
    owner is refused too"`, and **every other test including the NULL one stayed green** — which is
    the whole distinction: a NULL-account test passes against a truthiness gate, only the sentinel
    case separates a correct gate from a broken one.
  - Ownership is not vacuous this time: the HTTP test seeds `rina` as a genuinely independent second
    owner with her own connected payout and tier — the Task 1 single-owner trap, avoided.
  - Deactivation proven not to disturb existing subscriptions by inserting a real `user_subscription`
    row and asserting its status and `current_period_end` are untouched.
- **Task 4: minor (deferred):** no task-specific test for a malformed non-UUID `:tierId` on PATCH —
  pre-existing shared middleware, already covered by `http/validate.test.ts`, so not a gap this task
  created.

**Task 4: complete** (commits `730a53b`..`9b37b86`, review clean, no fix round).

### Task 5 — the offer on a public profile

- BASE `9b37b86`. Standard tier: a projection, but the projection is the thing — a public endpoint
  that must expose exactly four fields about a tier and nothing else.
- Carries the pre-flight **F2 ruling: a new `tier-views.ts`**, not an addition to `post-views.ts`.
- Implementer: `2584071`, **2257 pass / 0 fail** (api +11). Typecheck clean. It verified the closed
  projection and the one-query behaviour by injecting three targeted bugs, catching all three, and
  reverting — rather than asserting either.
- Review: spec ✅ (§6). Quality: **approved, 1 Minor.**
  - Added-field mutation (`ownerId` into `toTierView`) reddened **5 named tests across three layers**,
    all via `Object.keys(...).sort()` against literal arrays rather than spot-checks.
  - The one-query claim was verified by **reading the mechanism**, not trusting the report: the fake
    repository records every `listActiveByOwner` call and the test asserts `toEqual(["user-1"])` —
    exact call count and argument, not inferred from output.
  - **The Phase 4 white-screen lesson is pinned:** the mutant returning `{}` instead of `{tiers: []}`
    reddens 5 tests. That is the mistake that produced a blank feed during every deploy last phase.
  - Removing the `ownerId` predicate reddens both Task 1's repository test AND Task 5's own
    "keeps one owner's tiers off another owner's profile" route test — the cross-owner leak this
    endpoint would produce is caught independently at both layers.
- **Task 5: minor (deferred):** `toMembershipView` trusts `listActiveByOwner`'s filtering rather than
  re-checking it — a documented layering choice, and not a gap, since the route test catches an
  owner-scoping regression anyway.

**Task 5: complete** (commits `9b37b86`..`2584071`, review clean, no fix round).

### Task 6 — starting a subscription

- BASE `2584071`. **Most capable model**: this opens real Xendit invoices, and the `external_id`
  namespace it mints is what Task 7's webhook routes on — a mistake here is a mistake in two tasks.
- Implementer: `bde2940`, `3aa98f5`. **2292 pass / 0 fail** (api +35). Typecheck clean. 14 hand-applied
  mutants all killed; one found a gap (the route's 503) which the second commit closes.

**RULING — `attachGatewayReference` beyond the brief is accepted, and it closes a hole I had not
seen.** Row-before-provider means the invoice id is unknowable at insert time, so without a way to
record it afterwards **Task 7 would inherit a transaction whose `body.id` is verified against
nothing** — precisely the hole the community webhook measured and fixed. It mirrors the community
port's method. *Cost if wrong:* one port method Task 7 needs anyway.

**CARRIED TO THE REVIEWER AND TO THE GATE — `payerWhatsappNumber` falls back to `""`.**
`app_user.whatsapp_number` is nullable (signup offers it, never requires it) while the provider port's
field is not, so a buyer without a number sends an empty `customer.mobile_number` to Xendit. **The
adapter is unverified against the real provider, and Xendit may reject an empty one** — which would
fail invoice creation for exactly the buyers who never filled that field in. Only a real Xendit call
can settle it, so it belongs on Task 11's gate as a named check.

- Noted, acceptable: `successRedirectUrl` is the owner's profile, since 5a has no status page for a
  user subscription.
- Review: spec ✅ (§6, §7). Quality: **2 Important, 3 Minor.** Fix round 1 dispatched with F1, F2, F3.
  - Sentinel mutation caught at BOTH levels, and **the NULL-payout tests stayed green under it** — the
    distinction held exactly as designed. Order-swap and `attachGatewayReference` removal each killed
    by their own named tests. Both my rulings confirmed; the method mirrors the community port line
    for line.

- **F1 (Important) — `payerWhatsappNumber ?? ""`.** The reviewer's judgement, which I adopt: **omit the
  field, do not send `""`.** Signup validates `whatsappNumber` with the same regex the community
  checkout uses but marks it `.optional()`, so the only other caller of this port field always sends a
  well-formed number — `""` is a shape Xendit has **never received from this code**, and one this
  repo's own rules would reject as junk. Absent is the documented "no number"; empty string is a value
  that must pass format validation. Refusing the purchase instead would block **the default state of
  every signup** on a guess about the provider.
- **F2 (Important) — nothing dedupes PENDING subscriptions.** Two taps create two live invoices. If
  both are paid, the second activation hits `user_subscription_one_active` as a **500 plus provider
  retries**, and 5a has no refund path. Spec-compliant as written — §6 refuses only an ACTIVE
  membership — but the outcome is a person charged twice.
- **F3 (Minor, taken)** — `userTransactionIdFromExternalId("usub_")` returns `""` and `("usub_x")`
  returns `"x"`; neither is a uuid, `findTransactionById` has no uuid guard (the community repo has
  one), and the reviewer measured both throwing at the driver. Once Task 7 routes on this, that is a
  **500 vector on a public webhook**.

**RULING on F2 — Task 6 must not mint a second live invoice while one is pending.** *Why:* every other
choice leaves real money mis-taken. Handling it only in Task 7 makes the second charge graceful rather
than absent, and the buyer is still out the money with no refund path in this phase. *How:* the
implementer chooses the mechanism — reuse the pending invoice, or refuse cleanly in Bahasa — because
it knows what it stored. *Cost if wrong:* a person who abandons checkout may need 5b's cleanup before
retrying, which is a bounded annoyance against an unbounded financial one. **Carried to Task 7
regardless: a second PAID for an already-active pair must not 500.**
- Fix round 1: `bc876e6`, `e71c156`. 433 pass / 0 fail across 20 covering files. Typecheck clean. Its
  own sweep found two more live mutants, closed in the second commit.
- F2 resolved by **reuse**: `user_transaction.gateway_invoice_url` + migration `0027_cloudy_the_call.sql`
  (additive, nullable); `attachGatewayReference` writes id and url in one statement.

**RULING — the F2 expiry gap is accepted and recorded, not closed here.** Nothing records whether a
stored invoice is still payable, so once it expires (~24 h) a re-tap hands the buyer a **dead payment
page**, and 5a has no way to mint a fresh one. *Why accept:* the alternatives are worse — a double
charge with no refund path, or refusing anyone who merely abandoned a checkout. The implementer
declined to invent a time-bound reuse window, which was right; guessing an expiry is how you get a
second live invoice back. *Cost if wrong:* a buyer who abandons checkout and returns a day later
cannot complete a purchase until 5b. **Closing it properly means recording the provider's
`expiry_date`, or 5b's pending-checkout cancel — which 5b needs anyway. Both go to 5b's spec, and the
dead-page case goes on Task 11's gate.**
- Scoped re-review: **all three ADDRESSED.** `mobile_number` is genuinely **absent** — the adapter test
  asserts `"mobile_number" in customer === false`, key absence rather than `=== undefined`. Reuse
  proven by two named tests plus a third pinning `isNotNull(gatewayInvoiceUrl)`. The uuid guard
  reddens with the exact predicted `PostgresError: invalid input syntax for type uuid: ""`.

- **NEW, and it joins the open findings: the second-tap guard is read-then-write with nothing
  arbitrating.** The re-reviewer reproduced two live invoices **without any mutation** — two concurrent
  `POST /subscribe` requests against the real database, 4 of 5 runs serialised cleanly and the 5th
  produced two subscriptions, two transactions and two invoices for the identical pair.
  `user_subscription_one_active` covers only `active`; nothing covers `pending`, and there is no lock.
  Sequential double-tap is genuinely closed; **concurrent double-tap is not** — and a double-tap on a
  phone is concurrent, not sequential.

**RULING — fix round 2: let the database arbitrate, as it already does everywhere else in this phase.**
A partial unique index on `(subscriber_id, owner_id) WHERE status = 'pending'`, mirroring the `active`
one from Task 2, with the losing insert's unique violation caught and turned into the same reuse path.
*Why this shape:* it is the pattern this codebase has now reached three times — Task 2's constraints,
Task 3's claim-first sentinel, and now here — because **application-level read-then-write cannot win a
race it does not arbitrate**. *Cost if wrong:* one migration and one catch branch.
- Fix round 2: `2227770`, `1b659cb`. 441 pass / 0 fail across 20 covering files. Typecheck clean. Its
  own sweep found that **the catch could be widened to a blanket one with the suite still green** —
  closed in the second commit, and exactly the narrowness I asked for.
- Migration `0028` adds `user_subscription_one_pending`. `claimPending` inserts first and matches
  `23505` **plus the constraint name**, rethrowing everything else; the loser routes into round 1's
  reuse path. Proven with **30 latched contenders** and **20 concurrent HTTP taps** asserting one
  invoice, one subscription, one transaction, no 500s. With the index dropped, the pre-fix code opened
  one invoice per contender in **every** run at 2, 4 and 20 — which is the measurement that justifies
  the HTTP count rather than a guess.

**RULING — releasing the claim on a failed provider call is accepted, though it changes a property
round 1 pinned.** A failed Xendit call now leaves the subscription `cancelled` rather than `pending`.
*Why:* without release, **one Xendit timeout wedges that buyer out of that creator permanently**,
since nothing in 5a clears a pending row — a worse outcome than the one the original ordering
protected against. The row-before-provider guarantee keeps its point: the transaction row still
remains, with a null gateway reference, so the failure stays inspectable. *Cost if wrong:* the
recoverable artefact is a cancelled row rather than a pending one.

**Carried to 5b:** a crash between claim and release leaves a pending row nobody clears, and that pair
then sees the transient refusal until someone clears it by hand. Same class as `ConnectUserPayout`'s
documented caveat, and it wants the same fix — expire or cancel a stale pending checkout. Together
with the **invoice-expiry gap** (unchanged), these are the two reasons 5b's pending-checkout cleanup
is not optional.
- Scoped re-review of round 2: **ADDRESSED.** With migration 0028 neutralised on a fresh isolated
  database and no repository code touched: **20 concurrent HTTP taps → 20 invoices**, and **30 latched
  contenders → 30 claims reporting `created: true`**, none arbitrated. Restored, diffed byte-identical,
  both tests green. That is proof the index does the work rather than the application logic around it.
- The catch is genuinely narrow: gated on SQLSTATE `23505` **plus the exact constraint name** through
  the pre-existing `pg-errors.ts` helper. Mutated to a blanket catch, the purpose-built test
  `"rethrows an error that is NOT the pending-claim violation, even when a pending row exists"`
  reddened — a stubbed connection failure was being swallowed and misreported as `created: false`.
- The row-before-provider guarantee survives the behaviour change: `cancel()` flips only the
  subscription's status, and the transaction row stays `pending` with a null gateway reference. Round
  1's pinning test was **updated rather than deleted**, keeping its other assertions.

**Task 6: complete** (commits `2584071`..`1b659cb`, review clean after 2 fix rounds — the most
expensive task of either phase, and both rounds were about money being taken twice).

### Task 7 — the webhook

- BASE `1b659cb`. **Most capable model**: this edits `handle-payment-webhook.ts`, which serves the live
  dashboard's money today.
- Implementer: `9fd1fbe`, `cdeeb94`. **2373 pass / 0 fail** (api, +59). Typecheck clean. 17 hand-applied
  mutants, all killed — one survived first (the replay guard) and drove the second commit.
- **The production diff is purely additive: zero deleted lines.** The community body moved into
  `settleCommunitySubscription` unchanged, proven by the pre-existing 88 community tests plus three new
  named regression tests plus throwing user-repo fakes in the community harness. On a file that serves
  live money, "I did not delete anything" is a stronger claim than "the tests pass".

**RULING — the one community-path behaviour change is accepted.** An `external_id` matching *neither*
shape used to 404 and is now 200-ignored, which spec §7 requires ("ignored, never assumed"). It cannot
touch a real invoice — every id this system mints is a bare uuid or `usub_<uuid>` — and **an unknown
bare uuid still 404s**, so the community path's own error signalling is intact. The existing route
test was **rewritten rather than deleted**, keeping its "does not 500" purpose. *Cost if wrong:* a
malformed id that used to be reported as missing is now silently accepted as somebody else's.

**RULING — "a second PAID must not 500" is met sequentially and NOT concurrently; I accept the
residue.** The already-active refusal is a graceful read; `user_subscription_one_active` remains the
arbiter for a genuine race, so a concurrent double activation is **one self-healing 500 whose retry
takes the graceful path**. *Why accept:* the outcome converges correctly — Xendit retries, the retry
succeeds, the membership ends active — and the difference from my ruling is one logged provider
failure rather than a loop. Eliminating it entirely needs a savepoint-absorbing repository outcome,
which is real complexity for a case Task 6's pending index already makes rare. *Cost if wrong:* one
500 in the provider's logs per concurrent duplicate. **Carried to the reviewer: verify it genuinely
self-heals and leaves no duplicate.**
- Review: spec ✅ (§7). Quality: **approved — no Critical, no Important.** Three Minors, all already on
  the implementer's record.
- **"Can the community path be affected?" — No, provably.** Zero deleted lines in the production file,
  verified per-file with `--numstat` (all 5 deletions in the range are in test files), and the moved
  body is **byte-identical**: old lines 117-378 against new 403-664, `diff` → identical, 262 lines.
  Mutation isolation confirmed both directions — breaking the user amount check reddens 4 unit + 2
  route tests, **zero community**; breaking the community one reddens 3 community, **zero user**.
- **Ruling 1 holds, on a stronger argument than mine.** `findTransactionByExternalId` has *always*
  opened with the byte-identical `UUID_PATTERN` guard returning `null`, so the ids that changed from
  404 to 200-ignored are **exactly the ones that already could not match a row**. Alternate Postgres
  uuid forms (braces, unhyphenated) 404'd before and are ignored now, having never been resolvable.
- **Ruling 2 verified by measurement, not reasoning, and the residue is smaller than I assumed.** A
  staged route-level race against the real index, 10 rounds, 9 raced: every time the loser 500s, its
  `webhook_event` row **rolls back with its unit of work**, the retry returns 200, and the end state is
  exactly one active subscription, one cancelled, both transactions paid, **no duplicate transaction**.
  Bounded at one 500 and one retry, and it cannot repeat — once the winner commits, `findActiveFor`
  returns non-null and the graceful branch is unconditional. **The racing state is unreachable through
  any route today**, because Task 6's `user_subscription_one_pending` forbids two pending rows for a
  pair; the reviewer had to stage a `cancelled` sibling to reproduce it at all.
- Also confirmed: `body.id` is checked against the `attachGatewayReference` column and **fails closed**
  when NULL; and both `NotFoundError` messages read `"unknown transaction"` — **deliberately
  identical, so a caller cannot learn which namespace it missed in**. That is the same existence-oracle
  defence Task 6's shared refusal message uses.

**Task 7: complete** (commits `1b659cb`..`cdeeb94`, review clean, no fix round).

### Task 8 — the membership check Phase 6 needs

- BASE `cdeeb94`. Standard tier: one query, but it is the question the entire next phase is built on.
- Implementer: `8734d5b`, **2380 pass / 0 fail** (api +7). It stalled once on the auto-background trap;
  resumed with the explicit-timeout instruction and finished in the foreground.
- The proof I asked for landed: deleting the `current_period_end` comparison reddens exactly
  `IsMemberOf > is false for an active subscription whose current_period_end has passed`. Without that,
  a status-only check would grant an expired membership access **forever**, since 5a has no renewal
  pass — and Phase 6's paywall is built on this answer.
- An EXPLAIN test on bulk-seeded data proves `Index Scan using user_subscription_one_active`, no seq
  scan. Phase 6 calls this per post on a feed, so that matters on the most valuable pages.

**RULING — the period comparison living in application code rather than in `findActiveFor`'s SQL is
accepted.** `findActiveFor` is also called by `start-user-subscription.ts` and
`handle-payment-webhook.ts`, where "active" means something different — those care whether a row
exists at all, not whether it is still within its paid period. Pushing the period filter into the
shared query would silently change both callers' semantics. *Cost if wrong:* one comparison outside
the database, still on a single indexed round-trip.

**Carried to the reviewer:** the EXPLAIN test **hand-mirrors** `findActiveFor`'s WHERE clause rather
than introspecting the real query, because that method is `async` and executes immediately with no
synchronous builder to hook `.toSQL()` into. The implementer disclosed it. Low drift risk on three
equality predicates — but an EXPLAIN test that proves an index works for a query nobody runs is
exactly the vacuity family this phase keeps finding.
- Review: spec ✅ (§8, §9). Quality: **1 Important, 1 Minor.** Fix round 1 dispatched.
- **I1 (Important) — the EXPLAIN test cannot fail.** Its WHERE clause is a hand-written literal that
  matches `findActiveFor`'s real query today, verified predicate-for-predicate — but nothing wires the
  two together. Edit `findActiveFor` later and this test stays green: the behavioural tests would catch
  a correctness regression, and **nothing would catch a silent performance regression** — a change that
  still returns the right row while the planner stops using the index. Phase 6 calls this per post on
  a feed, so that is the failure that matters. Honestly disclosed by the implementer and correctly
  scoped, hence Important rather than Critical.
- **Minor (deferred):** nothing pins the exact `current_period_end === now()` boundary. The spec uses
  strict `>` and the code matches, but the boundary itself is untested.
- **My ruling holds, and the reviewer found a sharper reason than mine.** Narrowing `findActiveFor` to
  include the period filter would let a **lapsed-but-still-`active` row — §9's own honest gap — slip
  past both other callers' guards and then collide with `user_subscription_one_active` at activation
  time.** That is a real bug, not a semantic quibble. The comparison stays on the single row already
  fetched by one indexed `LIMIT 1`.
- Fix round 1: `b574236`. 190 pass / 0 fail across the covering files. Typecheck clean. Both findings
  closed with the evidence I asked for: the EXPLAIN test **now reddens** when a predicate defeating the
  partial index is added to the real query, and the boundary test reddens on `>` → `>=`.
- Scoped re-review: **both ADDRESSED.** I1 verified by mutating the **real** `activeMembershipQuery`
  predicate to a syntactically different but logically equivalent form — the planner fell back to
  `user_subscription_owner_idx` via Bitmap Heap Scan and the EXPLAIN test reddened. That is proof the
  wiring is genuine rather than cosmetic. `findActiveFor` is unchanged for its other two callers: same
  signature, same uuid guard, same status-only predicate, no period narrowing.

**Task 8: complete** (commits `cdeeb94`..`b574236`, review clean after 1 fix round).

**THE SERVER SIDE OF PHASE 5a IS COMPLETE.** Tasks 1-8: the tier, the subscription with three database
constraints, payout onboarding with a race-proof claim, the tier editor, the public offer, checkout
with exactly-one-invoice under concurrency, the webhook that activates without disturbing live
dashboard money, and the indexed membership question Phase 6 is built on. api 2380 pass / 0 fail
against a 2165 baseline.

### Task 9 — Pengaturan: payout and tiers

- BASE `b574236`. **Most capable model**: the brief is thin, this is the phase's first React surface,
  and Phase 4's two web tasks needed its most fix rounds.
- Implementer: `6431196`, `f242086`, `58649aa`. Web **750 → 779 pass / 0 fail** (+29). Typecheck clean.

**RULING — "edit" leaves 5a; the SPEC is what changes, and this is my defect.** Spec §6 says the tier
editor does "create, edit, **deactivate**", but the server exposes no rename and no reprice: Task 4
built create/list/deactivate, `PATCH /users/me/tiers/:tierId` accepts exactly `{ isActive: false }`,
and **Task 4's review passed spec ✅ without anyone noticing the missing verb** — including me. The
implementer shipped create + withdraw rather than a button that could only fail, which was right.
*Decision:* 5a ships create and deactivate; editing moves to 5b. *Why:* repricing for existing members
is already out of scope by §11, so the only safe edit is a rename — not worth a server task inside a
money phase, and a rename is recoverable today by deactivating and creating again. *Cost if wrong:* a
creator lives with a typo in a tier name until 5b.

**RULING — the fourth `available` branch is accepted.** `GET /users/me/payout` reports whether the box
has a payment provider at all, and folding that into "not connected" would offer a button that earns a
503 blaming the server. Only the NULL state offers a button. *Cost if wrong:* one branch.

**CARRIED TO THE FINAL REVIEW — a test weakness that is probably not confined to this task.** A
surviving mutant replaced `describeRequestFailure(err)` with the server's own raw string and **all 20
tests stayed green**, because `queryAllByText("<exact sentence>")` cannot see a sentence a screen
*appends* to its own. The implementer rewrote all four to assert on the alert's `textContent` in both
directions, each now reddening under that mutation — and flagged that **the same weak form may exist
elsewhere in `src/user`'s tests**. That is exactly the shape `no-raw-server-errors` exists to prevent,
and it deserves a codebase-wide look.
- Review: spec ✅ (§5, §6, with "edit" ruled out). Quality: **approved — 3 Minor, no Critical or
  Important.** Both my rulings confirmed in source: `patchUserTierSchema` is literally `z.literal(false)`,
  so the server genuinely has no rename and no reprice; and the four payout branches expose exactly one
  `<button>`, with the three non-NULL states each asserting zero connect buttons.
- **The weak-assertion question was answered by measurement, and it narrows well.** The blind form is
  specifically the *exact-string* negative `queryAllByText("…").length === 0`; a regex negative does see
  a substring and is not blind. Seven sites across five files use it — but mutating every appending
  error site in `src/user` gave 417 pass / **13 fail**: every file caught it somewhere. **Exactly one
  test is genuinely blind**, `FollowButton.test.tsx:233` — the one whose name says it exists to catch
  precisely this. The other six negatives are decorative, backstopped by strong positive assertions.
  Re-running against the pre-fix file confirmed the implementer's own diagnosis and narrowed it: only
  its create test was blind.

**Task 9: minor (deferred), all three to the final review:**
- `FollowButton.test.tsx:233` cannot detect the violation it names. **The one real gap**, and worth
  fixing with the `textContent` + `not.toContain` shape the other six could also adopt.
- `MembershipSettings.tsx:339-343` fabricates a `ready` tier list from `loading`/`error`: a create
  racing the list load **loses the new tier to the late response**, and a create after a failed list
  load silently clears the error and **shows a one-item list as if it were the whole offer**.
- `PayoutState` tests `!available` before `connected`, so a connected creator on a box whose provider
  was de-configured is told payments are unavailable while the tier editor stays open.

**Task 9: complete** (commits `b574236`..`58649aa`, review clean, no fix round).

### Task 10 — the profile offer and "Jadi anggota"

- BASE `58649aa`. **Most capable model**: the buyer's half, the last surface before money, and the
  thinnest brief left.
- Implementer: `a5e788d`. Web **779 → 808 pass / 0 fail** (+29). Typecheck clean. 12-mutant sweep, all
  caught — including the raw-server-string mutant, which reddens from `MembershipOffer.test.tsx` itself
  (3 tests) rather than only from the guard. That is the shape Task 9's finding demanded.
- **It found the Phase 4 white-screen bug recurring, in a new place.** A bare `profile.membership.tiers`
  **throws during render** against a response predating Task 5 — measured, it blanked the *entire*
  profile page (name, bio, counts, feed), not just the offer. Read tolerantly now, with a regression
  test. Same class as Phase 4's `post.media` version-skew outage, found by an implementer rather than
  a reviewer this time.
- Its one scare was diagnosed correctly rather than assumed: a full-suite run auto-backgrounded past
  120 s with `bun test` at 469 MB RSS — **not** a hanging DOM assertion, but that render crash
  poisoning later files. Killed immediately.

**RULING — accept the three shared helpers**, rather than a second copy of `isOwnHandle` and
`billingCycleLabel` in a third file. `FollowButton`'s own asymmetric-`.toLowerCase()` postmortem is the
argument. *Cost if wrong:* two helpers move.

**RULING — BUILD `viewerIsMember`; the spec requirement is real and the implementer was right not to
fake it.** §6 requires that an already-active member sees they are a member rather than a buy button,
and **no data exists for it**: the profile projection is closed to tiers, and `IsMemberOf` — the whole
point of Task 8 — **is wired to no route at all.** The implementer refused to ship a `viewerIsMember`
the server never sends, which would have been dead code no test could redden. Correct call.
*Decision:* widen `MembershipView` with `viewerIsMember`, filled by the existing `IsMemberOf`.
*Why it is worth the round:* it is ~15 lines over an already-reviewed function; it is the difference
between a member seeing their membership and a member being offered a purchase that 409s; **and it is
the only thing that puts Task 8's function on a real request path** — Phase 6's foundation is
currently unreachable and therefore unproven end to end. It also settles §9 honestly, since
`IsMemberOf` requires `current_period_end > now()`, so a lapsed member correctly sees the offer again.
*Cost if wrong:* one boolean on one projection.
- Fix round 1: `6a4a0b9`. api **2381 → 2395**, web **808 → 814**, both 0 fail. Typechecks clean. 8-mutant
  sweep, all caught.
- **The lapsed evidence is exactly what the ruling asked for:** replacing `IsMemberOf`'s period
  comparison with `return true` — the "simplified to a status check" regression — reddens exactly the
  two lapsed tests, one unit (real `IsMemberOf` + `FixedClock`, never a stub) and one through HTTP
  against a real database, the latter also asserting the seeded row really is `status='active'` with
  `current_period_end` in 2020 so it cannot pass for the wrong reason.
- **Signed-out is `false`, never `null`, and asks the database nothing.** The implementer's argument is
  better than a convention: `viewerFollows` next door is tri-state because it **drives a toggle** whose
  three values are three different controls, whereas `viewerIsMember` **gates a claim about the
  caller** — and for someone the server cannot identify, the only safe answer is no. **A tri-state
  would invite `!== false` and tell a stranger they hold a membership.** Pinned three ways, including
  a signed-out browser handed `true` still getting the Masuk link.
- `GetUserProfile` takes the `IsMemberOf` **use case**, not a repository, because the half a
  re-derivation would lose is `current_period_end > now`. The member branch runs **before** the
  empty-tier return, so a member of a creator who has since withdrawn every tier is still told they
  are one — deactivate never deletes, by design.
- Noted cost: a signed-in profile view now makes one extra indexed read on
  `user_subscription_one_active`, alongside the three the profile already made. It is the same query
  Phase 6 will run per gated post, so it is now measured on a real path rather than in isolation.
- Scoped re-review: **ADDRESSED.** The lapsed mutation reddens **exactly two** named tests and nothing
  else moved. Adding a field to a tier reddens 4 exact-array assertions; adding one to `membership`
  reddens 4 more — **all `toEqual`/sorted `Object.keys`, none loosened to `toContain`.** The anonymous
  path is confirmed in code to short-circuit before `IsMemberOf` and before the database, with
  no-token, garbage-token and expired-token all collapsing to `null`; and the web panel gates on the
  browser's own session, so a hostile `viewerIsMember: true` to a signed-out browser still renders the
  Masuk link. `IsMemberOf` is the injected use case on the real route, and `bootstrap` constructs it
  **outside** the payments gate — a profile read does not require payments to be configured.

**Task 10: complete** (commits `58649aa`..`6a4a0b9`, review clean after 1 fix round).

**ALL TEN BUILD TASKS COMPLETE.** api 2395 / web 814, both 0 fail.

### Task 11 — the gate checklist

**RULING — I write this myself rather than dispatching it**, as in Phase 4. It is a document addressed
TO the project owner, and its value is entirely in knowing what the other ten tasks built, which
findings qualified them, and which risks reached the end unproven. A subagent would have to be handed
all of that and would still write it second-hand. *Cost if wrong:* the whole-branch review reads it
like any other file.
- Written and committed: `docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md`. Eight
  steps, unproven things first, opening with a TEST MODE warning because a managed sub-account cannot
  be deleted. Step 5 is the double-tap; step 7 is a real community payment through the old flow.

**Task 11: complete. ALL ELEVEN TASKS COMPLETE.** Next: the whole-branch review.

## Final whole-branch review — 2 Important, both cheap

Baseline re-established independently: api 2395/0 (289 s), web 814/0, shared 85/0, worker 52/0,
typecheck clean in all four. Re-proved: the community webhook body is byte-identical across 262 lines
with **zero deleted lines anywhere** in that production file; no dashboard table is touched by any
added line or migration; the payout id cannot reach the wire (no bare `.select()` in
`DrizzleUserRepository`); every projection closed and asserted against literals; the sentinel never
truthiness-checked; all 63 `NotFoundError` sites English.

- **I1 (Important) — a lapsed member is offered the tier and then refused it.** Two use cases answer
  "is this person a member" differently **by design**: `IsMemberOf` is period-aware, `findActiveFor`
  (the refusal at `start-user-subscription.ts:167`) is status-only. §9 guarantees they diverge one
  billing cycle after **every** purchase. Measured: `viewerIsMember → false` so the offer and button
  render, then `POST /subscribe → 409 "Anda sudah menjadi anggota aktif kreator ini."` The web advises
  "reload the page", which re-renders the same button — **the loop that cannot terminate** that
  `describeUploadFailure` was written to forbid. Two comments assert the opposite of measured
  behaviour. **The obvious fix is the dangerous one:** narrowing line 167 puts the purchase on a
  collision course with `user_subscription_one_active` at activation.
- **I2 (Important) — one failed statement wedges a buyer out of a creator permanently, and calls it
  temporary.** Round 2's release covers only `createInvoice`; `createTransaction` and
  `attachGatewayReference` sit outside it. Measured on the real route with one simulated connection
  reset and no production logic touched: attempt 1 → 500 with an invoice already open at the provider;
  attempts 2 and 3 → 409 *"Tunggu sebentar, lalu coba lagi"*; `findPendingCheckout → null` forever.
  **That is the ledger's crash-between-claim-and-release gap without a crash.** ~6 lines.

**Charged without becoming a member, or vice versa — the answer.** *Member without paying: no*, and the
chain was enumerated: one statement writes `status='active'`, reached by one caller, behind namespace
routing before any DB access, a non-NULL gateway reference matching `body.id` (fails closed on NULL),
our-amount-against-their-claim, a fresh `provider_event_id` in the same transaction as the activation,
exact `"PAID"`, and a re-read `pending` transaction. *Charged without a membership:* only on the
record, plus one new entry condition (M4, a checkout-side race nobody had written down).

**THE GAPS COMPOUND, AND THE WORST CASE NEEDS NO FAILURE AT ALL — the ordinary abandoned cart.** Come
back after ~24 h and `resolveExistingCheckout` hands back the same, now-expired invoice with a 201 and
a dead payment page, **permanently**. The reviewer calls it the phase's most likely real-world money
loss. It makes 5b's pending-checkout cleanup non-optional, and it goes to the owner.

**MY DEFERRAL'S PREMISE WAS WRONG about `ArrivalLatch(4)`, though the numbers survive.** I recorded
that those four guard *unique indexes*, which arbitrate at any sample size. **Two of them do not:**
`join-request.decide` is a conditional UPDATE structurally identical to `beginXenditAccountProvisioning`,
and so is `subscription.markPastDue` — which was not even on the list and sits on the **live renewal
money path**. The reviewer applied F1's own read-then-act mutant to both: **red 5/5 and 3/3 at four
contenders**, reverted byte-identical. So they are adequate — but because of how their awaits
interleave, not for the reason I gave. The measurement should be written beside them, as Task 3's was.

## Final fix wave — `07ee7ae`, all five findings

api **2395 → 2410**, web **814 → 823**, shared 85/0, worker 52/0, typecheck clean in all four.

- **I1 fixed by making the contradiction unrepresentable, not by handling it.** The guard was left
  untouched, as ruled. A new `MembershipStanding` (`member`/`lapsed`/`none`) is one pure function over
  the row `findActiveFor` already returns, and `IsMemberOf.execute` is now defined in terms of it. The
  409 says the membership ended and renewal is unavailable — a distinct sentence from the genuine
  already-active case — and `MembershipView` gained `viewerMembershipEnded` **projected from the
  standing, so `true`/`true` cannot be represented**. The offer no longer renders at all for a lapsed
  member, and the retry advice is gone, so the loop cannot form. Six comments carrying the wrong belief
  were corrected — four more than the review found.
- **I2 fixed by widening the `try` to span claim → createTransaction → createInvoice →
  attachGatewayReference**, with `releaseClaim` no longer able to throw over the original error.
  Pinned at **each statement** at the use-case level and through the real HTTP route against the real
  database; narrowing the release back to round 2's scope reddens 4 + 2 tests.
- **M1** — seven 409s enumerated, not five, with the transient one marked as the only retry-fixable case.
- **M2 verified the way a document should be:** the cleanup block was **executed after being read out
  of the markdown**. Old order → `23503` on
  `user_transaction_user_subscription_id_user_subscription_id_fk`; new order → 4 statements, clean,
  idempotent, bystander account untouched.
- **ArrivalLatch measurements written beside `join-request.decide` and `subscription.markPastDue`**,
  with why they hold and "do not lower this number". Comment-only; `markPastDue`'s production file was
  never opened.

**Deliberate omission, recorded for 5b:** `drizzle-renewal-reminder.repository.test.ts:130-136`'s
mechanism claim — on the review's ship list and outside this wave's instructions.

## Scoped re-review of the fix wave — all ADDRESSED

- **The "unrepresentable" claim was measured and narrowed, not accepted.** By construction of the sole
  producer: **yes**. By the type: **no** — the re-reviewer compiled
  `{ tiers: [], viewerIsMember: true, viewerMembershipEnded: true }` and typecheck exited 0. But
  `toMembershipView` is the **only** producer of a `MembershipView` anywhere in `apps/api/src`,
  production and tests both, grepped in both directions; it takes a three-value union with no default
  and derives both booleans in one return expression, so both-true would require
  `standing === "member" && standing === "lapsed"`. There is no partial-failure path — if `describe`
  rejects, the whole `Promise.all` rejects and no profile is returned. Stronger than "the tests do not
  do it", weaker than "the type forbids it". **The fixer's wording overstated it slightly, and the
  re-reviewer said so.**
- **The purchase guard was left alone**, confirmed three ways: the condition is unchanged,
  `membershipStanding` appears only *inside* the `throw` choosing a sentence, and `findActiveFor` /
  `activeMembershipQuery` are not in the diff at all. `IsMemberOf.execute` is semantically
  byte-identical, so **Phase 6's gate did not move.**
- **I2 verified by failure injection at every statement in the widened range**, on the real route
  against the real database: each of `claimPending`, `createTransaction`, `createInvoice` and
  `attachGatewayReference` releases the claim and lets attempt 2 return **201**. Re-narrowing the
  release reproduced the review's exact symptom on three of the four.
- Collapsing the two sentences reddens 4 named unit tests **plus the HTTP pin** — one more than the
  fixer listed. The cleanup SQL was executed parsed straight out of the fenced block, no statement
  retyped: old order → `23503`, the document's order → clean, second pass a no-op.

**Recorded for 5b:** a lapsed member now sees **no tier list at all** on that creator — honest, but a
real loss of information; and widening the release means an `attachGatewayReference` failure orphans a
live invoice while letting the buyer open a second (the review's own M5 class, accepted, unreachable
today).

**Phase 5a complete.** api 2410 / web 823 / shared 85 / worker 52, all 0 fail.
