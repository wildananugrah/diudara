# Task 5 review — the offer on a profile

Reviewed at commit `2584071` (HEAD, on top of `9b37b86`), against `.superpowers/sdd/2026-08-20-memberships-5a/task-5-brief.md`, spec §6, and the diff package `review-9b37b86..2584071.diff`.

## Verdict 1: Spec compliance — ✅

§6 says: "A profile shows the offer and a 'Jadi anggota' button." This task delivers the API half of that ("shows the offer"): `GET /users/by-handle/:handle` now returns `membership: { tiers: [{ id, name, priceAmount, billingCycle }] }`. The button and its web rendering are out of scope for this task (Task 10, per the report). `executeOwn` (`GET /users/me`) is correctly left untouched — the offer is a public-profile concern, not the caller's own record. Nothing in `/dashboard/*` or its six tables (`community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`) was touched — confirmed by `git diff 9b37b86..2584071 --stat`, which lists only `get-user-profile.{ts,test.ts}`, `tier-views.{ts,test.ts}` (new), `bootstrap.{ts,test.ts}`, and `routes/users.test.ts`.

## Verdict 2: Task quality — Approved

No Critical or Important findings. One Minor observation below.

### Findings

- **Minor — `toMembershipView`'s "no re-filter" contract is trust, not enforcement.** `toMembershipView` maps whatever rows it's given without re-checking `isActive`/`ownerId`; correctness for those two properties rests entirely on `listActiveByOwner`'s own query and is proved by a *different* test suite (`drizzle-user-tier.repository.test.ts`, from Task 1). This is a reasonable layering choice (matches `fakeFollowRepository`'s existing pattern in this file) and is explicitly documented in both the production code and the test file's docstrings, so it's not a gap in reasoning — just a note that Task 5's own unit tests could not, by themselves, catch an owner-scoping regression if it lived only in the repository. In practice this is covered anyway: Task 5's own `routes/users.test.ts` test ("keeps one owner's tiers off another owner's profile") runs against a real Postgres-backed repository and independently reddens on the same mutation (see verification below), so the leak this endpoint would produce is caught. Not a blocker.

## Verification performed

All commands run from `apps/api`, covering only the three files named in the brief plus the repository file for the owner-scoping check. Full api suite was **not** run (per instructions); the implementer's report already carries that evidence (2257 pass / 0 fail, ~257s).

**Baseline (unmodified tree):**
```
bun test src/application/use-cases/tier-views.test.ts src/application/use-cases/get-user-profile.test.ts src/routes/users.test.ts
138 pass, 0 fail, 324 expect() calls, 62.79s
```
Matches the implementer's reported counts (tier-views: 3, get-user-profile: 13, users.test.ts: 122).

**Mutation 1 — projection widening.** Added `ownerId: row.ownerId` to `toTierView`'s return in `tier-views.ts`. Result: **5 named tests reddened** across all three layers:
- `toTierView > returns EXACTLY id, name, priceAmount and billingCycle — never ownerId, isActive or createdAt` (`tier-views.test.ts`)
- `toMembershipView > wraps tiers under 'tiers', mapped through toTierView, in the given order` (`tier-views.test.ts`)
- `GetUserProfile.execute (public, by handle) > returns EXACTLY ... /membership ...` (`get-user-profile.test.ts`)
- `GetUserProfile.execute — membership (Task 5) > a tier on the wire is EXACTLY id/name/priceAmount/billingCycle ...` (`get-user-profile.test.ts`)
- `GET /users/by-handle/:handle — membership (Task 5) > lists a published tier with EXACTLY id/name/priceAmount/billingCycle ...` (`routes/users.test.ts`, real HTTP body)

All four assertions that catch this use `Object.keys(...).sort()` against a literal array, not a spot-check of individual fields — confirmed by reading the assertions directly (`get-user-profile.test.ts:228`, `tier-views.test.ts:480`, `routes/users.test.ts:801`, plus the closed-key assertion on the whole profile). Reverted; `git status` clean.

**Mutation 2 — active-tier scoping.** Changed `this.tiers.listActiveByOwner(user.id)` to `this.tiers.listByOwner(user.id)` in `get-user-profile.ts`. Result: **10 tests reddened**, including the unit-level fake's thrown "not used in these tests — the public profile reads listActiveByOwner" error (`listByOwner` throws in the fake) and, independently, the real-database route test `a DEACTIVATED tier is never offered to a visitor`. Both catch the mutation on their own — confirms two independent layers guard the active-only requirement. Reverted; `git status` clean.

**Mutation 3 — the Phase-4 white-screen mistake.** Changed `toMembershipView` to return `{}` instead of `{ tiers: [] }` when `rows` is empty. Result: **5 named tests reddened**, including `toMembershipView > an owner with no active tiers gets an EMPTY array, not an omitted or undefined field`, the use-case-level and route-level "not an omitted field" tests, and (incidentally) the closed-key `Object.keys` assertions on the whole profile (since the `membership` key disappeared). Confirms the field is never omitted, including for a profile that has never touched memberships. Reverted; `git status` clean.

**Mutation 4 — owner scoping at the repository (Task 1 concern, retested here).** In `drizzle-user-tier.repository.ts`, dropped `eq(userTiers.ownerId, ownerId)` from `listActiveByOwner`'s `where` clause. Result: **2 tests reddened** — `DrizzleUserTierRepository > excludes deactivated tiers from listActiveByOwner, and other owners' tiers too` (Task 1's own pinned test) **and**, independently, Task 5's `GET /users/by-handle/:handle — membership (Task 5) > keeps one owner's tiers off another owner's profile`. This confirms Task 5's own test suite would also catch one profile leaking another's tiers, not just Task 1's — the exact leak this public endpoint would produce if scoping regressed. Reverted; `git status` clean.

**One-query claim.** Verified by reading the mechanism, not just trusting the report: `fakeUserTierRepository` in `get-user-profile.test.ts` (lines ~79–102) pushes every `listActiveByOwner(ownerId)` call into a `listActiveByOwnerCalls: string[]` array; every other port method (`findById`, `listByOwner`, `create`, `deactivate`) throws if touched. The test at line 291 asserts `expect(tiers.listActiveByOwnerCalls).toEqual(["user-1"])` — exact array equality, catching zero calls, more than one call, or a wrong owner id, not merely "was called." This is a direct call-count assertion, not an inference from output shape. The real `DrizzleUserTierRepository.listActiveByOwner` (Task 1, unchanged) is itself one scoped SQL query with a two-predicate `and()`.

**Other checks:**
- `tier-views.ts` is a genuinely new file at `apps/api/src/application/use-cases/tier-views.ts`, not an addition to `post-views.ts` — confirmed by `git diff --stat` showing it as a new file and `post-views.ts` absent from the changed-files list entirely.
- `executeOwn` is provably untouched: a dedicated test constructs a `UserTierRepositoryPort` where every method throws "must not be called" and asserts `executeOwn` still resolves — this fails loudly if a future change routes `GET /users/me` through the tier repository.
- Tests assert literal values (`50_000`, `"monthly"`, `"Anggota"`, exact key-name arrays), never named constants, throughout the diff.
- `docs/image.png` and the pre-existing unrelated `apps/web/src/user/*` modifications in the working tree are untouched by and unrelated to this review (pre-existing dirty state from other work, not part of Task 5's diff).

## Tree state

`git status --short` returns empty after every mutation-and-revert cycle. Tree left exactly as found.
