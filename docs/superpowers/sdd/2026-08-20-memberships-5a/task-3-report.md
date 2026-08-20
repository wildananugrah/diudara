# Task 3 — Payout onboarding on `app_user` — implementer report

**Branch:** `feat/memberships` (worktree `.worktrees/memberships`)
**Commits:**

- `7436665` — `feat(api): payout onboarding on app_user (Task 3, Phase 5a)`
- `619fa4d` — `test(api): kill two mutants the payout suite let through`

Status: **DONE.** Full api suite green (2222 pass / 0 fail), `tsc --noEmit` clean,
`git status` clean.

---

## What I built

### The column (Step 1)

`app_user.xendit_account_id varchar(255)` nullable, migration
`drizzle/0026_brief_richard_fisk.sql` — one statement, no drift:

```sql
ALTER TABLE "app_user" ADD COLUMN "xendit_account_id" varchar(255);
```

The schema comment says the column has **three** states, points at
`domain/payment-account.ts` for all three, and says explicitly never to
truthiness-check it. `creator.xendit_account_id` and
`create-payment-account.ts` are untouched — this is a parallel flow for a
different owner, not a generalisation of theirs. Nothing under `/dashboard/*`
or any table it reads was modified.

### The sentinel is reused, not re-invented

`XENDIT_ACCOUNT_PROVISIONING`, `isProvisioningPlaceholder` and
`isConnectedPaymentAccount` are imported from `domain/payment-account.ts`. That
module was **not edited** — it served both owners as written.

### Files

| File | Status |
|---|---|
| `apps/api/src/db/schema.ts` | modified — the column |
| `apps/api/drizzle/0026_brief_richard_fisk.sql` (+ snapshot, journal) | new |
| `apps/api/src/application/ports/user-payout-repository.port.ts` | **new (not in the brief — see Deviations)** |
| `apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.ts` | **new (not in the brief)** |
| `apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.test.ts` | **new (not in the brief)** — 14 tests |
| `apps/api/src/application/use-cases/connect-user-payout.ts` | new |
| `apps/api/src/application/use-cases/get-user-payout-status.ts` | **new (not in the brief)** |
| `apps/api/src/application/use-cases/connect-user-payout.test.ts` | new — 16 tests |
| `apps/api/src/routes/users.ts` | modified — `GET|POST /users/me/payout` |
| `apps/api/src/routes/users.test.ts` | modified — 9 tests |
| `apps/api/src/bootstrap.ts` | modified — 3 new `Dependencies` fields + wiring |
| `apps/api/src/bootstrap.test.ts` | modified — its two full `Dependencies` literals needed the 3 new fields |

### The order, which is the whole design

`ConnectUserPayout.execute`:

1. `findPayoutAccount` — a **courtesy**, not the guard (answers the ordinary
   already-connected case without an HTTP round trip).
2. `beginXenditAccountProvisioning` — **THE GUARD.** One conditional UPDATE
   (`where id = ? and xendit_account_id is null`), returning the affected row
   count. This happens **before** the provider call.
3. the provider call, reached only by the caller holding the sentinel.
4. `finishXenditAccountProvisioning` — replaces the sentinel with the real id,
   predicated on the sentinel still being there.

Provider failure releases the claim (`abandon…`, predicated on the sentinel), or
one timeout would wedge a user forever — there is no operator reset for this
column. A `finish` that fails is unreachable without hand-edited SQL; it logs
the orphaned account **by id only** (no email, no display name) and throws
`ConflictError` rather than reporting success, because an account really was
created and is now unreferenced.

### Every reader goes through the predicate

Audited: the only interpretations of the new column anywhere in the codebase are
`isConnectedPaymentAccount(...)` in `ConnectUserPayout` and `payoutStatusOf(...)`
(which is `isConnectedPaymentAccount` + `isProvisioningPlaceholder`). Both
`ConnectUserPayout` and `GetUserPayoutStatus` funnel through `payoutStatusOf`, so
neither can drift into a truthiness check. The repository never interprets the
value at all — it only compares against the shared constant in its WHERE clauses.
There is no truthiness check on this column anywhere.

### The routes

`GET /users/me/payout` and `POST /users/me/payout`, both behind `requireUserAuth`
(per-route, matching the rest of the router). Both answer with the same three
booleans and **never the account id itself** — a client has no use for it, and a
value on the wire is a value that gets pasted somewhere.

- `GET` → `{ connected, provisioning, available }`, read-only and safe on every
  page load.
- `POST` → same shape, **200 not 201**, idempotent: the response is the resulting
  state whether or not this call changed it (the same contract the follow routes
  on this router already use). A user on a slow connection will press it twice;
  the outcome that must be impossible is a second sub-account.
- `available` is `deps.connectUserPayout !== undefined`, the exact expression the
  POST turns into its 503, so the two can never disagree. Without it,
  `connected: false, provisioning: false` means both "you have not connected yet"
  and "this server has no payment provider at all" — the ambiguity the creator
  dashboard shipped once, and only the first is fixable by pressing a button.

---

## Red phase

Stubs first (throwing `not implemented`), then re-run, so every test failed on
its own assertion rather than on a module that would not load.

**Use-case tests — 0 pass / 14 fail** (before the two mutation-driven tests were
added later):

```
(fail) ConnectUserPayout > connects a payout account and fills the column with the id the provider returned
(fail) ConnectUserPayout > sends the USER's own email and display name to the provider
(fail) ConnectUserPayout > throws NotFoundError when the user does not exist, and calls nobody
(fail) ConnectUserPayout > is idempotent: connecting again returns connected without a second provider call
(fail) ConnectUserPayout > claims the row with the sentinel BEFORE the provider is called
(fail) ConnectUserPayout > 30 concurrent connects produce exactly ONE provider call
(fail) ConnectUserPayout > does not call the provider AT ALL when it loses the claim
(fail) ConnectUserPayout > reports the winner's connection to a loser that arrives after it finished
(fail) ConnectUserPayout > releases the claim when the provider call fails, so the user can retry
(fail) ConnectUserPayout > names the orphaned provider account instead of reporting success, ids only
(fail) GetUserPayoutStatus > reports neither connected nor provisioning for a fresh user
(fail) GetUserPayoutStatus > reports a REAL id as connected
(fail) GetUserPayoutStatus > reports the sentinel as NOT connected, even though the column is truthy
(fail) GetUserPayoutStatus > throws NotFoundError for a user that does not exist
 0 pass / 14 fail
```

Each one reached the stub from its own test line, e.g.

```
error: not implemented
      at execute (…/get-user-payout-status.ts:16:15)
      at <anonymous> (…/connect-user-payout.test.ts:306:54)
```

and the one that had already got past the call failed on its assertion:

```
expect(received).toBeInstanceOf(expected)
Expected constructor: [class NotFoundError extends AppError]
Received value: error: not implemented
```

**Repository tests — 0 pass / 14 fail**, all against the throwing stub, one line
per test (`DrizzleUserPayoutRepository.findPayoutAccount > …` etc.).

**Route tests — 0 pass / 9 fail**, on their own assertions (404 where 401/200/503
was expected), the app having booted fine:

```
(fail) GET /users/me/payout and POST /users/me/payout > rejects an unauthenticated read with 401
(fail) … rejects an unauthenticated connect with 401
(fail) … reports neither connected nor provisioning for a user who has never connected
(fail) … connects on POST, and the GET agrees afterwards
(fail) … never puts the provider account id in the response body
(fail) … is idempotent across a second POST — one provider account, not two
(fail) … reports provisioning while a claim is held, without calling the provider
(fail) … keeps one user's payout status independent of another's
(fail) … says available: false and 503s the POST on a box with no payment provider
 0 pass / 9 fail
```

---

## The concurrency test — exact shape and result

`Promise.all` over 30 invocations against one shared fake repository and one
shared fake provider. No loop, no `for (…) await …`. **An `ArrivalLatch(30)` is
wired into the fake's `findPayoutAccount`,** so every caller blocks at the read
until all 30 have arrived — which means all 30 demonstrably see an unclaimed
column, the exact interleaving that minted the orphans. The latch *rejects* on
its timeout rather than resolving, so it cannot pass vacuously.

```ts
it("30 concurrent connects produce exactly ONE provider call", async () => {
  const latch = new ArrivalLatch(30);
  const { repository, rows } = fakeRepository([user()], {
    onRead: () => latch.arriveAndWait(),
  });
  const payments = new FakePaymentAdapter();

  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      new ConnectUserPayout(repository, payments).execute("user-1")
    )
  );

  expect(payments.accounts).toHaveLength(1);
  expect(rows[0].xenditAccountId).toBe(payments.accounts[0].accountId);
  expect(latch.arrived).toBeGreaterThanOrEqual(30);
  for (const status of results) {
    expect(status.connected || status.provisioning).toBe(true);
  }
});
```

The fake's `begin` does its check and its set in the **same synchronous turn**,
exactly as one SQL statement does — a fake that awaited between them would model
a database that cannot arbitrate anything.

**Result: passes (1 provider call).**

**Positive control (deliberately reverted afterwards).** I reordered the
implementation into the pre-sentinel shape — provider first, claim second — and
re-ran only this test:

```
207 |     expect(payments.accounts).toHaveLength(1);
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 30
(fail) ConnectUserPayout > 30 concurrent connects produce exactly ONE provider call
```

**30 provider calls, 29 of which would be permanent Xendit orphans.** The
implementation was restored from a backup copy and the suite re-run green; the
committed code has the claim at the top of `execute`, before the provider call.

**The database-level arbitration is pinned separately**, because the test above
proves the use-case's *ordering* against an in-memory fake and nothing about
Postgres. `drizzle-user-payout.repository.test.ts` has
`"lets exactly ONE of several concurrent claims win"` — four real concurrent
`beginXenditAccountProvisioning` calls against the real table, held at an
`ArrivalLatch(4)`, asserting `results.filter(Boolean)` has length 1 and that the
column holds the sentinel afterwards.

---

## The reserved-handle guard — before and after

**I did not add `payout` to `RESERVED_HANDLES`**, per your ruling. Your reading is
correct and I verified it in the code: the guard is

```ts
const segment = route.path.slice("/users/".length).split("/")[0];
```

so `/users/me/payout` contributes `me`, not `payout`. `me` is 2 characters and
fails `^[a-z0-9_]{3,30}$`, so `isValidHandle(segment)` is false and it is never
even added to the `shadowable` set. Nothing under `/users/me/` can shadow a
profile, and `handle.ts` already documents `me`/`by-handle`/`password-reset` as
deliberately absent for exactly this reason.

- **Before mounting** (baseline, at HEAD): `1 pass, 97 filtered out, 0 fail, 2 expect() calls`.
- **After mounting** both routes: `1 pass, 106 filtered out, 0 fail, 2 expect() calls`.

Both `expect()` calls are the meaningful ones — the guard's own positive control
(`shadowable.size >= 5`, which stops it passing vacuously) and
`expect(unprotected).toEqual([])`. Identical before and after; the only change is
the filtered-out count, which is my 9 new tests in the same file.

The brief's Step 4 also asked for a positive control that removes the handle from
the list while the route is mounted and watches the guard fail. That control is
**not applicable** here: `payout` was never added, so there is nothing to remove.
The guard's own built-in `shadowable.size >= 5` assertion is what keeps it from
passing vacuously, and it is green.

---

## Test counts

| | tests | files |
|---|---|---|
| before (`4d58473`, derived) | 2183 | 147 |
| after (`619fa4d`, measured) | **2222** | 149 |

Added: 16 (`connect-user-payout.test.ts`) + 14
(`drizzle-user-payout.repository.test.ts`) + 9 (`routes/users.test.ts`) = **39**.
`bootstrap.test.ts` gained wiring, not tests. Full run: `2222 pass, 0 fail, 5951
expect() calls, 149 files, 253.88s`. **No existing test was changed, skipped or
deleted.**

The "before" number is derived by subtraction (2222 − 39), not measured — see
Uncertainties.

---

## Mutation testing (after the first commit)

| # | Mutation | Result |
|---|---|---|
| M1 | `isConnectedPaymentAccount(...)` → bare truthiness in `ConnectUserPayout`'s early return | **SURVIVED** → fixed, see below |
| M2 | `isConnectedPaymentAccount` → `Boolean(...)` in `payoutStatusOf` | killed (3 tests) |
| M3 | drop `abandonXenditAccountProvisioning` on provider failure | killed (1 test) |
| M4 | `begin` drops its `is null` predicate | killed (3 tests, incl. the 4-way DB race) |
| M5 | `abandon` drops its sentinel predicate | killed (1 test) |
| M6 | `finish` drops its sentinel predicate | killed (2 tests) |

**M1 survived and it is worth understanding why**: with truthiness in the early
return, a sentinel-holding row returns early instead of falling through to the
claim — but `payoutStatusOf` still interpreted the value correctly, so the answer
was identical. It is *nearly* an equivalent mutant. The real difference is
freshness: the correct code falls through, loses the claim, and **re-reads**, so a
caller whose rival finished in the meantime is told `connected`; the mutant reports
`provisioning` from its stale copy.

Two tests now pin that, both written as behaviour rather than as anti-mutation
scaffolding (commit `619fa4d`):

- `"reports provisioning, not connected, when the column ALREADY holds the
  sentinel"` — asserts `Boolean(rows[0].xenditAccountId) === true` first, so the
  test itself records that a truthiness check would answer wrongly here.
- `"answers from a FRESH read, not the stale copy it started with"` — kills M1.

Re-ran M1 against the strengthened suite: `15 pass, 1 fail`, failing on the new
fresh-read test. Reverted.

---

## Deviations from the brief (all deliberate; please sanity-check)

1. **`payout` NOT added to `RESERVED_HANDLES`** — your ruling, verified against the
   guard's actual code. Documented in a comment at the routes and in the test
   block so the next reader does not "fix" it.

2. **Four files the brief did not list.** The brief's file list needs a repository
   and a status reader to work at all; here is why each is its own file rather
   than growing an existing one:

   - `user-payout-repository.port.ts` + `drizzle-user-payout.repository.ts`
     instead of four methods on `UserRepositoryPort`. `UserRecord` is projected
     straight into HTTP responses (`toOwnProfile`, `PATCH /users/me`), so widening
     it would put a provider account id on the wire wherever a profile is
     returned — the same reasoning that makes `UserCredentials` the only shape
     carrying the password hash. It also matches Phase 5a's own pattern (Task 1
     and Task 2 each added a port + a Drizzle repository), and it avoided
     stub-churn in ~10 unrelated fakes of `UserRepositoryPort`.
   - `get-user-payout-status.ts` (`GetUserPayoutStatus` + `payoutStatusOf`)
     instead of a second method on `ConnectUserPayout`. `ConnectUserPayout` is
     `undefined` on a box with no payment provider, and the **read must still
     work there** or Task 4's publish screen cannot tell "press the button" from
     "this server cannot take payments". The creator flow separates
     `GetPaymentAccountStatus` from `CreatePaymentAccount` for exactly this
     reason. `payoutStatusOf` being shared by both classes is also what
     guarantees a single interpretation of the column.

3. **`available` on both responses** — my addition, mirroring the creator gate's
   CRITICAL 1. Tested by constructing the app with `connectUserPayout: undefined`
   (no env gymnastics needed).

4. **POST is 200 and idempotent, not 201/409.** The brief asks for idempotency
   explicitly, and its own concurrency snippet requires it: a bare `Promise.all`
   with no `.catch` means losing callers must resolve, not reject. So a loser
   returns the state it found (`provisioning`, or `connected` if the winner has
   already finished) having called nobody. This is a deliberate divergence from
   `CreatePaymentAccount`'s 409, and both the use-case docstring and the route
   docstring say so.

5. **`bootstrap.test.ts` touched.** Its two full `Dependencies` literals stopped
   type-checking once the interface grew; they got the three new fields and a
   shallow `fakeUserPayoutRepository`. No test logic changed.

6. **No web work.** Task 3 is API-only; `apps/web` is untouched.

---

## Uncertainties / things worth a reviewer's eye

1. **`creatorId` carries an app_user id.** `PaymentProviderPort.createPaymentAccount`
   takes `{ creatorId, email, name }` and I pass the user's id in `creatorId`. The
   field name is now a small lie. I did **not** rename it, because renaming would
   edit `create-payment-account.ts`, which the constraints put out of bounds. The
   Xendit adapter never sends that field — only `email` and `public_profile.
   business_name` reach the provider — so nothing incorrect leaves the process.
   Commented at the call site. If you want the field renamed to `ownerId`, that is
   a separate change touching the creator flow and I did not make it.

2. **The "before" test count (2183) is arithmetic, not a measurement.** I did not
   stash the work to re-run the suite at `4d58473`; 2222 after and 39 added are
   both measured.

3. **The 30-way concurrency test runs against an in-memory fake**, as the brief's
   own snippet does. It proves the use-case's *ordering*. Postgres's arbitration
   is proven separately by the 4-way `ArrivalLatch` test at the repository level.
   I did not attempt 30 concurrent real HTTP requests — that is the shape the
   original incident was measured with, but it would need a live provider to be
   meaningful and the constraints forbid contacting Xendit.

4. **The `ConflictError` on a stolen claim is Bahasa but vague**: `"koneksi
   pembayaran bentrok — hubungi dukungan DIUDARA."` The state is unreachable
   without hand-edited SQL and the actionable detail is in the `console.warn`, so
   the user-facing string deliberately says nothing about accounts or ids. Happy
   to reword.

5. **`app_user.email` is `NOT NULL`**, unlike `creator.email`, so there is no
   equivalent of `CreatePaymentAccount`'s "an email address is required" 409 here.
   That branch does not exist rather than being forgotten.

6. **`userPayoutRepository` is exposed on `Dependencies`.** Route tests need to put
   the column into its claimed state without going through POST (the real adapter
   would provision an undeletable KYC entity) — the same reason `creatorRepository`
   is exposed, and `payment-account.test.ts` does exactly this. Task 6 will need it
   too.

7. **Route ordering.** `/me/payout` is registered directly after the `/me` routes
   and above `/limits` and every `/:handle/...` route. Nothing collides (`payout`
   is not `followers`/`following`) and all 9 route tests pass, but mount order on
   this router has bitten this project before, so it is worth a glance.

---

# Fix round 1 — review findings F1 and F2

**Commit:** `730a53b` — `fix(api): 30 contenders in the payout race test, and name what creatorId holds`

Scope: F1 and F2 only. F3 (ungated self-service onboarding) and F4 (the plan's
`RESERVED_HANDLES` instruction) were explicitly not mine and are untouched.

## F1 (Important) — the repository race test could not fail against its own bug

**Confirmed, and the reviewer's measurement reproduces exactly on my machine.**

`drizzle-user-payout.repository.test.ts`'s `ArrivalLatch` test now runs **30**
contenders instead of 4, with the number and the reason written into the test's
docstring so nobody lowers it back.

My own mutation evidence, run against the committed code. The mutant replaces the
single conditional UPDATE with the check-then-act shape the sentinel exists to
forbid — `SELECT xendit_account_id`, bail if non-null, then an **unconditional**
`UPDATE … WHERE id = ?`:

```
=== SELECT-then-unconditional-UPDATE, 3 runs at 30 contenders ===
Expected length: 1
Received length: 30
(fail) DrizzleUserPayoutRepository.beginXenditAccountProvisioning > lets exactly ONE of thirty concurrent claims win [273.74ms]
 13 pass / 1 fail
 … identical on runs 2 and 3 (250.85ms, 245.75ms)
```

**30 winners out of 30** — every contender's SELECT sees NULL before any of their
UPDATEs land, so all 30 would have gone on to create a Xendit sub-account. Killed
3/3, decisively, not marginally.

Then, with **the same mutant still applied**, I lowered the latch back to 4 to
reproduce the blind spot the review reported:

```
=== SAME mutant, back at 4 contenders, 5 runs ===
 14 pass  0 fail
 14 pass  0 fail
 14 pass  0 fail
 14 pass  0 fail
 14 pass  0 fail
```

**5 runs, 5 false passes.** The test as I originally wrote it was structurally
correct — right latch, right assertion, real database — and still could not fail
against the defect it names in its own docstring. Sample size was the whole
problem, exactly as diagnosed. That is a lesson worth recording beyond this file:
a concurrency test's *contender count* is part of its evidence, not a detail.

Restored to 30 and un-mutated: **3/3 green**, 2.92–3.35s per run (the race test
itself 42–139ms as the reviewer measured; the file total includes 13 other tests
and `resetDatabase`).

Working tree confirmed clean after restoring the mutant (`git status --short`
empty).

## F2 (Minor) — `creatorId` now carries an `app_user` id

**Taken.** My original judgement that the field was "inert" was half wrong, and the
review is right about which half: `XenditPaymentAdapter` never sends it, but
`FakePaymentAdapter` interpolates it into `fake-acct-${n}-${input.creatorId}`,
and those ids are written into a real `xendit_account_id` column on every
development box and in every test. So it does reach a database — just never Xendit.
Living with that silently was the worst option, because the field's name was its
only documentation and the name is false.

Extracted `CreatePaymentAccountInput` in `application/ports/payment-provider.port.ts`
**alone**, shaped like `CreateInvoiceInput` next door:

```ts
export interface CreatePaymentAccountInput {
  /**
   * THE OWNER'S ID — `creator.id` OR `app_user.id`. The name is historical, from
   * when creators were the only owner that could be paid, and it is now wrong:
   * Phase 5a's `ConnectUserPayout` passes an `app_user.id` through this field for
   * a user selling a membership on their own profile.
   *
   * Not renamed on purpose. …
   *
   * INERT AT THE PROVIDER, but not unused. `XenditPaymentAdapter` never sends it
   * — only `email` and `public_profile.business_name` cross the wire — while
   * `FakePaymentAdapter` interpolates it into the `fake-acct-N-<id>` ids that
   * every development box and every test then stores in a real column. So it
   * does reach the database, just never Xendit.
   *
   * NEVER JOIN THIS TO `creator`. A lookup keyed on it will silently return
   * nothing for half the owners that pass through here, and "no rows" is exactly
   * the shape a missing creator has.
   */
  creatorId: string;
  /** Becomes the provider account's own email. `app_user.email` is NOT NULL; `creator.email` is not. */
  email: string;
  /** Sent as the sub-account's `public_profile.business_name`. */
  name: string;
}
```

The field keeps its name — this is documentation, not a rename. Structural typing
means **`create-payment-account.ts`, `xendit-payment.adapter.ts` and
`fake-payment.adapter.ts` were not edited at all**; nothing frozen was touched. I
also retargeted the comment at `ConnectUserPayout`'s call site to point at the type
rather than re-arguing the case inline.

**A false start worth recording:** my first attempt renamed the property to
`ownerId`. `tsc` rejected it immediately — the adapters declare the parameter shape
inline, so the "rename" would have forced edits into exactly the frozen files the
constraint protects. Reverted to the field name within the same edit; the ruling
against a rename is correct and the type system agrees with it.

## Verification

Covering files only — no full suite, per instruction:

```
$ bun test src/application/use-cases/connect-user-payout.test.ts \
           src/infrastructure/repositories/drizzle-user-payout.repository.test.ts \
           src/routes/users.test.ts \
           src/application/use-cases/create-payment-account.test.ts \
           src/infrastructure/payments/fake-payment.adapter.test.ts \
           src/infrastructure/payments/xendit-payment.adapter.test.ts \
           src/routes/payment-account.test.ts \
           src/bootstrap.test.ts
 340 pass
 0 fail
Ran 340 tests across 8 files. [57.30s]
```

`bun run typecheck` (`tsc --noEmit`) clean. `git status --short` empty; the only
commit added is `730a53b`.

## Concerns after this round

- **None outstanding on F1/F2.** The one thing I would flag for the phase rather
  than for this task: the same 4-contender pattern appears in four other
  `ArrivalLatch` tests in this repository (`drizzle-user.repository.test.ts`,
  `drizzle-follow.repository.test.ts`, `drizzle-join-request.repository.test.ts`,
  `drizzle-renewal-reminder.repository.test.ts`). I did **not** touch them — out of
  scope, and each guards a *unique index*, which arbitrates at any sample size in a
  way a conditional UPDATE does not. But the failure mode I just measured is not
  specific to my file, and somebody should decide whether those numbers are
  evidence or habit.
