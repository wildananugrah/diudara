# Task 5 report — the offer on a profile

Commit: `2584071` — feat(api): show a creator's membership offer on their public profile (Task 5, Phase 5a)

## What was built

`GET /users/by-handle/:handle` now returns `membership: { tiers: [{ id, name, priceAmount, billingCycle }] }` alongside the fields Task 2 already pinned.

**New file** `apps/api/src/application/use-cases/tier-views.ts` — per the pre-flight ruling, not a widening of `post-views.ts`. Exports:
- `TierView` / `toTierView(row)` — closes `UserTierRow` (8 fields) down to exactly `id`/`name`/`priceAmount`/`billingCycle`.
- `MembershipView` / `toMembershipView(rows)` — wraps tiers under `{ tiers: [...] }`; `tiers` is always an array, built from whatever `listActiveByOwner` returned (no re-filtering).

**Modified** `apps/api/src/application/use-cases/get-user-profile.ts`:
- `PublicUserProfile` gains `membership: MembershipView`.
- `GetUserProfile`'s constructor takes a third dependency, `UserTierRepositoryPort`.
- `execute()` adds `this.tiers.listActiveByOwner(user.id)` as a third leg of the existing `Promise.all` (alongside follow counts and `isFollowing`) — one query, run concurrently with the reads this profile already needed, not sequenced after them.
- `executeOwn()` (`GET /users/me`) is untouched — membership is a public-profile concern, per spec §6 ("A profile shows the offer"), not the caller's own record.

**Wiring**: `apps/api/src/bootstrap.ts` now constructs `GetUserProfile` with `userTierRepository` (already existed from Task 1, positioned before `getUserProfile`, so no reordering needed). `apps/api/src/bootstrap.test.ts`'s two `Dependencies` construction sites updated to pass the existing `fakeUserTierRepository`.

## Judgement calls the thin brief left open

1. **File location for `tier-views.ts`.** The brief's literal path (`apps/api/src/application/post-views.ts`) is stale — the real file lives at `apps/api/src/application/use-cases/post-views.ts`. Put the new file in the same directory, `use-cases/tier-views.ts`, for consistency with every other per-response-shape module.

2. **"No payout account" as a distinct empty-list trigger.** Read `manage-user-tiers.ts`'s `create()` closely: a tier cannot be published without a *connected* payout account (`isConnectedPaymentAccount` gate), and there is no disconnect path on `UserPayoutRepositoryPort` — once connected, it stays connected. So "no payout account" cannot produce an *active* tier in the first place; it is subsumed by "no tiers," and `listActiveByOwner` returning `[]` covers both cases identically. I did not add a second, redundant payout-account check in `GetUserProfile` — that would duplicate an invariant the write side (Task 4) already enforces, and there is no way to independently observe "connected once, tiers exist, payout since disconnected" in the current schema. I did write an explicit route-level test asserting a payout-less, tier-less profile reports `{ tiers: [] }`, per the brief's literal wording.

3. **`executeOwn` scope.** The brief's interface line says "on the public profile," singular. I read that as scoping `membership` to `execute()` only, and added a test proving `executeOwn` never touches the tier repository at all (a thrown-on-every-method fake), so a future change routing `GET /users/me` through the same code path fails loudly rather than silently.

4. **Proving "one query, not one per tier" directly, not by inference.** Mirrors the existing pattern in `explore-users.test.ts` ("THE RULING: one query...") and `read-posts.test.ts` (`forPostsCalls`): the fake `UserTierRepositoryPort` in `get-user-profile.test.ts` records every `listActiveByOwner` call in an array and the test asserts it equals `["user-1"]` — one call, with the right owner id. A per-tier-lookup implementation would still pass every output assertion; only this proves the query count.

## Red phase output

**`tier-views.ts`** (brand-new file — per the brief's TDD note, stubbed first so the test module loads and fails on assertions, not on a missing import):
```
(fail) toTierView > returns EXACTLY id, name, priceAmount and billingCycle — never ownerId, isActive or createdAt
  Expected  - 3 (billingCycle, name, priceAmount all missing from stub's { id: "not-implemented" })
(fail) toMembershipView > wraps tiers under `tiers`, mapped through toTierView, in the given order
  Expected  - 14 (stub always returned { tiers: [] })
 1 pass, 2 fail
```

**`get-user-profile.ts`** (existing file — extra constructor arg is simply unused by JS at runtime, so no stub needed; real red against the real class):
```
(fail) returns EXACTLY .../membership... — Expected -1: "membership" key missing
(fail) a tier on the wire is EXACTLY... — TypeError: undefined is not an object (evaluating 'profile.membership.tiers')
(fail) a profile with no tiers reports membership: { tiers: [] }... — Expected: true, Received: false ("membership" in profile)
(fail) fetches this owner's tiers in a SINGLE listActiveByOwner call... — Expected ["user-1"], Received []
 9 pass, 4 fail
```

**`routes/users.test.ts`** (integration level — written after the unit-level implementation existed, so I proved red honestly by `git stash push` on the three production files, running the suite, and popping the stash back):
```
(fail) returns EXACTLY .../membership — Expected -1: "membership" missing
(fail) a profile with no payout account and no tiers reports membership: { tiers: [] } — Expected: true, Received: false
(fail) lists a published tier with EXACTLY id/name/priceAmount/billingCycle — TypeError: undefined is not an object (evaluating 'body.membership.tiers')
(fail) a DEACTIVATED tier is never offered to a visitor — same TypeError
(fail) keeps one owner's tiers off another owner's profile — Expected { tiers: [] }, Received undefined
 0 pass, 5 fail (117 filtered out)
```
All failures are assertion/type mismatches on the missing feature, not import or setup errors — confirmed the right reason before implementing.

## How the projection's closure was proved

`Object.keys(...).sort()` assertions at three independent layers, each catching the same class of leak on its own:
- `tier-views.test.ts` — the pure `toTierView` function, isolated from any repository or HTTP concern.
- `get-user-profile.test.ts` — the use case's output, via a fake `UserTierRepositoryPort`.
- `routes/users.test.ts` — the actual HTTP response body, against a real Postgres-backed tier created and read through the full stack.

I then manually mutation-tested (no mutation-testing tool is configured in this repo) by injecting three real bugs one at a time, confirming failure, then reverting to the exact committed state (`git status` clean after each):
1. Widened `execute()` to call `listByOwner` (all tiers, not just active) instead of `listActiveByOwner` — caught by both the fake-repository's "must not be called" throw in the unit test *and* the real-database "DEACTIVATED tier" route test independently.
2. Added `ownerId` to `toTierView`'s return — caught by all three `Object.keys` assertions (`tier-views.test.ts`, `get-user-profile.test.ts`, and implicitly would have failed `routes/users.test.ts` too).
3. Made `toMembershipView` return `{}` instead of `{ tiers: [] }` when `rows` is empty (the Phase 4 white-screen mistake, deliberately reproduced) — caught by the "not an omitted field" tests at both the pure-view and use-case levels.

## How "one query, not one per tier" was confirmed

Unit-level: `fakeUserTierRepository` in `get-user-profile.test.ts` pushes every `listActiveByOwner(ownerId)` call into an array; the test asserts it equals exactly `["user-1"]` after `execute()` runs, and every other port method (`findById`, `listByOwner`, `create`, `deactivate`) throws if touched at all. Mutation-tested per above (switching to `listByOwner` fails this test with a thrown error, not a silent output difference).

There is no N+1 risk *within* one profile fetch the way a feed page has one per post — a single profile has exactly one owner — so this is really "one call to the repository, not a per-row lookup on top of it" (e.g. no `findById` loop over ids returned by some other list). The real `DrizzleUserTierRepository.listActiveByOwner` (Task 1, unchanged by this task) is itself already a single scoped SQL query with `and(eq(ownerId), eq(isActive, true))`.

## Test counts

- Before: 150 files. `get-user-profile.test.ts` had 9 tests, `routes/users.test.ts` had 118 tests.
- After: 151 files (new `tier-views.test.ts`, 3 tests). `get-user-profile.test.ts` went from 9 to 13 tests (+4: closed-key membership check folded into the existing "returns EXACTLY" test, plus 3 new tests in a dedicated "membership (Task 5)" describe block, plus 1 new "never touches the tier repository" test on `executeOwn`). `routes/users.test.ts` went from 118 to 122 tests (+4: a new "membership (Task 5)" describe block; the existing "returns EXACTLY" test was widened in place, not duplicated).
- Full suite after: **2257 pass / 0 fail**, 151 files, 6029 `expect()` calls, ~257s. `tsc --noEmit` clean throughout.
- `tsc --noEmit` clean throughout (api package).

## Self-review confirmation

- `git status` clean after the commit and after every mutation-test revert.
- No field beyond `id`/`name`/`priceAmount`/`billingCycle` can reach the wire per tier — proved at three layers, mutation-tested.
- `membership` is never omitted, always `{ tiers: [...] }` — proved at three layers, mutation-tested.
- Only active tiers appear — proved end-to-end against a real database (publish two, deactivate one, confirm exactly the live one remains) and defended by a unit-level "must not call `listByOwner`" throw.
- One query, not one per tier — proved directly via call-count assertion, mutation-tested.
- `NotFoundError` sites untouched by this task (no new error paths were needed — an unknown handle already 404s before any tier read happens).
- No Bahasa Indonesia copy needed — this task adds no new user-facing strings, only a wire shape Task 10 will render.
- `/dashboard/*` and its six tables (`community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`) untouched — confirmed by `git diff --stat`, nothing outside `apps/api/src/application/use-cases/{get-user-profile,tier-views}*.ts`, `apps/api/src/bootstrap{,.test}.ts`, and `apps/api/src/routes/users.test.ts`.
