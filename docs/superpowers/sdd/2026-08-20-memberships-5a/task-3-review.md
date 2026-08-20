# Task 3 review — Payout onboarding on `app_user` (Phase 5a)

**Range reviewed:** `4d58473..619fa4d` (`7436665` + `619fa4d`)
**Method:** mutation, not reading. Every claim below that says "measured" was reproduced
independently in this worktree and reverted. `git status` is clean.

## Verdicts

- **Spec compliance: ✅** — with one deviation from the brief (Step 4's
  `RESERVED_HANDLES` mandate), which the reviewer had already ruled on and which I
  independently confirmed is both correct and safe. Everything else the brief asks for
  is present, and the claim-first discipline is faithfully reproduced.
- **Task quality: findings** — one **Important**, three **Minor**. The shipped
  implementation is correct; the Important finding is a hole in the safety net around
  the one thing that is irreversible in production.

---

## What I verified by mutation

### 1. The claim happens before the provider call — CONFIRMED, and reproduced the incident

I reordered `ConnectUserPayout.execute` into the pre-sentinel shape (provider call first,
conditional UPDATE second) and re-ran only the covering file:

```
Expected length: 1
Received length: 30
(fail) ConnectUserPayout > 30 concurrent connects produce exactly ONE provider call
```

Six tests died, not one:

```
(fail) claims the row with the sentinel BEFORE the provider is called
(fail) 30 concurrent connects produce exactly ONE provider call
(fail) does not call the provider AT ALL when it loses the claim
(fail) reports provisioning, not connected, when the column ALREADY holds the sentinel
(fail) reports the winner's connection to a loser that arrives after it finished
(fail) answers from a FRESH read, not the stale copy it started with
```

`Received length: 30` is the original incident, reproduced. Restored via `git checkout --`;
baseline back to `16 pass / 0 fail`.

### 2. The concurrency test is genuinely concurrent — CONFIRMED

- `Promise.all` over 30 invocations. No loop, no `for (… ) await …`.
- The `ArrivalLatch(30)` is wired into `fakeRepository`'s `onRead`, i.e. inside
  `findPayoutAccount`. That is **step 1 of the use case, strictly before the claim in both
  the correct and the mutated ordering**, so it cannot mask provider-first ordering —
  which the mutation above proves empirically.
- `ArrivalLatch` (pre-existing, `e965fa1`) rejects on its timeout rather than resolving, so
  it cannot pass vacuously, and once `arrivals >= expected` it stays open — so the loser
  path's *second* `findPayoutAccount` passes straight through instead of deadlocking.
- **The sequential control the brief warns about.** With the provider-first bug still in
  place I replaced `Promise.all` with a `for` loop over 30 sequential `await`s: the test
  went **green against the bug** (11 pass / 5 fail, the concurrency test no longer among
  the failures). The `Promise.all` shape is load-bearing, exactly as the brief says.
- The latch itself is belt-and-braces rather than the sole mechanism here: I also ran the
  rendezvous downgraded to a bare `latch.arrive()` (no blocking) against the provider-first
  bug, and the test still failed. That is a strengthening, not a weakness — worth recording
  so nobody "simplifies" it later on the theory that it is doing nothing.

### 3. No reader uses a truthiness check — CONFIRMED

`grep` for `xenditAccountId` / `xendit_account_id` across all of `src/` (not just the diff):
the only interpretations of the new column anywhere are `isConnectedPaymentAccount(...)` in
`ConnectUserPayout` and `payoutStatusOf(...)` in `get-user-payout-status.ts`. The repository
never interprets the value; it only compares against the imported constant in WHERE clauses.
No truthiness check exists on this column.

The implementer's two added tests genuinely kill the mutants:

| Mutation | Result |
|---|---|
| `isConnectedPaymentAccount(user.xenditAccountId)` → `user.xenditAccountId` in the early return (M1) | **15 pass / 1 fail** — killed by `"answers from a FRESH read, not the stale copy it started with"` |
| `isConnectedPaymentAccount` → `Boolean(...)` in `payoutStatusOf` (M2) | **4 tests fail**, including the route-level `"reports provisioning while a claim is held"` — so the kill is not confined to unit level |

Both reproduced here and reverted.

### 4. Idempotency — CONFIRMED

Pinned at three levels: the use case (`"is idempotent: connecting again returns connected
without a second provider call"`, asserting `payments.accounts` has length 1), the route
(`"is idempotent across a second POST — one provider account, not two"`, asserting against
the real `deps.payments` and the real column), and the loser path
(`"does not call the provider AT ALL when it loses the claim"`, asserting
`payments.accounts` is `[]`).

### 5. The reserved-handle guard is green — CONFIRMED, with my own positive control

```
$ bun test src/routes/users.test.ts -t "every literal /users segment"
 1 pass, 106 filtered out, 0 fail, 2 expect() calls
```

The report could not run the brief's positive control (remove the handle, watch it fail)
because `payout` was never added. I ran the equivalent from the other direction: I
temporarily mounted `app.get("/payout", …)` — a *first*-segment literal — and the guard went
red naming `"payout"` in `unprotected`. So the guard is live, and `/users/me/payout`
correctly does not trip it because the guard reads only the first segment (`me`, which
`HANDLE_PATTERN`'s `{3,30}` already makes unregisterable). Reverted.

Independent of the guard, the *safety* argument also holds: there is no bare
`/users/:handle` route at all (profiles are `/users/by-handle/:handle`), and none of the
`/:handle/*` routes is `payout`, so a user who registers the handle `payout` shadows
nothing. `/me/payout` is also mounted above every `/:handle/*` route.

### 6. `/dashboard/*` and its tables are untouched — CONFIRMED

`git diff --name-only 4d58473..619fa4d` touches nothing outside `apps/api/`.
`create-payment-account.ts`, `domain/payment-account.ts`, `drizzle-creator.repository.ts`,
`creator-repository.port.ts`, `start-checkout.ts` and the `creator` schema are byte-identical.
The Drizzle snapshot diff (`0025` → `0026`, normalised for `id`/`prevId`) is exactly one
hunk: `public.app_user.xendit_account_id varchar(255) NOT NULL=false`. Nothing else moved.

Regression run over the creator flow — `payment-account.test.ts`,
`create-payment-account.test.ts`, `start-checkout.test.ts` — plus all four covering files:
**338 pass / 0 fail** across 7 files, 55s. `tsc --noEmit` exits 0.

### 7. Copy, constants, and the network — CONFIRMED

- `NotFoundError("user not found")` in both use cases; English, and character-for-character
  the convention already used by the other 14 `NotFoundError` call sites.
- User-facing copy is Bahasa: `"pembayaran belum dikonfigurasi di server ini."` (503),
  `"koneksi pembayaran bentrok — hubungi dukungan DIUDARA."` (409).
- Both new test files define `const SENTINEL = "provisioning:in-progress"` as a **literal**
  and neither imports `XENDIT_ACCOUNT_PROVISIONING`. Route tests assert literal booleans.
- No test contacts Xendit: `bootstrap()` under `NODE_ENV=test` selects `FakePaymentAdapter`
  via the `RELAXED_NODE_ENVS` allowlist, and the new tests contain no URL of any kind.

---

## Findings

### F1 — Important: the database-level concurrency test cannot fail against a check-then-act claim

`apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.test.ts:121-135`,
`"lets exactly ONE of several concurrent claims win"`, uses `new ArrivalLatch(4)`.

This is the **only** test in the codebase that exercises the arbitration that actually runs
in production. The port's own docstring makes the requirement absolute:

> The implementation MUST decide that in a single conditional UPDATE
> (`where id = ? and xendit_account_id is null`) and report the affected row count. A
> `findPayoutAccount` in the use-case is a check-then-act and cannot arbitrate two
> simultaneous callers.

I replaced `beginXenditAccountProvisioning` with exactly that forbidden shape — a SELECT,
then an unconditional UPDATE — and the whole repository file stayed green:

```
14 pass / 0 fail        (5 consecutive runs of the race test alone: 5/5 green)
```

To find out why, I measured win counts directly against the real test database:

```
BAD  (check-then-act)  n=4   wins=1     <- indistinguishable from correct; test passes
GOOD (conditional UPDATE) n=4   wins=1
BAD  (check-then-act)  n=30  wins=27    <- test would fail loudly
GOOD (conditional UPDATE) n=30  wins=1
```

At N=4 the postgres.js pool serialises the four SELECT/UPDATE pairs enough that the
check-then-act version happens to produce the right answer. `latch.arrived === 4` is
satisfied — every caller demonstrably reached the barrier — but the *queries* never overlap,
so the latch produces the appearance of evidence without the substance. This is the same
failure mode the brief warns about ("a sequential version of this test passes against the
very bug it exists to catch"), arriving through a different door.

The crude mutant *is* caught, so the test is not worthless: dropping the `isNull` predicate
entirely (an unconditional UPDATE, the report's M4) fails 3 tests including this one. But the
realistic refactor — someone "simplifying" the conditional UPDATE into a read plus a write,
which is precisely what the creator incident was — ships green.

**The committed implementation is correct.** Nothing is broken today. What is missing is the
test that would keep it correct, on the one column in this codebase where losing the race
mints a permanent, undeletable KYC entity at a third party.

**Fix (one character, verified):** change `new ArrivalLatch(4)` to `new ArrivalLatch(30)` and
the `{ length: 4 }` to `{ length: 30 }`, matching both the incident and the use-case test's
own N. I ran the real repository at N=30 three times: `wins=1` every time, column holds the
sentinel, 42-139 ms per run. It also kills the check-then-act mutant (27 wins vs. an expected
1). No flakiness, no deadlock risk — 29 losers block on a single row lock under READ
COMMITTED, re-evaluate, and match zero rows.

Note for context, not as a request: `ArrivalLatch(4)` is the repo-wide convention for
DB-level races (`drizzle-user.repository.test.ts`, `drizzle-follow.repository.test.ts`,
`drizzle-join-request.repository.test.ts`, `drizzle-subscription.repository.test.ts` all use
4). This finding is scoped to the payout column, where the cost of a lost race is unique.
The other four are worth a look in a separate pass; the creator flow appears to have no
`ArrivalLatch` test on its claim at all.

### F2 — Minor: `PaymentProviderPort.createPaymentAccount`'s `creatorId` now carries an `app_user` id

See the dedicated judgement below.

### F3 — Minor (phase-level, not task-level): payout onboarding is ungated self-service

`POST /users/me/payout` is authenticated but otherwise unrestricted: any account created
through the open `POST /users/signup` can, with one request, provision a MANAGED Xendit
sub-account that has no delete endpoint. Idempotency caps it at one per user, so the bound
is "one permanent provider entity per signup", not per request — but signup is open, there
is no email verification gate on it, and there is no rate-limit ledger on this route the way
there is on `RegisterUser`'s notice or `RequestPasswordReset`.

This is parity with the already-shipped creator flow (`POST /payment-account` is likewise
open behind an open creator registration), so it is not a regression this task introduced —
but the `app_user` population is the large, public one, and Task 4's design ("a tier cannot
be published until payout is connected") means there is no natural product gate to put in
front of it. Worth a deliberate decision by the phase owner before 5a ships, not a change to
this task.

### F4 — Minor (documentation): the brief's Step 4 is factually wrong and should be corrected

Step 4 states `payout` "**must** join `RESERVED_HANDLES`" and that "the route-derived guard
in `routes/users.test.ts` will fail until it does". Neither is true, for the reason the
reviewer identified and I confirmed twice above. The implementer handled this well — the
deviation is recorded in the report, in a comment at the route, and in the test block's
docstring — but the brief itself is the artefact Tasks 4 and 6 will read next, and it will
send the next implementer to add a reservation that takes an ordinary Indonesian-usable word
away from users for nothing. Correct the brief.

---

## On the two rulings

### Ruling 1 — the four extra files are accepted: **AGREE**, and the case is stronger than stated

*The account id genuinely cannot reach an HTTP response.* Two independent barriers, not one:

1. `DrizzleUserRepository` selects an explicit `userColumns` / `publicListColumns` list in
   every read and `returning(userColumns)` in every write — no bare `.select()` or
   `.returning()` anywhere in that file — so the new column is never even fetched on the
   profile path.
2. `toOwnProfile` (`get-user-profile.ts:75`) constructs an explicit object literal rather
   than spreading the record, so even a widened `UserRecord` would not leak through it.

And the port keeps it that way by construction: `UserPayoutAccount` is the only shape
carrying the column, it is returned only by `UserPayoutRepositoryPort.findPayoutAccount`, and
`users.ts` receives a `Pick<Dependencies, …>` that does not include `userPayoutRepository`.
The two response shapes are two booleans plus a server-derived `available`; the route test
`"never puts the provider account id in the response body"` asserts the literal id string is
absent from the raw response text.

*The split is real, not nominal.* `getUserPayoutStatus` is constructed unconditionally in
`bootstrap()`; `connectUserPayout` is `payments ? … : undefined`. The route test
`"says available: false and 503s the POST on a box with no payment provider"` boots
`createApp({ ...deps, connectUserPayout: undefined })` and gets a working 200 GET plus a 503
POST. That is exactly the box the ruling describes, and it is exercised. A second method on
`ConnectUserPayout` could not have served it.

The `available` flag is a good addition beyond the brief, and composing it in the route
rather than in the use case is the right seam — `GetUserPayoutStatus` reads one column and
has no business knowing what `bootstrap()` wired.

### Ruling 2 — POST returns 200 idempotently rather than 201/409: **AGREE**

The brief mandates idempotency, and its own concurrency snippet is a bare `Promise.all` with
no `.catch` — 29 rejecting losers would make that snippet throw. Beyond the brief's internal
logic: the resource is created at most once per user *ever*, so 201 would be a lie on every
call after the first, and 409 would train the client to treat "someone else is already
connecting you" as a failure when it is the desired end state. The router's existing follow
routes already use "respond with the resulting state" for the same reason. The deliberate
divergence from `CreatePaymentAccount`'s 409 is documented in both docstrings, which is what
stops it reading as an inconsistency.

---

## Judgement: `creatorId` carrying an `app_user` id

**Severity: Minor. There is a fix that stays inside the task's bounds, and I would take it —
but not the rename.**

The implementer's reasoning is sound as far as it goes, and I verified the load-bearing part:
`XenditPaymentAdapter.createPaymentAccount` sends only `email`, `type: "MANAGED"`, and
`public_profile.business_name`. `creatorId` is never serialised, never reaches the provider,
and cannot mis-route money. Nothing incorrect leaves the process. Renaming it to `ownerId`
would touch `create-payment-account.ts` and both adapters, which is correctly out of bounds.

But "inert today" is not the same as "harmless". The field is not entirely unused:
`FakePaymentAdapter` stores `{ creatorId, accountId }` and interpolates it into the account
id it mints (`fake-acct-1-<app_user uuid>`), so on every development box this now writes an
`app_user` id into a string labelled `creatorId`. The next reader who adds a log line, an
audit row, or a reconciliation join keyed on that field will key it to the wrong table, and
this is money-routing code where that class of mistake is expensive to unwind. The
codebase's own standard is against this: it documents far smaller hazards at far greater
length.

**The in-bounds fix I would take** — one edit, to `payment-provider.port.ts` only, touching no
behaviour and no other file:

```ts
export interface CreatePaymentAccountInput {
  /**
   * The OWNER's id: `creator.id` for the /dashboard/* flow, `app_user.id` for
   * Phase 5a's payout flow. The name is historical — this port predates the
   * second owner table. INERT: no adapter sends this to the provider (Xendit
   * receives `email` and `public_profile.business_name` only), so it is safe to
   * carry either id. Do not join it to `creator` without checking which flow
   * produced it.
   */
  creatorId: string;
  email: string;
  name: string;
}
```

and reference it from `createPaymentAccount(input: CreatePaymentAccountInput)`. Because
TypeScript is structural, the inline literal parameter types in
`XenditPaymentAdapter`/`FakePaymentAdapter` still satisfy the port unchanged, and
`create-payment-account.ts` needs no edit at all — the constraint the implementer was
respecting is not breached. `CreateInvoiceInput` next door is already extracted this way, so
this is the file's existing shape, not a new pattern.

**Why not the alternatives.** A type alias (`type OwnerId = string`) documents nothing at the
call site and TypeScript erases it. A narrower port (`PaymentAccountProviderPort`) is a real
improvement to the dependency graph but does not touch the field name, which is the actual
hazard. An added optional `ownerId` alongside `creatorId` gives two names for one value —
strictly worse.

**Why not "live with it".** Living with it *silently* is the worst option, because the field
name is currently the only documentation the field has. Living with it *documented* costs one
comment and closes the hazard. Do the rename when a task legitimately owns
`create-payment-account.ts`; document it now.

---

## Recommended actions

1. **F1 (Important):** raise the repository race test from 4 to 30 callers. One line; verified
   green 3/3 on the real implementation at 42-139 ms, and verified red against check-then-act.
2. **F2 (Minor):** extract and document `CreatePaymentAccountInput` in
   `payment-provider.port.ts` as above. No other file changes.
3. **F3 (Minor):** phase-owner decision on gating payout onboarding. No task change.
4. **F4 (Minor):** correct Step 4 of the brief before Task 4 reads it.

Nothing here blocks the commit; F1 blocks the *next* refactor of this repository, which is
the point of raising it now.

## Tree state

Every mutation was reverted with `git checkout --` and two temporary probe files were removed.
`git status` reports a clean tree. Nothing was force-added to `.superpowers/`.
