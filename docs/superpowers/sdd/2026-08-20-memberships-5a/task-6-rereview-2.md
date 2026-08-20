# Task 6 fix round 2 — re-review

Reviewed: `e71c156..1b659cb` (`2227770`, `1b659cb`) on `feat/memberships`, worktree
`.worktrees/memberships`. Inputs: `task-6-rereview-1.md` (the concurrency finding),
`task-6-report.md` (fix round 2 appended), `review-e71c156..1b659cb.diff`.

## Verdict: the concurrency finding is ADDRESSED

## The concurrency dedupe — ADDRESSED, confirmed by dropping the arbitrating index

Migration `0028_lowly_kat_farrell.sql` adds
`CREATE UNIQUE INDEX "user_subscription_one_pending" ON "user_subscription" USING btree
("subscriber_id","owner_id") WHERE "user_subscription"."status" = 'pending'`. `claimPending`
(`drizzle-user-subscription.repository.ts`) inserts first and converts the losing insert's
`23505` on that exact constraint name into the existing reuse path
(`resolveExistingCheckout` in the use case); every other error is rethrown untouched.

**Baseline (index in place):** ran the full covering-file set —
`users.test.ts`, `start-user-subscription.test.ts`,
`drizzle-user-subscription.repository.test.ts`, `bootstrap.test.ts`, `src/db/`,
`user-payment.test.ts`, `src/infrastructure/payments/` — **441 pass, 0 fail, 1289
expect() calls, 20 files, 86.6s**. `bun run typecheck` clean.

**Index dropped, then reproduced.** Since this suite creates one fresh isolated Postgres
database per `bun test` run and migrates it from `drizzle/*.sql`, the arbitrating index was
removed by replacing `drizzle/0028_lowly_kat_farrell.sql`'s content with a no-op (`SELECT
1;`) — no repository code was touched, so this is the pre-fix read-then-write path with
nothing arbitrating it, exactly as it shipped at `e71c156`. Ran the two committed
concurrency tests against that database:

- HTTP level, `"TWENTY CONCURRENT TAPS open exactly ONE invoice, and nobody sees a 500"`
  (`routes/users.test.ts`): **20 contenders → 20 invoices** minted at the fake provider
  (`expect(...).toHaveLength(1)` failed with `Received length: 20`). Real HTTP requests
  through the real router and repository — every one of the 20 opened its own invoice.
- Repository level, `"lets exactly ONE of thirty concurrent claims create the row"`
  (`drizzle-user-subscription.repository.test.ts`): **30 latched contenders → 30 claims
  reporting `created: true`** (`expect(...).toHaveLength(1)` failed with `Received length:
  30`) — every contender inserted its own pending row, none arbitrated.

Both numbers match the report's disclosure ("one invoice per contender, every time... the
defect the re-review saw once in five, reproduced here in every run") and confirm the
index — not incidental ordering — is what makes the tests pass. Restored
`drizzle/0028_lowly_kat_farrell.sql` from `git checkout --`, diffed byte-for-byte against
the original, and reran both tests: green again (repository test 1 pass; the HTTP test
1 pass, 29 expect() calls).

## The catch is genuinely narrow — confirmed by mutation

`claimPending` matches on `uniqueViolationConstraint(err) !== PENDING_SUBSCRIPTION_CONSTRAINT`
before treating an insert failure as "somebody else holds the slot." `uniqueViolationConstraint`
(`pg-errors.ts`, shared and pre-existing) walks `err`/`err.cause` up to 5 levels and returns
a name only when `code === "23505"` — SQLSTATE unique_violation specifically, read from the
driver's `constraint_name` field, never the message text.

**Mutation: widened the check to a blanket catch** (`if (false) { throw err; }` in place of
the constraint-name comparison) and reran only
`"rethrows an error that is NOT the pending-claim violation, even when a pending row
exists"` (the test `1b659cb` added specifically to kill this mutant, since a real
double-fault insert can't — Postgres reports `23505` on the pending index before it ever
reaches the tier foreign key's `23503`). **Reddened**: `Expected promise that rejects,
Received promise that resolved` — the stubbed connection failure was swallowed and answered
as `created: false`, exactly the failure mode the finding worried about (a buyer told to
wait for an invoice nobody is opening). Reverted the one-line edit; `git status` clean
before and after.

## The deliberate behaviour change (pending → released-to-cancelled on provider failure)

- **Transaction row survives, gateway reference stays null.** `openInvoice` catches the
  provider failure, calls `this.subscriptions.cancel(subscriptionId)` (which only flips
  `user_subscription.status`, per `cancel()` in the repository — `set({ status:
  "cancelled" })`, nothing touches `user_transaction`), then rethrows. The transaction row
  created just before the provider call is never modified by the failure path. Both
  updated tests assert this directly:
  `transactions[0]!.status === "pending"` and `transactions[0]!.gatewayReferenceId ===
  null` in `"leaves a PENDING subscription and transaction behind..."`
  (`start-user-subscription.test.ts`), and the HTTP-level equivalent in `users.test.ts`
  asserts the same on `txns[0]`. So the row-before-provider ordering's whole point —
  the failure stays inspectable — survives round 2 intact; only the subscription's
  *claim* on the pending slot is given back, not the audit trail.
- **Round 1's pinning test was updated, not deleted, and still asserts something
  meaningful.** `"leaves a PENDING subscription and transaction behind when the provider
  call fails"` (retitled from round 1) now asserts `subscriptions[0]!.status ===
  "cancelled"` instead of `"pending"`, with an inline comment explaining the trade
  (row stays, claim is released). It keeps every other assertion: 1 subscription row,
  1 transaction row (`status: "pending"`), `gatewayReferenceId === null`,
  `payments.invoices` empty. Nothing was weakened to make the suite pass — the assertion
  that changed is exactly the one the round-2 fix intentionally changed.
- **A cancelled row does not block a later retry, and its (nonexistent) invoice is never
  reused.** `findPendingCheckout`'s WHERE clause filters on
  `eq(userSubscriptions.status, "pending")` — a `cancelled` row is excluded identically to
  an `active` one, so it can never be handed back on retry. `"a pending row whose provider
  call FAILED does not block a fresh attempt"` (updated) confirms this end-to-end: after a
  failed first attempt and a successful retry, `subscriptions.map(r => r.status) ===
  ["cancelled", "pending"]`, `transactions` has 2 rows, but `payments.invoices` has
  length 1 — exactly one invoice open, the cancelled row's (never-opened) invoice is not
  and cannot be reused since it has no `gatewayInvoiceUrl` in the first place, and the
  fresh claim succeeds because `user_subscription_one_pending` is partial on
  `status = 'pending'`.

## Also verified

- **Migration 0028 is additive, touches no pre-existing table.** The SQL file is one
  statement — `CREATE UNIQUE INDEX ... ON "user_subscription" ...` — no `ALTER`, no
  `DROP`, no touch of `community`, `membership_tier`, `member`, `subscription`,
  `transaction`, or `creator`. `_journal.json` records it as sequential entry `idx: 28`
  after `0027_cloudy_the_call`. The matching `schema.ts` diff (`git diff
  e71c156..1b659cb -- src/db/schema.ts`) is a pure addition inside the existing
  `userSubscriptions` table definition — a second partial `uniqueIndex`, nothing removed
  or altered.
- **No new breakage.** `git diff e71c156..1b659cb -- src/routes/dashboard.ts
  src/application/use-cases/start-checkout.ts
  src/application/use-cases/handle-payment-webhook.ts` is empty — none of the three
  files this round was asked to protect appear anywhere in the fix diff.
- **No test contacts Xendit.** Grepped the three covering test files for real-adapter or
  live-endpoint references outside `FakePaymentAdapter`/`fake-checkout.local`/"fake
  payment" strings — no matches.
- **Tests assert literal values, not the constants they check.** The Bahasa transient
  refusal ("Pembayaran Anda sedang disiapkan...") and the existing reuse refusal are both
  spelled out in full at each call site rather than imported from production code; ids
  (`sub-inflight`), invoice urls (`https://fake-checkout.local/fake-inv-1`), and contender
  counts (20, 30) are concrete literals matching what the report disclosed.

## Hygiene

Two mutations applied this round, each reverted immediately after observing the red
result: `drizzle/0028_lowly_kat_farrell.sql`'s content (swapped for a no-op, restored via
`git checkout --` and diffed byte-identical against the original) and the constraint-name
check in `DrizzleUserSubscriptionRepository.claimPending` (edited to `if (false)`, reverted
via `Edit`). No scratch files were created or left behind. Final `git status` (both at the
worktree root and inside `apps/api`) reports "nothing to commit, working tree clean" before
and after. `.superpowers/` is gitignored; this report was written there without
force-adding anything.
