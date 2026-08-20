# Task 2 review: `user_subscription`, `user_transaction`, and their repository

## Verdicts

- **Spec compliance: ✅**
- **Task quality: approved**

## Method

Read the brief, the report, and the full diff (`review-a8bf3d4..4d58473.diff`). Read the
generated migration `apps/api/drizzle/0025_numerous_thunderbird.sql` by eye. Read
`schema.ts`, the port, the repository, and the test file in full (not just the diff hunks).
Confirmed `git status` was clean before starting.

To settle the actual point of this review — *which* Postgres object rejects each of the
three `.rejects.toThrow()` assertions, since that matcher passes on any thrown error — I
temporarily instrumented a **copy-verified** version of the covering test file: each of the
three `REFUSES` tests got a `try/catch` before its existing assertion that logs
`error.cause.code` / `error.cause.constraint_name` (the underlying `postgres.js`
`PostgresError`, which drizzle wraps; the outer error is just "Failed query"). Ran only the
covering file:

```
NODE_ENV=test bun test src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts
```

Output (excerpted):

```
REVIEW-PROBE owner-mismatch: {"cause_code":"23503","cause_constraint":"user_subscription_tier_owner_fk", ...}
REVIEW-PROBE self-subscribe: {"cause_code":"23514","cause_constraint":"user_subscription_no_self", ...}
REVIEW-PROBE partial-unique: {"cause_code":"23505","cause_constraint":"user_subscription_one_active", ...}
 11 pass
 0 fail
```

All 11 tests still passed with the instrumentation in place. Then reverted the file with
`git checkout --` and diffed it byte-for-byte against a pre-edit backup in the scratchpad
(`IDENTICAL`) to confirm the working tree was restored exactly. Deleted the scratch backup.
Final `git status --porcelain` is empty.

### Result: all three constraints proven to be the ones actually firing

1. **Composite FK `(tier_id, owner_id) → user_tier(id, owner_id)`** — the owner-mismatch
   test (carol subscribes to alice's tier, claims bob owns it; bob is a real, distinct
   `createUser("bob")` row, not a dangling id) rejects with Postgres code `23503`
   (foreign_key_violation) naming constraint `user_subscription_tier_owner_fk` by name.
   This rules out the failure mode the brief warns about: it is *not* the simple
   `owner_id → app_user` FK (that would still be constraint
   `user_subscription_owner_id_app_user_id_fk`, and bob exists so it wouldn't fire at all).
2. **`CHECK (subscriber_id <> owner_id)`** — the self-subscription test rejects with code
   `23514` (check_violation) naming constraint `user_subscription_no_self` by name.
3. **Partial unique index `(subscriber_id, owner_id) WHERE status = 'active'`** — activating
   a second subscription for the same pair while the first is still active rejects with
   code `23505` (unique_violation) naming constraint `user_subscription_one_active` by name.

No ambiguity in any of the three: the Postgres error identifies the exact named object,
not merely "some error."

### The second half of the partial-index test

Confirmed present and load-bearing, not decorative. After the probed rejection above, the
same test (unmodified past that point):

```ts
await subs.cancel(first.id);
const activatedSecond = await subs.activate(second.id, new Date("2026-09-18T00:00:00.000Z"));
expect(activatedSecond?.status).toBe("active");
```

This ran and passed in the same green run (11/11), i.e. cancelling flips `status` off
`'active'` and the previously-blocked activation of `second` now succeeds. This is real
evidence the index is partial, not a plain unique index on `(subscriber_id, owner_id)` —
which would have permanently forbidden a resubscribe after cancellation, the exact bug the
brief calls out as "the failure mode that would surface as 'I cannot give this person money
again' months later."

## Migration SQL, read by eye

`apps/api/drizzle/0025_numerous_thunderbird.sql`:

- Composite FK names both columns in the correct order and direction:
  `FOREIGN KEY ("tier_id","owner_id") REFERENCES "public"."user_tier"("id","owner_id")`.
- `CONSTRAINT "user_subscription_no_self" CHECK ("user_subscription"."subscriber_id" <> "user_subscription"."owner_id")`
  present.
- `CREATE UNIQUE INDEX "user_subscription_one_active" ... WHERE "user_subscription"."status" = 'active'`
  — carries the `WHERE`, confirmed partial (also independently confirmed live above, since
  a non-partial index would have failed the resubscribe half).

Also present and correct: the simple FKs `subscriber_id → app_user(id)` and
`owner_id → app_user(id)`, the `user_transaction → user_subscription` FK, and the plain
`user_subscription_owner_idx` btree on `owner_id`.

## Diff scope / dashboard isolation

`git diff --stat` equivalent from the review package touches exactly 8 files: the 5 named
in the brief plus the two Drizzle-generated meta files (`0025_snapshot.json`,
`_journal.json`) and the migration SQL itself — nothing else. Grepped the diff for
`community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator` outside
the `user_`-prefixed names: no hits on added lines referencing or altering those tables.
The only lines removed in the diff are file-header noise (`--- /dev/null`,
`--- a/apps/api/drizzle/meta/_journal.json`) from files that are pure additions/appends —
no pre-existing table definition or query changed. `/dashboard/*`'s `transaction` table is
untouched; this task's `user_transaction` is a distinct, unrelated table as the brief
requires.

## Other checks

- **`follow_no_self` shape match**: `check("follow_no_self", sql`${table.followerId} <> ${table.followeeId}`)` (schema.ts:861) vs.
  `check("user_subscription_no_self", sql`${table.subscriberId} <> ${table.ownerId}`)` (schema.ts:999) — same shape, same pattern, comment explicitly says "exactly as `follow_no_self` forbids following yourself."
- **`amount` documentation**: both the schema.ts column comment and the port's
  `UserTransactionRow` docstring state amount is "what WE believe is owed," and that
  Task 7's webhook compares the provider's claim against it, never the reverse. Consistent
  in both places, matches the brief's own wording.
- **Tests assert literal values, not constants**: confirmed across all 11 tests —
  `expect(created.status).toBe("pending")`, `expect(paid?.status).toBe("paid")`,
  `expect(activated?.status).toBe("active")`, `50_000` used as a literal amount, etc. No
  test imports a constant from the implementation and asserts equality against itself.
- **`resetDatabase` ordering**: `userTransactions` deleted before `userSubscriptions`
  before `userTiers`, matching the brief's required order and each table's actual FK
  dependency (verified by reading `test-helpers.ts`).

## `cancel(id)` — the one addition beyond the brief

The brief's stated minimum port surface is `create`, `findById`, `activate`,
`findActiveFor`, `createTransaction`, `findTransactionById`, `markTransactionPaid` — no
`cancel`. The implementer added `cancel(id)`, reasoning that the partial-index test's
required second half (resubscribe after cancellation) needs some way to flip `status` off
`'active'`, and no other route existed through the port.

Judgment: the reasoning holds. Without `cancel`, the test mandated by Step 4 of the brief
("...then cancel the first and assert a new one is accepted") is not writable at all
through the port — the only alternative would be a raw SQL `UPDATE` in the test file,
which would be worse (bypasses the abstraction the port exists to provide, and this
project's own conventions elsewhere use repository methods, not raw SQL, from tests). The
method is minimal: one `UPDATE ... SET status = 'cancelled' WHERE id = $1 RETURNING *`,
symmetric with `activate`, no extra parameters, no unused fields. It is also independently
plausible as a real route Task 7 (webhook) or a future "cancel my subscription" endpoint
will need, not speculative scope creep purely for test convenience.

## Findings

None. No Critical, Important, or Minor findings.

## Tree state

`git status --porcelain` is empty. No files were left modified, added, or deleted. The
scratch instrumentation used to identify each constraint by name was reverted via
`git checkout --` and verified byte-identical to the pre-edit file before being discarded.
