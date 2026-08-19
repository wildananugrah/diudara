# Task 2 re-review — fix round 1 (`c2fa86f..414f1d2`)

Scope: `.superpowers/sdd/2026-08-18-images/review-c2fa86f..414f1d2.diff` only (2 files:
`s3-media-storage.adapter.ts`, `test-env-preload.ts`). The rest of Task 2 already passed and is not
re-litigated here.

Method: read the diff, then verified both fixes by mutation against the **committed** suite (not by
reading alone), reverting every mutation before moving to the next and confirming a clean tree at the
end. Targeted run used for speed (`src/infrastructure/storage/`, `src/bootstrap.test.ts`,
`src/routes/payment-account.test.ts`, `src/routes/communities.test.ts`,
`src/routes/public-community.test.ts` — the only test files that construct or reference
`S3MediaStorageAdapter`/`mediaStorage`, confirmed by `grep -rln "S3MediaStorageAdapter\|s3-media-storage\|mediaStorage" src/ --include="*.test.ts"`, which returns only `bootstrap.test.ts`). Baseline for
this targeted set: **211 pass / 0 fail** (matches the report's own "Tests run" section for fix round 1).

## I1 — `remove()`'s `.catch(() => {})` swallowed real failures

**Verdict: NOT ADDRESSED** (production code is correct; the fix is unpinned).

The production fix itself is right: `Promise.allSettled` on both variant deletes, then an
`AggregateError` thrown when any variant rejects, with the "absent object is not an error" case
resting on S3 DELETE's protocol-level idempotency (correct — a delete against a missing key returns
204, not an error, so there was never anything for the old catch to legitimately protect).

But nothing in the committed suite exercises this path. Mutation: reverted `remove()` to the old
`Promise.all([...delete().catch(() => {})...])` (i.e., un-fixed I1) and ran the targeted 5-file suite:

```
211 pass
0 fail
```

Zero red tests. `grep -rn "AggregateError" src/ --include="*.test.ts"` also returns nothing — no test
anywhere asserts `remove()` throws, catches an `AggregateError`, or even calls `remove()` on a real
`S3MediaStorageAdapter` (impossible under `bun test` now anyway, since I2's guard fires first — see
below, which is itself part of why this can't be pinned without a `refuseUnderTest`-bypass test
double). The report's own text confirms this was never meant to be permanent evidence: *"Verified
both fixes work with a throwaway, uncommitted test file (`/tmp/verify-i1-i2.test.ts`, deleted after
use)"*. That throwaway no longer exists. There is no named test in the committed suite that would go
red if this regressed tomorrow — for example, if someone "simplified" the `Promise.allSettled` block
back to `Promise.all(...).catch(() => {})` during a refactor, the full suite would stay green.

Mutation reverted; `git status` on the file confirmed clean before moving on.

## I2 — production-simulating test blocks constructed a live S3 adapter

**Verdict: NOT ADDRESSED** (production code is correct and the mechanism is sound; the fix is unpinned).

The guard design itself is good and I checked it for the specific false-comfort traps called out:

- **Not env-var luck**: `DIUDARA_BUN_TEST_RUN` is set unconditionally in `test-env-preload.ts` *before*
  the `.env`-file-loading loop, and that loop only sets a key `if (!(key in process.env))` — so even a
  developer's local `apps/api/.env` containing `DIUDARA_BUN_TEST_RUN=0` could not unset it (the key
  already exists). `grep -rn "DIUDARA_BUN_TEST_RUN" src/ --include="*.test.ts"` returns nothing — no
  test file reads, deletes, or overrides that name, including the various `withEnv` helpers (checked
  `bootstrap.test.ts`'s `withEnv`, which only touches keys explicitly passed to it).
- **Reaches Task 4's actual code path**: the guard sits inside `put`/`get`/`remove` themselves — the
  exact three methods a media route would call — not on construction, so it isn't gated behind a
  condition Task 4's route handlers would sidestep.

So the mechanism does what it claims. But mutation-testing whether the committed suite would *catch*
a regression in it: neutered the guard (`if (false && process.env.DIUDARA_BUN_TEST_RUN)`) and ran the
same targeted 5-file suite:

```
211 pass
0 fail
```

Zero red tests. This is expected and, by itself, not alarming — today nothing calls `put`/`get`/
`remove` on a real adapter, so a guard that never fires and a guard that's disabled look identical
*to today's suite*. The problem is what that implies: there is no named test anywhere in the
committed suite that proves the guard fires when it should. The report's own text says the same thing
for this finding as for I1 — verified once via the same now-deleted throwaway file, nothing committed.

A one-line permanent test would close this (something like: construct an `S3MediaStorageAdapter` with
placeholder config under normal `bun test` conditions — i.e., without touching
`DIUDARA_BUN_TEST_RUN` — and assert `put`/`get`/`remove` each throw synchronously with a message
naming the guard). No such test exists in the diff or the wider suite.

Mutation reverted; `git status` on the file confirmed clean before moving on.

## New breakage in the fix diff

None found. Both files' non-test-pinning-related content checked out:

- No network call added (`refuseUnderTest` throws synchronously before `S3Client` is touched;
  confirmed by reading — the throw happens before any `this.client.*` call in all three methods).
- No real credential in either file.
- No AWS SDK, no new dependency (`git diff --stat` on `package.json`/`bun.lock` — not in this diff at
  all).
- `DIUDARA_BUN_TEST_RUN` placement in `test-env-preload.ts` is correct relative to the `.env`-loading
  loop (set first, loop can't override an existing key) — this is a positive finding, not breakage.
- Full targeted suite (the 5 files that could plausibly reference this code) is 211/211 green on the
  actual (unmutated) diff, matching the report's claimed count.
- Comments document WHY (the I2 docstring explains the constructor-vs-method-guard tradeoff
  explicitly; the I1 comment explains why the old catch was never protecting what it claimed to).

The one thing I did **not** re-run is the full 2065-test suite (it takes ~215s per run and three
mutation passes would have tripled that); the targeted 5-file set is exhaustive for anything that
could reference this adapter, confirmed by the grep above, so I judged the full run unnecessary for
verifying these two findings specifically. This does not change either verdict.

## Bottom line

Both I1 and I2 got the right production fix. Neither got a permanent, named, reachable assertion in
the committed suite pinning the new behavior — both were checked once against a throwaway test file
that was deleted before commit, which is why the api suite's pass count did not move (2065 before,
2065 after) despite two behavioral changes landing. Per the standing instruction, an unpinned guard is
NOT ADDRESSED regardless of whether the underlying code is correct — and for both findings here, the
underlying code is correct.
