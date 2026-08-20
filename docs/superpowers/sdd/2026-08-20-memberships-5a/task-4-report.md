# Task 4 report — managing membership tiers

Branch `feat/memberships`, commit `9b37b86`.

## What was built

- `apps/api/src/application/use-cases/manage-user-tiers.ts` — `ManageUserTiers`, one class with
  three methods (`create`, `list`, `deactivate`) over `UserTierRepositoryPort` (Task 1) and
  `UserPayoutRepositoryPort` (Task 3). One class, not three, because unlike the dashboard's
  `DefineMembershipTier`/`ListTiers`/`UpdateTier` (`manage-tiers.ts`, untouched) every method here
  touches the same two ports and there is no community lookup first.
- `apps/api/src/routes/users.ts` — `GET /users/me/tiers`, `POST /users/me/tiers`,
  `PATCH /users/me/tiers/:tierId`, all behind `requireUserAuth`. Two local Bahasa-only body
  parsers (`parseCreateUserTierBody`, `parsePatchUserTierBody`) mirror the file's existing
  `parseFollowListLimit`/`parseExploreQuery` pattern: zod for shape, a hand-written message on
  failure rather than zod's own English issue text.
- `apps/api/src/bootstrap.ts` — wired `userTierRepository` (`DrizzleUserTierRepository`, built in
  Task 1 but never wired) and `manageUserTiers` into `Dependencies`. Unconditional, unlike
  `connectUserPayout` — this needs no `PaymentProviderPort`.
- `apps/api/src/bootstrap.test.ts` — added `fakeUserTierRepository` and wired both new fields into
  the two hand-built `Dependencies` fixtures the composition-root test uses.
- Tests: `manage-user-tiers.test.ts` (13 tests, fakes) and a new describe block in
  `routes/users.test.ts` (11 tests, real DB via `bootstrap()`/`createApp()`).

## The gate, and how it's proven

`ManageUserTiers.create` refuses unless `isConnectedPaymentAccount(payout.xenditAccountId)` is true
— never a truthiness check. Two tests exist specifically for the sentinel:

- `manage-user-tiers.test.ts` — `"THE SENTINEL DOES NOT COUNT AS CONNECTED: a mid-provisioning
  owner is refused too"`: seeds a fake payout row with the literal string
  `"provisioning:in-progress"` (never the imported constant) and asserts `ConflictError`, and that
  no tier row was created.
- `routes/users.test.ts` — `"THE SENTINEL DOES NOT COUNT AS CONNECTED — a mid-provisioning payout
  also refuses tier creation"`: claims the real column via
  `deps.userPayoutRepository.beginXenditAccountProvisioning(userId)` (never by POSTing twice, which
  would just finish the connection) and asserts the HTTP route answers 409.

**I re-broke the gate on purpose to confirm the tests actually catch it.** After committing, I
changed the guard to `if (!payout.xenditAccountId)` (the truthiness bug the task warns about) and
reran the sentinel-focused tests: both failed immediately — the unit test got a created tier object
instead of a thrown `ConflictError`, and the HTTP test got `201` instead of `409`. I then reverted
the change; `git diff` on `manage-user-tiers.ts` is clean and the full targeted rerun is green
again. This was a manual mutation check on the one line the brief singles out as "the mistake that
would matter most here," not a full mutation-testing pass — the brief doesn't ask for one, unlike
Task 3's own follow-up commit.

The refusal message (Bahasa, names the remedy):

> "Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan keanggotaan — uang
> dari tingkatan ini belum punya tempat tujuan."

## Red phase

For the unit-test file, I stubbed `ManageUserTiers` (every method either `throw new Error("not
implemented")` or an empty/no-op return) and reran `manage-user-tiers.test.ts`:

```
13 fail / 0 pass
```

Every failure was on its own assertion — a thrown "not implemented" surfacing as `error:
not implemented` where the test expected a specific `ConflictError`/`ValidationError`/
`NotFoundError` instance, or an `expect([...]).toEqual([])` failing against the stub's hard-coded
`[]` return. None was a load/import error. I then restored the real implementation (13 pass / 0
fail).

For the HTTP-level tests, I reverted `routes/users.ts` to its pre-Task-4 committed version (routes
absent, but `Dependencies`/bootstrap wiring left in place) and reran the new describe block:

```
10 fail / 1 pass (117 filtered out)
```

The one pass was the unauthenticated-401 test (401 fires from `requireUserAuth`/route-miss before
any tier logic is reached, so it's not evidence either way — noted here for honesty). Every other
test failed on its real assertion: `404` where `409`/`201`/`400`/`200` was expected, or a
`SyntaxError: Failed to parse JSON` where the test tried to read a tier id out of a 404 body. I then
restored the real `routes/users.ts` (11 pass / 0 fail).

## The reserved-handle guard

Ran before restoring the routes (routes absent, `me`/`me/payout` still mounted) and after (routes
mounted):

```
cd apps/api && bun test src/routes/users.test.ts -t "every literal /users segment"
 1 pass / 0 fail   (both times)
```

I also wrote a one-off script against the running app (`createApp(bootstrap())`) to inspect the
actual derived set directly, before committing:

```
shadowable:   ["explore", "feed", "limits", "login", "media", "posts", "signup"]
unprotected:  []
```

`/users/me/tiers` and `/users/me/tiers/:tierId` both appear in the route table, and neither
contributes to `shadowable` — their first segment is `me`, which `isValidHandle` already rejects at
2 characters (`HANDLE_PATTERN` requires 3-30). `RESERVED_HANDLES` was not touched. This confirms the
brief's correction over the earlier (wrong) draft plan.

## Test counts

- Before this task: 2246 total tests in the api suite minus the 24 I added = 2222 (2246 measured
  after this task's changes; I did not re-run the pre-Task-4 tree's full suite separately, since no
  existing test was modified — only two fixtures in `bootstrap.test.ts` gained two new keys each).
- After: full `bun test` in `apps/api` — **2246 pass, 0 fail, 6006 expect() calls, 150 files,
  267.99s**.
- New tests added: 13 (`manage-user-tiers.test.ts`) + 11 (`routes/users.test.ts`'s new describe
  block) = 24.

## Judgement calls the brief left open

1. **One class (`ManageUserTiers`) with three methods, not three classes.** The brief's "Produces"
   line names a single class (`ManageUserTiers`), and unlike `manage-tiers.ts`'s three classes
   (which each need a different community-ownership check first), all three of mine share the
   identical two-port constructor with nothing to differentiate them.

2. **PATCH's shape.** The brief writes the route literally as `PATCH /users/me/tiers` but a PATCH
   without a target tier id makes no sense once "one owner cannot edit another's tier" is a named
   test — I mounted it as `PATCH /users/me/tiers/:tierId`, matching the dashboard's own
   `routes/tiers.ts` (`PATCH /:tierId`) exactly.

3. **PATCH only supports deactivation.** `UserTierRepositoryPort` (Task 1) exposes `deactivate` and
   nothing else that mutates an existing row — no `update`/`reactivate`. So the PATCH body schema
   is `z.object({ isActive: z.literal(false) })`; `{ isActive: true }` is refused with 400 rather
   than silently ignored or treated as a no-op success, because accepting it would imply a
   capability (reactivation) the repository does not have. I added one small test for this
   (`"isActive: true is refused, not silently ignored"`) beyond what the brief named, since it's
   direct behavior of code I wrote.

4. **Price must be *strictly* positive**, not merely non-negative — the brief says "price must be
   positive," and the dashboard's own `assertValidTier` (which only rejects `< 0`) was deliberately
   not reused or copied for this reason.

5. **Billing cycle restricted to `"monthly"` for 5a**, even though the column is a free-form
   varchar (spec §4: "monthly for now"). `ALLOWED_BILLING_CYCLES` is a `Set` of one, checked in the
   use case (Bahasa `ValidationError`) rather than the HTTP shape schema, so 5b can widen it without
   touching the route's parsing.

6. **All shape and business validation on this surface is Bahasa**, including malformed-JSON and
   malformed-body cases, by *not* using the existing `validate()` middleware (whose failure path
   emits zod's own English issue text via `describeIssues`). Instead the route parses the body
   itself and calls a local parser that writes its own message on failure — same pattern the file
   already uses for `parseFollowListLimit`/`parseExploreQuery`.

7. **Ownership mismatch on PATCH is 404, not 403** — mirrors `manage-tiers.ts`'s own
   `assertOwnsCommunity`, which 404s rather than discloses another owner's tier exists.

8. **`GET /users/me/tiers` returns `listByOwner` (every tier, active and inactive)**, never
   `listActiveByOwner` — this is the owner's own Pengaturan management view, not the public
   profile projection Task 5 will read.

9. Added one test not named in the brief but directly testing implemented behavior: rejecting a
   non-integer price (`49_999.5`), since `Number.isInteger` is part of the positivity check I
   wrote and untested code paths in a money-adjacent gate felt wrong to leave uncovered.

## Self-review

- `git status` is clean after the commit; `git diff --stat` on the six touched files shows only
  additive changes plus the two new-field insertions into the two existing `bootstrap.test.ts`
  fixtures — no dashboard file, no `community`/`membership_tier`/`member`/`subscription`/
  `transaction`/`creator` table or route touched.
- Grepped the whole diff for `xenditAccountId` truthiness (`if (x.xenditAccountId)`,
  `Boolean(x.xenditAccountId)`): the only conditional against it is
  `isConnectedPaymentAccount(payout.xenditAccountId)`.
- `NotFoundError` messages (`"user not found"`, `"tier not found"`) are English, matching the
  absolute convention. `ConflictError`/`ValidationError` messages are all Bahasa.
- No `RESERVED_HANDLES` change.
