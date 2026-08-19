# Task 2 re-review — fix round 2 (`414f1d2..6166217`)

Scope: `.superpowers/sdd/2026-08-18-images/review-414f1d2..6166217.diff` only — one new file,
`apps/api/src/infrastructure/storage/s3-media-storage.adapter.test.ts` (123 lines), no production
change. Sets the bar per `task-2-rereview-1.md`: I1 and I2 were both correct in production code but
**NOT ADDRESSED** because no committed test regressed when either fix was reverted. Round 2's entire
job is to close that gap.

Method: mutation, not reading. For each finding, reverted the production code to its pre-fix (buggy)
state, ran the covering tests, confirmed a *named* test goes red, then `git checkout --` the file and
confirmed `git status`/`git diff --stat` empty before moving to the next mutation. Covering set:
`src/infrastructure/storage/*.test.ts` and `src/bootstrap.test.ts` only, per instructions (not the
full 215s api suite). Baseline (unmutated, current HEAD): **162 pass / 0 fail** across 3 files.

## I1 — `remove()`'s real-failure guard

**Verdict: ADDRESSED.**

Mutation: replaced the `Promise.allSettled`/`AggregateError` block in `remove()` with the old
`Promise.all([...delete().catch(() => {})...])`. Re-ran the covering set:

```
161 pass
1 fail
(fail) S3MediaStorageAdapter.remove() (I1: a real delete failure must not be swallowed) >
  throws when a variant's delete genuinely fails [8.41ms]
Expected promise that rejects
Received promise that resolved: Promise { <resolved> }
```

Exactly one named test goes red, and it names the finding in its own `describe`/`it` text. Reverted;
`git status`/`git diff --stat` confirmed empty before the next mutation.

The sibling test ("still resolves — without throwing — when both variants delete cleanly, matching
the port's idempotency promise") stayed green under this same mutation, as expected — the mutation
only changes behavior on a genuine failure, and this test doesn't manufacture one. That's correct
mutation isolation, not a gap.

## I2 — `refuseUnderTest` network guard

**Verdict: ADDRESSED.**

Mutation: changed the guard's condition from `if (process.env.DIUDARA_BUN_TEST_RUN)` to
`if (false && process.env.DIUDARA_BUN_TEST_RUN)` (a no-op neuter — the guard body becomes
unreachable). Re-ran the covering set:

```
161 pass
1 fail
(fail) S3MediaStorageAdapter (I2: put/get/remove must refuse to run under a test process) >
  throws before touching the network, for all three methods [3.73ms]
Expected pattern: /called while running under `bun test`/
Received message: "an unexpected error has occurred"
```

One named test goes red. Notably it fails in 3.73ms with a connection-refused-shaped error, not a
timeout or DNS hang — confirming the test's own claim in its comment: with the guard neutered, the
call falls through to a real (but instantly-failing, since nothing listens on
`http://127.0.0.1:1`) connection attempt, producing a *different* error than the guard's own message,
so the test goes red for the right reason rather than passing by accident. No real network egress
occurred in either direction — reverted; `git status`/`git diff --stat` confirmed empty afterward.

## Also checked

- **Observable behaviour vs. mock call counts (I1):** both I1 tests assert on `remove()`'s promise
  outcome (`.rejects.toThrow(/failed to delete 1 of 2/)` and `.resolves.toBeUndefined()`), not on
  whether a mock was called or how many times. `grep -n "toHaveBeenCalled\|spyOn\|toBeCalled"` over the
  new file returns nothing — no call-count assertion exists anywhere in it. This satisfies the
  previous round's explicit instruction.
- **Absent-object half of I1's contract:** covered, though indirectly by construction rather than by a
  dedicated "missing key" test. The fake client's `delete()` throws only when an outcome is explicitly
  set to an `Error`; when unset it resolves silently. Per the production comment, S3 DELETE is
  idempotent by protocol — a delete against a key that never existed and a delete against a key that
  existed and got deleted return the same success at the `S3File.delete()` boundary this test doubles.
  So "both variants delete cleanly" *is* the absent-object case at this abstraction level; there's no
  narrower claim to test separately without reaching into Bun's real S3 wire protocol, which the file's
  own docstring correctly declines to do. Adequate.
- **Real network calls:** none. I1's tests substitute `adapter.client` with an in-memory double before
  ever calling `remove()`, so no `S3Client` method is exercised. I2's test uses a real,
  un-substituted adapter, but the guard fires synchronously before any `this.client.*` call in the
  unmutated code — confirmed both by reading (`refuseUnderTest` is line 1 of every method body) and by
  the mutation result above, which is the only place `S3Client` gets asked to do anything, and even
  then it's a doomed local connection to `127.0.0.1:1`, not a live host.
- **Credentials:** none real or realistic. Every config object in the file uses literal `"test"` for
  `accessKeyId`/`secretAccessKey`/`bucket`/`region` and `http://127.0.0.1:1` for `endpoint` (a loopback
  address with nothing listening — not even a real local service). `grep` for secret-shaped strings
  (`secretAccessKey.*=.*[A-Za-z0-9+/]{16,}`) finds only the two `"test"` literals.

## New breakage in the fix diff

None. This diff is test-only (`123 insertions(+)`, zero production lines) — `git diff --stat` on the
full range confirms only `s3-media-storage.adapter.test.ts` changed. No new dependency, no modified
production file, no change to `test-env-preload.ts` or the adapter itself. The `withoutI2Guard` helper
correctly restores `DIUDARA_BUN_TEST_RUN` in a `finally` block (checked: `if (original !== undefined)
process.env.DIUDARA_BUN_TEST_RUN = original`), so I1's tests don't leak env-var state into later tests
in the same process — confirmed empirically too, since the full 162-test run (which runs
`bootstrap.test.ts`'s own `DIUDARA_BUN_TEST_RUN`-sensitive blocks after this file alphabetically... 
actually before, `bootstrap.test.ts` sorts before `infrastructure/`) stayed green in both the baseline
and post-revert runs.

## Bottom line

Both I1 and I2 are now pinned by name-identifiable, behavior-asserting tests that go red under direct
mutation of the exact code path each finding was about, and stay green on the actual committed diff
(162/162 across all three runs: baseline, post-I1-revert, post-I2-revert). No mock-call-count
laundering, no real network call, no planted credentials, no production regression. Working tree
confirmed clean (`git status --short` and `git diff --stat` both empty) after every mutation and at
the end of this review.
