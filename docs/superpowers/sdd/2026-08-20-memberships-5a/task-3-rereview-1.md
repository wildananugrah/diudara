# Task 3 fix round 1 — scoped re-review

**Range reviewed:** `619fa4d..730a53b` (`apps/api` changes only; the `4f0fa69` plan-doc
correction commit is out of scope and ignored per instructions).
**Method:** mutation, reproduced independently in this worktree and reverted.
`git status` is clean.

## Verdicts

- **F1 (Important — race test could not fail against a check-then-act claim): ADDRESSED.**
- **F2 (Minor — `creatorId` carries an `app_user` id, undocumented): ADDRESSED.**

---

## F1 — verified by mutation

Applied the forbidden shape to `beginXenditAccountProvisioning` in
`apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.ts`: a `SELECT`
of the column, bail if non-null, then an **unconditional** `UPDATE … WHERE id = ?` (no
`isNull` predicate).

**At the committed latch of 30**, ran the race test 3 times with the mutant applied:

```
run 1: Expected length: 1 / Received length: 30   (fail)
run 2: Expected length: 1 / Received length: 30   (fail)
run 3: Expected length: 1 / Received length: 28   (fail)
```

All three runs fail loudly — the test now catches the mutant it exists to catch. (My
winner counts were 30/30/28 rather than a uniform 30/30/30; this is consistent with the
implementer's report of "30 out of 30" as the typical case — the arbitration point is
sample-size-driven, not deterministic to the third decimal, and every run here still
fails by a wide margin, which is what matters.)

**Then, keeping the same mutant applied**, temporarily dropped the latch back to 4
(`contenders = 4`) and ran the isolated test 5 times:

```
run 1: 1 pass / 0 fail
run 2: 1 pass / 0 fail
run 3: 1 pass / 0 fail
run 4: 1 pass / 0 fail
run 5: 1 pass / 0 fail
```

**5 runs, 5 false passes** — winners == 1 every time, matching the original review's
measurement (`n=4, wins=1`, indistinguishable from correct). This confirms the blind
spot was real at latch 4 and that 30 is load-bearing, not decorative.

Restored both files with `git checkout --`:

```
apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.ts
apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.test.ts
```

Re-ran the full covering file at baseline: **14 pass / 0 fail** (clean, un-mutated).

**Documentation check:** the test's docstring (lines ~109-129) explicitly states "THIRTY
CONTENDERS, NOT FOUR, and the number is load-bearing — review round 1, F1", recounts the
1-in-4 vs 27-in-30 measurement, and ends "do not lower this number." A future tidy-up has
something concrete to read before reverting it.

---

## F2 — verified by diff and by structural-typing check

`git show --stat 730a53b` and per-file diffs confirm the fix touches exactly:

- `apps/api/src/application/ports/payment-provider.port.ts` — extracts
  `CreatePaymentAccountInput` with the docstring described in the task brief: names the
  field as the owner's id (`creator.id` or `app_user.id`), explains the name is
  historical, states it is inert at Xendit but **not unused** (`FakePaymentAdapter`
  interpolates it into `fake-acct-N-<id>`, which lands in a real column), and warns never
  to join it to `creator`. Confirmed all four claims are present verbatim.
- `apps/api/src/application/use-cases/connect-user-payout.ts` — comment-only change at
  the call site, retargeting the explanation to point at the new type. No functional
  change; `creatorId: user.id` unchanged.
- `apps/api/src/infrastructure/repositories/drizzle-user-payout.repository.test.ts` —
  the F1 fix (unrelated to F2).

Confirmed **no diff** in `create-payment-account.ts`, `xendit-payment.adapter.ts`, or
`fake-payment.adapter.ts` between `619fa4d` and `730a53b` (`git diff` on each is empty) —
these were correctly left untouched, consistent with structural typing meaning the
literal-shaped adapter parameters still satisfy the extracted interface.

The field name itself, `creatorId`, is unchanged everywhere — not renamed, as required
(a rename would have forced edits into the frozen adapters/creator flow).

---

## Also checked

- **No new breakage.** Ran the fix round's own covering-file list (8 files):
  `connect-user-payout.test.ts`, `drizzle-user-payout.repository.test.ts`,
  `routes/users.test.ts`, `create-payment-account.test.ts`,
  `fake-payment.adapter.test.ts`, `xendit-payment.adapter.test.ts`,
  `payment-account.test.ts`, `bootstrap.test.ts` → **340 pass / 0 fail**, matching the
  implementer's reported count. Did not run the full api suite (per instruction).
- **`/dashboard/*` and its tables untouched.** `git diff --name-only 619fa4d..730a53b`
  touches exactly 3 files, all in `apps/api/src/application/`, none under
  `routes/dashboard*`, `creator*`, or any dashboard-read table/schema file. The only
  string match for "dashboard" in the whole diff is a docstring sentence noting that
  `/dashboard/*` reads are frozen — not a code change.
- **Tests assert literal values, not constants.** `SENTINEL = "provisioning:in-progress"`
  in the repository test file is a hardcoded string literal, not imported from
  `XENDIT_ACCOUNT_PROVISIONING`; all three uses in the file compare against the literal.

---

## Tree state

Every mutation (`beginXenditAccountProvisioning` rewrite, latch drop to 4) was reverted
with `git checkout --`. `git status --short` is empty. Nothing was force-added to
`.superpowers/`.
