# Task 4 review — managing membership tiers

Reviewed against `docs/superpowers/specs/2026-08-20-memberships-5a-design.md` §5–§6, the
task-4 brief, the implementer's report, and the diff `730a53b..9b37b86`.

## Verdict 1: Spec compliance — ✅

- §5 "A tier cannot be published without a connected payout account": enforced in
  `ManageUserTiers.create` (`apps/api/src/application/use-cases/manage-user-tiers.ts:78`) via
  `isConnectedPaymentAccount(payout.xenditAccountId)` — the domain predicate from
  `apps/api/src/domain/payment-account.ts`, never a truthiness check. Grepped the whole diff
  for `xenditAccountId`: the only conditional against it is that call.
- §6 "Pengaturan gets a tier editor — create, edit, deactivate": `POST/GET/PATCH
  /users/me/tiers[/:tierId]` implemented in `apps/api/src/routes/users.ts`. "Edit" is scoped to
  the only mutation `UserTierRepositoryPort` (Task 1) exposes — `deactivate` — which is a
  reasonable, disclosed reading (report item 3), not a shortfall against what Task 1 shipped.
- §4 "a deactivated tier stops being offered; existing subscriptions are unaffected": proven at
  the HTTP level with a real `user_subscription` row (`routes/users.test.ts`, "PATCH
  deactivates a tier without touching an existing subscription to it") — status and
  `current_period_end` asserted unchanged after deactivation.
- `/dashboard/*` and its tables (`community`, `membership_tier`, `member`, `subscription`,
  `transaction`, `creator`): diff touches only 6 files, none of them dashboard routes/use-cases;
  confirmed `git diff 730a53b..9b37b86 -- apps/api/src/application/use-cases/manage-tiers.ts
  apps/api/src/routes/tiers.ts apps/api/src/db/schema.ts` is empty.
- `tiers` correctly absent from `RESERVED_HANDLES` (confirmed via grep of
  `apps/api/src/domain/handle.ts`); the guard test `"every literal /users segment..."` passes
  independently, run here.

## Verdict 2: Task quality — Approved, no Critical or Important findings

### The payout gate (the defect this review most needed to rule out)

- Confirmed the gate goes through `isConnectedPaymentAccount`, not truthiness (see above).
- Confirmed a sentinel-specific test exists at both layers, not just a NULL test:
  - `manage-user-tiers.test.ts`: `"THE SENTINEL DOES NOT COUNT AS CONNECTED: a mid-provisioning
    owner is refused too"` — seeds the fake payout row with the **literal string**
    `"provisioning:in-progress"` (a local `SENTINEL` const, not the imported one — so the test
    doesn't compare the code against itself).
  - `routes/users.test.ts`: `"THE SENTINEL DOES NOT COUNT AS CONNECTED — a mid-provisioning
    payout also refuses tier creation"` — claims the real column via
    `beginXenditAccountProvisioning`, then asserts `POST /users/me/tiers` → 409.
- **Independently mutated the gate** (`if (!payout.xenditAccountId)` in place of
  `!isConnectedPaymentAccount(...)`) and reran `manage-user-tiers.test.ts`:
  - 12 pass / **1 fail** — `ManageUserTiers.create > THE SENTINEL DOES NOT COUNT AS CONNECTED: a
    mid-provisioning owner is refused too`. The test expected `ConflictError` and instead got a
    fully created tier row. Every other test, including the NULL-account test, still passed —
    exactly the distinction the review brief predicted. Reverted with `git checkout --`; `git
    diff` confirmed clean before moving on.

### Ownership scoping

- `ManageUserTiers.deactivate` refuses with `NotFoundError` when `tier.ownerId !==
  input.ownerId` (`manage-user-tiers.ts:118`).
- The unit test seeds only `owner-1`'s tier but attacks it as `"someone-else"` — a distinct
  identity, so the check is exercised, not vacuous. More importantly, the **HTTP-level** test
  seeds two real, independently signed-up owners (`tierUser(a)` and `tierUser(a, { handle:
  "rina", email: "rina@example.com" })`) each with their own connected payout and their own
  tier, and asserts cross-owner PATCH → 404 with the victim's tier left `isActive: true`. This
  is not the single-owner vacuity Task 1 had — a second owner's data genuinely exists in the
  fixture. The `list` unit test likewise seeds `owner-1` and `owner-2` tiers and asserts only
  `owner-1`'s come back.
- **Independently mutated** `deactivate`'s guard to `if (!tier)` (dropping the ownership
  comparison) and reran `manage-user-tiers.test.ts`: 12 pass / **1 fail** —
  `ManageUserTiers.deactivate > REFUSES with NotFoundError when the tier belongs to a DIFFERENT
  owner — one owner cannot edit another's tier`. Got the mutated (but successfully deactivated)
  tier row back instead of a thrown `NotFoundError`. Reverted; `git status` clean afterward.

### Price validation

- Strictly positive, integer-only (`!Number.isInteger(input.priceAmount) ||
  input.priceAmount <= 0`), pinned by tests for `[0, -1, -50_000]` and for a non-integer
  (`49_999.5`), each asserting `ValidationError` and (for the boundary set) the literal Bahasa
  message `"Harga tingkatan harus lebih dari nol."`. HTTP-level test asserts 400 for `[0,
  -10_000]` and confirms nothing was created via a follow-up `GET`.

### Bahasa refusals naming the remedy

- Payout gate: *"Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan
  keanggotaan — uang dari tingkatan ini belum punya tempat tujuan."* — names the action (connect
  a payout account) and the consequence. Reads well as the target reader.
- PATCH reactivate-refusal: *"Saat ini tingkatan hanya dapat dinonaktifkan, dengan mengirim {
  isActive: false }."* — also names what's allowed instead of just refusing.
- `NotFoundError` messages (`"user not found"`, `"tier not found"`) are English at both call
  sites, matching the codebase-wide convention; confirmed via `errors.ts`
  (`NotFoundError` defaults to English, no override here).

### Wiring / composition root

- `bootstrap.ts`: `userTierRepository` (Task 1's `DrizzleUserTierRepository`, previously
  unwired) and `manageUserTiers` added unconditionally (no `PaymentProviderPort` dependency),
  correctly distinguished from `connectUserPayout`'s conditional wiring.
- `bootstrap.test.ts`: both hand-built `Dependencies` fixtures updated with a `fakeUserTierRepository`
  and `new ManageUserTiers(...)`. Ran `bun test src/bootstrap.test.ts`: 163 pass / 0 fail.
- Reserved-handle guard (`bun test src/routes/users.test.ts -t "every literal /users
  segment"`): 1 pass / 0 fail, run here independently.

### Tests assert literal values

- Confirmed throughout: expected Bahasa strings, status codes, and the sentinel are all written
  as literals in the test files, not re-derived from the constants/messages under test (e.g.
  local `SENTINEL = "provisioning:in-progress"` rather than importing
  `XENDIT_ACCOUNT_PROVISIONING`).

### Could these tests fail for their own reasons?

- The report's own honesty note about the 401/unauthenticated test being uninformative (fires
  before tier logic runs) is correct and appropriately caveated, not hidden.
- Red-phase evidence (stubbed use case → 13 fail / 0 pass at the unit layer; route reverted →
  10 fail / 1 pass at the HTTP layer, with the one pass explained) supports that the new tests
  exercise real behavior rather than tautologies.

### Minor / non-blocking observations

- No test in this diff specifically exercises a malformed (non-UUID) `:tierId` on the PATCH
  route, but `uuidParam`/`validateParams` is pre-existing, shared middleware already covered by
  `apps/api/src/http/validate.test.ts` — not a gap specific to this task's own coverage
  obligation.
- Everything else reviewed (price validation, ownership, deactivate/subscription independence,
  reserved-handle guard, dashboard isolation, Bahasa/English message boundary) checks out with
  no reservations.

## Verification method

- Read `payment-account.ts`, the full diff, both new test files, `bootstrap.ts`/`bootstrap.test.ts`
  diffs, `errors.ts` (status-code mapping), `user-tier-repository.port.ts`.
- Ran only covering files, not the full API suite:
  - `bun test src/application/use-cases/manage-user-tiers.test.ts` — 13 pass / 0 fail (baseline).
  - `bun test src/routes/users.test.ts -t "tiers"` — 11 pass / 0 fail.
  - `bun test src/routes/users.test.ts -t "every literal /users segment"` — 1 pass / 0 fail.
  - `bun test src/bootstrap.test.ts` — 163 pass / 0 fail.
- Two independent mutation checks (payout gate → truthiness; ownership check → dropped), each
  reverted immediately with `git checkout --`, `git status`/`git diff --stat` confirmed empty
  after each and at the end of the review.

Tree left exactly as found: `git status --short` clean, `git diff --stat` empty.
