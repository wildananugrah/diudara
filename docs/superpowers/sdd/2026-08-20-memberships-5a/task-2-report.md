# Task 2 report: `user_subscription`, `user_transaction`, and their repository

## What was built

- `apps/api/src/db/schema.ts` — added `userSubscriptions` (`user_subscription`) and
  `userTransactions` (`user_transaction`), verbatim from the brief. Added `foreignKey`
  to the `drizzle-orm/pg-core` import (the others — `check`, `uniqueIndex`, `index` —
  were already imported by Task 1).
- `apps/api/drizzle/0025_numerous_thunderbird.sql` — the generated migration.
- `apps/api/src/db/test-helpers.ts` — added both tables to `resetDatabase`, cleared in
  the order `userTransactions`, then `userSubscriptions`, then `userTiers` (the existing
  Task 1 line), matching each table's FK dependency.
- `apps/api/src/application/ports/user-subscription-repository.port.ts` — new port:
  `UserSubscriptionRow`, `UserTransactionRow`, `UserSubscriptionRepositoryPort` with
  `create`, `findById`, `activate(id, periodEnd)`, `cancel(id)`, `findActiveFor`,
  `createTransaction`, `findTransactionById`, `markTransactionPaid`. `cancel` is beyond
  the brief's stated minimum, but the third constraint test (see below) requires
  cancelling a subscription to prove the unique index is partial, and there was no
  other way to flip status back off `active` through the port.
- `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts` —
  `DrizzleUserSubscriptionRepository`, constructed with a `DatabaseExecutor` exactly as
  Task 1's repository is, implementing the port above with plain drizzle
  insert/select/update calls.
- `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`
  — 11 tests: ordinary CRUD for both tables, plus the three brief-mandated constraint
  tests.

## Red phase output

**Stub 1 — file doesn't exist yet** (confirms the test file genuinely depends on the
implementation, not a stale import):

```
error: Cannot find module './drizzle-user-subscription.repository' from
'.../drizzle-user-subscription.repository.test.ts'
 0 pass
 1 fail
 1 error
Ran 1 test across 1 file.
```

**Stub 2 — implementation file present, every method `throw new Error("not implemented")`**:

```
 2 pass
 9 fail
 2 expect() calls
Ran 11 tests across 1 file.
```

The 2 "pass" were the two `.rejects.toThrow()` constraint tests (self-subscription and
owner-mismatch) — a stub throwing `"not implemented"` trivially satisfies `.toThrow()`
with no `Error` message assertion, so this is an artifact of stubbing, not evidence the
constraints work. Every other test failed with `error: not implemented` at its own
call site, confirming each depends on real behaviour rather than a shared setup bug.
After the real implementation went in, all 11 passed, including those same two
constraint tests now failing/passing for the actual reason (a real Postgres constraint
violation caught by `.rejects.toThrow()`), verified by reading the full green run below.

## Migration SQL verified by eye

File: `apps/api/drizzle/0025_numerous_thunderbird.sql`.

1. **Composite FK naming both columns:**
   ```sql
   ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_tier_owner_fk"
     FOREIGN KEY ("tier_id","owner_id")
     REFERENCES "public"."user_tier"("id","owner_id")
     ON DELETE no action ON UPDATE no action;
   ```
   Both `tier_id` and `owner_id` are named on both sides — this is what makes an
   owner-mismatched subscription physically impossible to insert.

2. **The CHECK is present:**
   ```sql
   CONSTRAINT "user_subscription_no_self" CHECK
     ("user_subscription"."subscriber_id" <> "user_subscription"."owner_id")
   ```

3. **The unique index carries `WHERE status = 'active'`:**
   ```sql
   CREATE UNIQUE INDEX "user_subscription_one_active" ON "user_subscription"
     USING btree ("subscriber_id","owner_id")
     WHERE "user_subscription"."status" = 'active';
   ```
   Confirmed partial, not a plain unique index — no modifier was silently dropped.

## Test counts

- Before this task: 2172 tests passing (api suite).
- After this task: **2183 pass, 0 fail**, across 147 files (241.22s) — 11 new tests
  in the covering file, all passing for their own reasons.
- `bun run typecheck` — clean, no errors.

## Constraint tests, specifically

- **Owner/tier mismatch** — carol subscribes to alice's tier while claiming bob owns
  it: `subs.create({...ownerId: bob.id})` rejects (composite FK violation).
- **Self-subscription** — alice subscribing to her own tier (`subscriberId ===
  ownerId`) rejects (CHECK violation).
- **Partial unique index, both halves:**
  - Two subscriptions created for the same (subscriber, owner) pair, first activated;
    activating the second (making it the second row with `status = 'active'` for that
    pair) rejects with a unique-violation.
  - The first is then cancelled (`status` flips off `'active'`), and activating the
    second now succeeds — proving the index only constrains rows where
    `status = 'active'`, not the pair permanently.

## Commit

`4d58473` — `feat(api): add user_subscription and user_transaction tables (Task 2, Phase 5a)`

Working tree confirmed clean after commit (`git status` → "nothing to commit, working
tree clean").

## Self-review notes

- Confirmed only the five listed files (plus generated migration/meta) changed; nothing
  under `/dashboard/*`'s tables (`community`, `membership_tier`, `member`,
  `subscription`, `transaction`, `creator`) was touched.
- `handle-payment-webhook.ts` (Task 7's target) already exists in this worktree
  (presumably from the dashboard's own existing webhook, or scaffolded ahead) — the
  `amount` column's comment references it exactly as the brief specifies verbatim; not
  verified further since Task 7 is out of scope here.
- Nothing unresolved. No blockers.
