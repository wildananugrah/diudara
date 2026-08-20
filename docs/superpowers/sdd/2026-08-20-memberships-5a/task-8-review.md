# Task 8 review — `IsMemberOf`

**Diff reviewed:** `cdeeb94..8734d5b` (2 new files, 260 insertions: `is-member-of.ts`, `is-member-of.test.ts`).
**Method:** read spec §8/§9, brief, report, diff; read `findActiveFor` and both its other
call sites (`start-user-subscription.ts`, `handle-payment-webhook.ts`); ran only
`is-member-of.test.ts` (not the full api suite); independently reproduced the mutation
the report claims; restored the tree and confirmed `git status` clean.

## Verdict 1: Spec compliance — ✅

- §8: "one question, answerable with a single index hit" — satisfied. `IsMemberOf.execute`
  makes exactly one call to `findActiveFor` (one indexed round-trip, `LIMIT 1` against
  `user_subscription_one_active`) and does the period comparison on the already-fetched
  row in application code — no second query, no in-memory filtering of a row set.
- §8's exact predicate, `status = 'active' and current_period_end > now()` — implemented
  faithfully: `findActiveFor` supplies the status filter (in SQL), `IsMemberOf` supplies
  the period filter (`active.currentPeriodEnd.getTime() > this.clock.now().getTime()`),
  strict `>` matching the spec's wording.
- §9's honest limitation is respected, not silently patched over: the docstring and the
  named test both point at exactly the gap 5a leaves (no renewal pass ⇒ a
  `status='active'` row can sit past its paid period) and the code closes it at the
  point Phase 6 will read it from, without touching the shared repository method that
  the honest limitation says is out of scope for 5a.

## Verdict 2: Task quality — approved, with one Important finding (disclosed) and one Minor observation

### Important — the EXPLAIN test proves a query nobody necessarily runs (disclosed by implementer, judged here)

**Do the two queries currently match?** Yes, exactly. `findActiveFor`
(`apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts:136-152`):

```ts
.select().from(userSubscriptions)
.where(and(eq(subscriberId), eq(ownerId), eq(status, "active")))
.limit(1)
```

Test's hand-copied SQL:

```sql
select * from user_subscription
where subscriber_id = $1 and owner_id = $2 and status = 'active'
limit 1
```

Same table, same three predicates in the same order, same `LIMIT 1`. `select *` is the
correct mirror of Drizzle's no-column-list `.select()`. They match today.

**Drift risk if `findActiveFor` changes later:** real. The EXPLAIN test is not wired to
the repository's actual query object at all — it is a literal SQL string typed by hand
in the test file, run directly via `pgClient.unsafe`. If someone later edits
`findActiveFor` (adds a predicate, reorders columns in a way that stops the planner
using `user_subscription_one_active`, changes it to a join through the tier, etc.),
**nothing in this test file would fail.** It would keep asserting `Index Scan using
user_subscription_one_active` against its own frozen copy of the old query, forever
correct about a query that may no longer be the one shipping. The behavioral tests in
`drizzle-user-subscription.repository.test.ts` (`returns the active subscription…`,
`returns null…`) would still catch a *correctness* regression, but nothing catches a
*performance* regression — a `findActiveFor` that still returns the right row via a
sequential scan would sail through every test in this repo.

This is exactly the vacuity pattern this phase keeps finding, and the implementer's own
"What I'm unsure about" section names it accurately rather than hiding it. I'm not
raising it to Critical because (a) it is honestly disclosed with the exact mechanism and
its blast radius spelled out, (b) it is scoped correctly — the brief authorized creating
`is-member-of.{ts,test.ts}` only, not changing `findActiveFor`'s signature to expose a
synchronous builder, and (c) the query today is three trivial equality predicates, low
odds of drifting silently. But it is a real gap a future PR could walk through
undetected, so it belongs on the record as **Important**, not waved off as acceptable
and forgotten. A cheap partial fix for a later task: have the EXPLAIN test import and
call `findActiveFor`'s SQL fragment (extract the `where` clause into an exported
`sql`-returning helper the repository method also uses) rather than retyping it — out of
scope here, worth flagging for whoever next touches this file.

### Minor — no test at the exact `current_period_end === now()` boundary

The spec's predicate is strict `>`, and the code implements it as strict `>`. The tests
cover clearly-future and clearly-past period ends (`NOW` is placed "deliberately in the
middle of a subscription's real period, never on a boundary," per the test file's own
comment) but nothing pins the boundary itself (would a row with `current_period_end ===
now()` be excluded, as the spec implies with `>` rather than `>=`?). Not required by the
brief's explicit list and not a correctness risk in the implementation as written — but
a one-line addition would remove the last sliver of doubt about that inequality's
direction. Not blocking.

### Confirmed correct, no findings

- **Mutation kill, independently reproduced.** Replaced the body with `return active !==
  null;` (status-only, the exact §9 bug) and reran `is-member-of.test.ts`: exactly
  `IsMemberOf > is false for an active subscription whose current_period_end has passed`
  reddened — 6 pass / 1 fail, the same result the report claims. Restored with `git
  checkout --`; reran clean (7 pass / 0 fail).
- **`pending`, `cancelled`, unrelated pair, self-pair** — all four covered, all exercise
  real behavior rather than a tautology: `pending` relies on `create()`'s schema default
  (`status` defaults to `'pending'`, confirmed in `db/schema.ts:996`) never touching
  `activate()`; `cancelled` calls the real `cancel()` after activating with a *future*
  period end, so it is specifically proving status is checked independently of period;
  unrelated pair seeds a real active subscription to a different owner; self-pair is the
  one case that never reaches the DB (short-circuited in `execute`), which is correct
  since the DB's own `user_subscription_no_self` check constraint makes such a row
  impossible to seed anyway.
- **The red phase** (from the report, not rerun here): all 6 logic tests failed on the
  `execute(...)` call line against a `not implemented` stub — for their own reason, not
  an import/setup failure. The 7th test (EXPLAIN) passed even against the stub, correctly
  by design, since it never calls `IsMemberOf.execute`.
- **Literal assertions.** Every test asserts a plain `true`/`false` boolean, never a
  named constant being checked against itself. `NOW`, `PAST_PERIOD_END`,
  `FUTURE_PERIOD_END` are literal `Date` values, not derived from anything the
  implementation also reads.
- **Untouchable tables.** Diff touches only two new files under
  `application/use-cases/`. No edits to `db/schema.ts`, no dashboard route, no
  `community`/`membership_tier`/`member`/`subscription`/`transaction`/`creator` table.
  The test file imports only `appUsers` (5a's own `app_user`) plus 5a's own
  `user_subscription`/`user_tier` repositories.

## The ruling under review: period comparison belongs in application code, not `findActiveFor`'s SQL

**Holds.** Read both other call sites in full:

- `start-user-subscription.ts:~180` (`resolveExistingCheckout`'s caller): calls
  `findActiveFor` to refuse a second purchase — "you already hold an active membership."
  Semantically this wants "does a `status='active'` row exist for this pair," full stop.
  If the query were narrowed to also require `current_period_end > now()`, a subscriber
  whose period had lapsed (still `status='active'`, per §9's honest limitation — nothing
  demotes it) would sail past this check and successfully claim a new pending
  subscription. When that pending row later tries to activate, it collides with the
  still-`status='active'`-but-expired row on `user_subscription_one_active` — the exact
  partial unique index — a real correctness break, not hypothetical.
- `handle-payment-webhook.ts:358-362`: calls `findActiveFor` to detect "another active
  subscription already exists for this pair" before activating the one the webhook is
  processing (redelivery idempotency / duplicate-activation guard, excluding the row
  being activated by id). Same reasoning: this wants "is there a live `active` row,"
  not "is there a currently-in-period one." Narrowing the query the same way would let a
  second activation through against a pair that already has a lapsed-but-still-`active`
  row, again heading straight for the unique index violation the check exists to avoid
  surfacing as a raw 500.

So the two other callers and `IsMemberOf` genuinely want different predicates over the
same underlying "active" concept, and the implementer's choice — one shared, unmodified
query plus a call-site-specific filter — is the correct one, not just a scope-avoidance
convenience. It also holds the "single indexed round-trip" property: `findActiveFor`
does the DB work (`LIMIT 1`, index-backed), and `IsMemberOf` performs a plain in-memory
`Date` comparison on the one row already returned — no second query, no fetch-then-filter
over a row set.

## Tree state

`git status` clean after the mutation-and-restore cycle; only the untracked
`.superpowers/` report/review files exist, nothing staged or modified in tracked files.
