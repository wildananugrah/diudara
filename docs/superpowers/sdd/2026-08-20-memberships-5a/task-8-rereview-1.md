# Task 8 fix round 1 — re-review

**Diff reviewed:** `8734d5b..b574236` (commit `b574236`, "fix(api): make the isMemberOf
EXPLAIN test introspect the real query (Task 8 fix round 1)").
**Method:** read the fix diff, the original review, and the report's appended fix-round
section; read the current state of both touched files in full; independently
reproduced both mutation claims from a clean tree, reverting after each; ran only the
covering test files (never the full api suite); ran `tsc --noEmit`; confirmed `git
status` clean throughout.

## I1 (Important) — EXPLAIN test wiring — ADDRESSED

**Verified directly, not just read.** `DrizzleUserSubscriptionRepository` now exposes
`activeMembershipQuery(subscriberId, ownerId)` (repository file, ~line 151), returned
un-awaited; `findActiveFor` does `const [row] = await
this.activeMembershipQuery(subscriberId, ownerId)`. The EXPLAIN test in
`is-member-of.test.ts` calls `subs.activeMembershipQuery(subscriber!.id,
owner!.id).toSQL()` — `subs` is the same `DrizzleUserSubscriptionRepository` instance
`buildUseCase()` hands to `IsMemberOf` — and `explain`s the resulting `sql`/`params`
pair. This is the real query object, not a second copy.

**Guarantee check — mutate the real query, confirm a named test reddens:**

Edited `activeMembershipQuery` in the repository (not the test) to replace
`eq(userSubscriptions.status, "active")` with a logically-equivalent but syntactically
different predicate:

```ts
sql`${userSubscriptions.status} <> 'pending' and ${userSubscriptions.status} <> 'cancelled'`
```

(added `sql` to the `drizzle-orm` import). This still returns the correct row — only
three statuses exist — but Postgres's partial-index predicate matcher is syntactic, so
it can no longer prove the WHERE clause implies `user_subscription_one_active`'s own
`WHERE status = 'active'`.

Ran `bun test src/application/use-cases/is-member-of.test.ts`:

```
 7 pass
 1 fail
(fail) the query isMemberOf issues > plans a select on (subscriber_id, owner_id, active) WITHOUT a sequential scan
Expected to contain: "user_subscription_one_active"
Received: "...Bitmap Heap Scan on user_subscription...Bitmap Index Scan on user_subscription_owner_idx..."
```

Exactly the named EXPLAIN test reddened — nothing else. `git checkout --` on the
repository file; reran the same file: **8 pass / 0 fail**, tree clean. This matches the
report's own reproduction of this mutation exactly (same test name, same fallback
index, same plan shape).

**Conclusion:** the wiring is real, not cosmetic. Editing `findActiveFor`'s predicates
today provably flows into the EXPLAIN test's assertion. I1 is ADDRESSED.

### `findActiveFor` behaviour for its other two callers — UNCHANGED

Read the current repository file in full. `findActiveFor`'s signature
(`(subscriberId, ownerId) => Promise<UserSubscriptionRow | null>`), its UUID
shape-check guard, its predicates (`subscriberId`, `ownerId`, `status = 'active'`
only — no period filter), and its `LIMIT 1` are byte-for-byte the same as before the
refactor; the only change is that the query construction moved into a new,
not-port-exposed method `activeMembershipQuery` that `findActiveFor` now awaits inline.
`grep` confirms `activeMembershipQuery` is called nowhere except from inside
`findActiveFor` itself and from the EXPLAIN test — `start-user-subscription.ts:167`
and `handle-payment-webhook.ts:358` both still call `findActiveFor` (unchanged name,
unchanged semantics: "does an active row exist," not "is it still within its paid
period"). No narrowing occurred; the risk the finding's own body warned about (a
lapsed-but-`active` row slipping past both guards and colliding with
`user_subscription_one_active` at activation) was not introduced.

## Minor — boundary test — ADDRESSED

`is-member-of.test.ts` gained `IsMemberOf > is false when current_period_end equals
now exactly (strict >, not >=)`: seeds an active subscription with
`current_period_end` at the exact same instant as the injected `FixedClock`, asserts
`false`.

**Mutation check, reproduced independently:** changed `is-member-of.ts`'s `return
active.currentPeriodEnd.getTime() > this.clock.now().getTime();` to `>=`. Ran the
covering file:

```
 7 pass
 1 fail
(fail) IsMemberOf > is false when current_period_end equals now exactly (strict >, not >=)
Expected: false
Received: true
```

Exactly the named test reddened, nothing else. `git checkout --`; reran: **8 pass / 0
fail**, tree clean.

## New breakage check

- `git diff --stat cdeeb94..b574236` (full Task 8 scope, base through fix round):
  3 files touched — `is-member-of.ts`, `is-member-of.test.ts`,
  `drizzle-user-subscription.repository.ts`. No other files in the fix diff itself
  (`8734d5b..b574236`) beyond the two the diff package lists.
- `/dashboard/*` and any dashboard tables: untouched — `git diff cdeeb94..b574236 --
  '**/dashboard*'` returns nothing; no `db/schema.ts` edits.
- Ran the report's own covering set (not the full suite):
  `is-member-of.test.ts` + `drizzle-user-subscription.repository.test.ts` +
  `users.test.ts` + `renewal-payment.test.ts` +
  `drizzle-payment-activation.unit-of-work.test.ts` → **190 pass / 0 fail** across 5
  files, matching the report's claimed counts (31 + 156 + 3 = 190) exactly. The
  "unhandled error" / "[payments] ALERT" / "[churn] NOT revoking" lines in the output
  are deliberate simulated-failure/log-assertion fixtures in those tests, not
  failures — 0 fail confirms it.
- `bunx tsc --noEmit`: clean.
- Tests assert literal values throughout: `IsMemberOf` tests assert plain
  `true`/`false`; the EXPLAIN test asserts against literal strings
  (`"Seq Scan on user_subscription"`, `"user_subscription_one_active"`), never a
  constant the implementation also defines. `activeMembershipQuery`'s own predicates
  are the thing under test, not echoed back as the assertion.

## Tree state

`git status` clean after every mutation-and-revert cycle and at the end of this
re-review. No files left modified; nothing staged.

## Overall verdict

Both findings from the original review — I1 (Important) and the Minor boundary gap —
are **ADDRESSED**, verified by independently reproducing the exact mutations the report
claims kill, not merely by reading the diff. `findActiveFor`'s behaviour for
`start-user-subscription.ts` and `handle-payment-webhook.ts` is unchanged. No new
breakage found; `/dashboard/*` untouched; tree left clean.
