# Task 8 — the membership check Phase 6 needs

**Commit:** `8734d5b` (implementation + tests).
**Base:** `cdeeb94`.

## What I built

`apps/api/src/application/use-cases/is-member-of.ts` — `class IsMemberOf` with
`execute(viewerId, ownerId): Promise<boolean>`, following this codebase's use-case
convention (a class with `execute`, dependencies injected in the constructor — every
other use-case in `application/use-cases/` is shaped this way; `payoutStatusOf` is the
one exception and it is a pure domain function, not a DB-touching use-case).

```ts
async execute(viewerId: string, ownerId: string): Promise<boolean> {
  if (viewerId === ownerId) {
    return false;
  }
  const active = await this.subscriptions.findActiveFor(viewerId, ownerId);
  if (!active || active.currentPeriodEnd === null) {
    return false;
  }
  return active.currentPeriodEnd.getTime() > this.clock.now().getTime();
}
```

Two dependencies, both existing ports — no new port method, no schema change, no
repository edit:

- `UserSubscriptionRepositoryPort.findActiveFor` — Task 2/7's existing method, already
  querying `subscriber_id = ? AND owner_id = ? AND status = 'active'` against
  `user_subscription_one_active`, the partial unique index. This is the one indexed
  query the spec asks for.
- `ClockPort` — time is injected, never `Date.now()` read inline, matching every other
  time-sensitive use-case in this codebase (`process-renewals.ts`, `process-churn.ts`,
  `handle-payment-webhook.ts`, `start-checkout.ts`, …), each of which explains the same
  reason: a use-case that reads the wall clock itself cannot be tested at the boundary
  that decides its answer.

**The trap I found and did not fall into.** `findActiveFor`'s own docstring in the port
already says *"Task 8's membership check: is this subscriber an active member of this
owner"* — but its query only filters `status = 'active'`, not `current_period_end`. Used
as-is by Phase 6, this would grant access forever to an expired-but-never-renewed
subscription, exactly the bug §9 warns about. I deliberately did **not** add the period
check into `findActiveFor` itself: that method is also called by
`start-user-subscription.ts` (refusing a second purchase while a slot is held) and
`handle-payment-webhook.ts` (checking the pair's active slot before activating), and
changing its semantics there is out of this task's scope and untested territory I have
no brief to touch. Instead `IsMemberOf` calls `findActiveFor` — one query, the index hit
— and does the period comparison in application code on the row it gets back. This is
still "one indexed query": the DB round-trip is the same single lookup; the extra
correctness check is a date comparison against an already-fetched row, not a second
query.

## The red phase

Wrote the test file first against a stub `execute` that threw `not implemented`:

```
error: not implemented
      at execute (.../is-member-of.ts:15:15)
      at <anonymous> (.../is-member-of.test.ts:63:41)
(fail) IsMemberOf > is true for an active subscription whose period has not ended [183.00ms]
...
(fail) IsMemberOf > is false for an active subscription whose current_period_end has passed [70.85ms]
(fail) IsMemberOf > is false for a pending subscription [60.23ms]
(fail) IsMemberOf > is false for a cancelled subscription, even with a future period end [72.48ms]
(fail) IsMemberOf > is false for an unrelated pair — an active subscription to someone else [66.74ms]
(fail) IsMemberOf > is false when the viewer and owner are the same person [43.44ms]

 1 pass
 6 fail
 2 expect() calls
Ran 7 tests across 1 file. [4.15s]
```

All six failed on the exact line calling `execute(...)`, i.e. for their own reason (the
stub, not a load/import error). The 7th test — "the query isMemberOf issues" (the EXPLAIN
test) — passed even against the stub because it exercises the repository's raw SQL
directly and never calls `IsMemberOf.execute`; that is by design, it is testing the query
shape `findActiveFor` issues, not `IsMemberOf`'s logic.

Then implemented `IsMemberOf.execute` for real; all 7 went green.

## What happens when the period has passed, and which test proves it

`IsMemberOf > is false for an active subscription whose current_period_end has passed`
(`is-member-of.test.ts:73`): seeds a subscription, activates it with
`current_period_end = 2026-08-01T00:00:00Z`, then calls `execute` with a `FixedClock` at
`2026-08-18T12:00:00Z` (17 days later). Asserts `false`.

**Mutation-tested, in the order requested (commit first, then mutate):** after
committing `8734d5b`, I replaced the body with `return active !== null;` — status-only,
the exact bug §9 warns about — and re-ran the file:

```
75 |     const bob = await createUser("bob");
76 |     await seedActiveSubscription(bob.id, alice.id, PAST_PERIOD_END);
77 |
78 |     const result = await buildUseCase().execute(bob.id, alice.id);
79 |
80 |     expect(result).toBe(false);
                        ^
error: expect(received).toBe(expected)

Expected: false
Received: true

      at <anonymous> (.../is-member-of.test.ts:80:20)
(fail) IsMemberOf > is false for an active subscription whose current_period_end has passed [69.30ms]

 6 pass
 1 fail
 8 expect() calls
Ran 7 tests across 1 file. [4.00s]
```

Exactly the named test reddened, nothing else — the answer to "would my tests still pass
if I deleted the `current_period_end` comparison" is no. Restored with
`git checkout -- src/application/use-cases/is-member-of.ts`; re-ran the file (7 pass, 0
fail) and confirmed `git status` clean afterward.

## Confirming the query hits the index, not a scan

`is-member-of.test.ts`'s `describe("the query isMemberOf issues", …)` seeds ~9,950
`user_subscription` rows (200 users, the first 50 as owners with one tier each, every
user paired with every other owner), `analyze`s the three tables touched, then runs
`explain` on the literal query `findActiveFor` issues (same table, same three `eq()`s,
same `limit(1)` — copied by hand because `findActiveFor` is `async` and executes
immediately, so there is no query-builder object to call `.toSQL()` on from outside it;
noted as a known limitation below). Follows `drizzle-post.repository.test.ts`'s "the
indexes post reads go through" precedent: a realistically-sized, `analyze`d table with
`enable_seqscan` left alone, not forced off.

I additionally ran this once with the plan printed (removed before committing):

```
Limit  (cost=0.27..8.29 rows=1 width=89)
  ->  Index Scan using user_subscription_one_active on user_subscription  (cost=0.27..8.29 rows=1 width=89)
        Index Cond: ((subscriber_id = '...'::uuid) AND (owner_id = '...'::uuid))
```

An `Index Scan using user_subscription_one_active`, no `Seq Scan on user_subscription`.
The test asserts both.

## Test counts

- Before: 2373 pass / 0 fail across 153 files (inferred by subtraction — this task added
  two new, previously-untracked files and touched nothing else; `git status` before my
  change showed no modified files).
- After: **2380 pass / 0 fail across 154 files**, run in the foreground with
  `timeout: 400000` (297–304s across two runs), on the final committed code.

## Self-review

Read the diff with fresh eyes against the question the brief asks: **would the tests
still pass if I deleted the `current_period_end` comparison?** No — proven above by
actually deleting it and watching the one test built for exactly that case go red, then
restoring. `git status` is clean; nothing outside
`apps/api/src/application/use-cases/is-member-of.{ts,test.ts}` changed.

## What I'm unsure about

- **The EXPLAIN test hand-copies `findActiveFor`'s WHERE clause** rather than
  introspecting the repository's own query object, because that method is `async` and
  executes immediately (no synchronous `.toSQL()` handle to grab, unlike
  `DrizzlePostRepository.listGlobal`/`listByAuthor`, which return the un-awaited builder
  chain and are exactly what `drizzle-post.repository.test.ts` calls `.toSQL()` on). If
  `findActiveFor`'s query ever changes shape, this test would not catch the drift on its
  own — only `drizzle-user-subscription.repository.test.ts`'s existing behavioural tests
  for `findActiveFor` would. I judged this acceptable because the query is three trivial
  equality predicates plus `limit(1)`, and Task 8's brief scoped me to creating
  `is-member-of.ts` and its test only — not to changing the repository to expose a
  synchronous builder.
- I left `findActiveFor` untouched rather than adding the period-end filter to its own
  SQL (which would make the single query literally carry both conditions, closer to the
  spec's exact wording in §8). I believe this is the right call given the blast-radius
  constraint and `findActiveFor`'s other two callers, but it is a judgment call, not
  something the brief stated explicitly — flagging it in case Phase 6's implementer or a
  reviewer disagrees.

---

## Fix round 1

**Commit:** `b574236`. **Base:** `8734d5b`.

Review found **spec ✅**, 1 Important, 1 Minor.

### Important — the EXPLAIN test could not fail

The test hand-copied `findActiveFor`'s WHERE clause as a literal SQL string. Reviewer
confirmed the two matched today, but nothing connected them: editing `findActiveFor`
tomorrow could not make the test fail, so it read as assurance it didn't provide.

**Fix.** Extracted the query construction out of `findActiveFor` in
`apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts` into
a new method, `activeMembershipQuery(subscriberId, ownerId)`, returned **un-awaited**.
`findActiveFor` now does `const [row] = await this.activeMembershipQuery(subscriberId,
ownerId)`. `activeMembershipQuery` is not part of `UserSubscriptionRepositoryPort` — an
implementation detail, not a capability the application layer reaches for.

`is-member-of.test.ts`'s EXPLAIN test now calls `subs.activeMembershipQuery(subscriber!.id,
owner!.id).toSQL()` directly — the exact query object the driver receives — and `explain`s
that, instead of a hand-copied string. Same pattern `drizzle-post.repository.test.ts`
already uses for `listGlobal`/`listByAuthor`.

**Proof the wiring now catches a regression.** Commited the fix first (`b574236`), then
temporarily edited `activeMembershipQuery` in the working tree — not committed — to
replace the `status = 'active'` equality with a logically-identical but syntactically
different predicate:

```ts
sql`${userSubscriptions.status} <> 'pending' and ${userSubscriptions.status} <> 'cancelled'`
```

This only has three possible statuses so it means the same thing as `= 'active'`, but
Postgres's partial-index predicate matcher is syntactic, not semantic, so it can no
longer prove the WHERE clause implies `user_subscription_one_active`'s own
`WHERE status = 'active'`. Ran the covering test file:

```
$ bun test src/application/use-cases/is-member-of.test.ts
...
220 |       params as never[]
221 |     );
222 |     const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
223 |
224 |     expect(planText).not.toContain("Seq Scan on user_subscription");
225 |     expect(planText).toContain("user_subscription_one_active");
                           ^
error: expect(received).toContain(expected)

Expected to contain: "user_subscription_one_active"
Received: "Limit  (cost=5.78..160.19 rows=1 width=89)\n  ->  Bitmap Heap Scan on user_subscription  (cost=5.78..160.19 rows=1 width=89)\n        Recheck Cond: (owner_id = '2b60c78b-3f5e-4e05-8295-08e6375b3a90'::uuid)\n        Filter: (((status)::text <> 'pending'::text) AND ((status)::text <> 'cancelled'::text) AND (subscriber_id = '9541a863-644d-4d51-8406-18b4ebdb4396'::uuid))\n        ->  Bitmap Index Scan on user_subscription_owner_idx  (cost=0.00..5.78 rows=199 width=0)\n              Index Cond: (owner_id = '2b60c78b-3f5e-4e05-8295-08e6375b3a90'::uuid)"

      at <anonymous> (.../is-member-of.test.ts:225:22)
(fail) the query isMemberOf issues > plans a select on (subscriber_id, owner_id, active) WITHOUT a sequential scan [1769.21ms]

 7 pass
 1 fail
 9 expect() calls
Ran 8 tests across 1 file. [4.47s]
```

The planner fell back from the partial `user_subscription_one_active` index to the plain
`user_subscription_owner_idx`, doing the status/subscriber checks as a `Filter` instead —
not a full sequential scan (the table's total row count is small enough that a seq scan
was never the planner's true worst case here; the owner index was cheaper), but exactly
the class of regression the review is guarding against: the query no longer touches
`user_subscription_one_active`, and the test caught it. Reverted with
`cp` from a backup of the pre-mutation file; `git diff` against the committed version came
back empty, confirming an exact revert.

(An earlier attempt at this proof — wrapping `subscriberId` in `lower(...::text)` — did
**not** redden the test: Postgres still chose a Bitmap Index Scan on
`user_subscription_one_active` using only the `owner_id` half of the composite key,
because the partial index is tiny (~4% of the table is `active`) and stayed cheaper than
any alternative even with `subscriber_id` demoted to a `Filter`. That is correct planner
behaviour, not a test bug, and it is why the predicate that actually defeats the index
has to break the partial predicate match itself — see the docstring left on
`activeMembershipQuery` in the repository file.)

### Minor — pin the exact boundary

Added `IsMemberOf > is false when current_period_end equals now exactly (strict >, not
>=)` to `is-member-of.test.ts`: seeds an active subscription with `current_period_end`
set to the exact same instant as the injected clock, asserts `false`.

Mutation-checked before committing: changed the implementation's `>` to `>=`, ran the
file — only this new test reddened:

```
92 |     const boundary = new Date(NOW.getTime());
93 |     await seedActiveSubscription(bob.id, alice.id, boundary);
94 |
95 |     const result = await buildUseCase(NOW).execute(bob.id, alice.id);
96 |
97 |     expect(result).toBe(false);
                        ^
error: expect(received).toBe(expected)

Expected: false
Received: true

(fail) IsMemberOf > is false when current_period_end equals now exactly (strict >, not >=) [82.48ms]

 7 pass
 1 fail
 9 expect() calls
Ran 8 tests across 1 file. [4.81s]
```

Reverted with `git checkout -- src/application/use-cases/is-member-of.ts` (the file was
unchanged by this round otherwise, so this restored the exact committed version).

### Verification run (covering files only, per instruction — full suite not run)

```
$ bun test src/application/use-cases/is-member-of.test.ts \
           src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts \
           src/routes/users.test.ts \
           src/application/use-cases/renewal-payment.test.ts \
           src/infrastructure/repositories/drizzle-payment-activation.unit-of-work.test.ts
```

- `is-member-of.test.ts` + `drizzle-user-subscription.repository.test.ts`: 31 pass / 0 fail
- `users.test.ts` + `renewal-payment.test.ts` (other real callers of
  `DrizzleUserSubscriptionRepository`): 156 pass / 0 fail
- `drizzle-payment-activation.unit-of-work.test.ts` (constructs the repository directly):
  3 pass / 0 fail

`bunx tsc --noEmit`: clean throughout.

### Tree state

`git status` after committing and after every revert: **clean**. Final commit is
`b574236` on top of `8734d5b`.
