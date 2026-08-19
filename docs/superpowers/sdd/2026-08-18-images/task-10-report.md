# Task 10 report: the orphan sweep

**Commit:** `3b25304` — `feat(worker): the orphan sweep (Task 10)`

## What was built

A third scheduled `PollLoop`, `SweepOrphanMedia`, added entirely inside
`apps/worker/src/scheduled-passes.ts` and wired into
`apps/worker/src/main.ts`. It collects `post_media` rows abandoned with
`post_id = null` for more than 24 hours (spec §8) — either a composer that
was never finished, or an image an edit dropped back to unclaimed.

### Where the class lives, and why

`ProcessRenewals`/`ProcessChurn` live in `apps/api` because they carry real
domain logic (WIB calendar days, grace deadlines). `SweepOrphanMedia` has
none of that — just a cutoff and a try/catch — and the brief's file list
named only `apps/worker/src/scheduled-passes.ts` and `main.ts`, so I kept it
there, against narrow structural interfaces (`OrphanMediaRepository`,
`OrphanMediaStorage`) rather than the full `MediaRepositoryPort`/
`MediaStoragePort`. `DrizzleMediaRepository` and the real/fake storage
adapters satisfy those structurally without any adapter code — confirmed by
`tsc --noEmit` passing with `new SweepOrphanMedia(new
DrizzleMediaRepository(db), mediaStorage)` in `main.ts`.

`main.ts` wires it by dynamically importing three more things from
`apps/api` (all *after* `loadApiEnv()`, same rule as the existing
`bootstrapWorker()` import): `db` from `db/client`, `DrizzleMediaRepository`,
and `selectMediaStorage` from `bootstrap.ts`. `selectMediaStorage` is reused
rather than re-derived — it's the same selector `POST /users/media` and the
delivery routes already use, so the worker and the API can never disagree
about which bucket (or in-memory fake) an upload actually lives in, and it
inherits the existing block-boot guard (refuses to start rather than boot a
worker that silently sweeps nothing forever). I did not touch any
`apps/api` file — `selectMediaStorage` was already exported and safe to
import (its module has no top-level env reads; `bootstrap.ts`'s own
guard-throwing all happens inside function bodies, so importing it alone
doesn't require `JWT_SECRET`/Xendit keys the way calling `bootstrap()`
would).

The sweep runs on the same hourly `renewalIntervalMs` as churn/renewals — no
new env var — since the 24-hour window is generous by design and the sweep
is no more latency-sensitive than those two.

## Red phase

After adding all test code (imports of `formatOrphanSweepLine`,
`ORPHAN_SWEEP_WINDOW_MS`, `SweepOrphanMedia`, plus `NOTHING_HAPPENED_SWEEP`,
the `SweepOrphanMedia` describe block, `formatOrphanSweepLine` describe
block, a `formatPassFailure` media-tag test, and the `processOrphanSweep`
plumbing into the three existing `createScheduledPassLoops` tests) against
the *unmodified* `scheduled-passes.ts`:

```
$ bun test src/scheduled-passes.test.ts
SyntaxError: Export named 'formatOrphanSweepLine' not found in module
'.../apps/worker/src/scheduled-passes.ts'.
 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [41.00ms]
```

Red for the intended reason: the module fails to load because the new
exports don't exist yet, not a stray typo. After implementing
`scheduled-passes.ts` and `main.ts`, the same file: 30/30 pass.

## The delete-ordering pin

Two tests pin objects-before-row:

1. `"sweeps an unclaimed row past the window: the OBJECTS are removed before
   the ROW"` — wraps both fakes to record an `events: string[]` array and
   asserts `events === ["remove:m1", "delete:m1"]`.
2. `"does not abort the pass when one row's storage removal fails, and that
   row survives for retry"` — asserts the failed row's id is **not** in
   `media.deletedIds`, i.e. `deleteById` was never called for it.

I verified both catch a flipped order directly (not just by inspection):
committed first, then edited `sweepOne` to call `deleteById` before
`storage.remove`, reran `bun test src/scheduled-passes.test.ts`, and got
exactly the two expected failures —

```
- Expected  - 1                              (first test)
+ Received  + 1
  [ "remove:m1", "delete:m1" ]  →  [ "delete:m1", "remove:m1" ]

@@ -2,3 +2,3 @@                              (second test)
    "a",
+   "b",     <- the failed row's id now shows up as deleted
    "c",
28 pass, 2 fail
```

then reverted with `git checkout -- apps/worker/src/scheduled-passes.ts` and
confirmed 50/50 green again before writing this report.

## One bad row does not abort the pass

`SweepOrphanMedia.execute()` pages through `listUnclaimedBefore` and calls a
private `sweepOne(id, result)` for each row, wrapped in its own try/catch.
A failure there increments `result.failed`, calls an injectable `logError`
(default `console.error`) with a line naming the failed media id, and lets
the loop continue to the next row — the row itself is left unclaimed for the
next pass to retry (proven by the deleteById-never-called assertion above).

A guard against a subtler failure mode: since a *failed* row does not leave
`listUnclaimedBefore`'s result set (only a *deleted* row does), a page where
every row fails would otherwise be re-fetched identically forever. I added a
no-progress break (`if (result.deleted === deletedBefore) break;`) and pinned
it with `"does not loop forever when every row in a page fails"` —
`batchSize: 2` with exactly 2 failing rows, so without the guard the
`page.length < batchSize` exit would never fire either and the pass would
hang.

## The log line

Pass summary (silent when `considered/deleted/failed` are all zero, same
convention as `formatRenewalPassLine`/`formatChurnPassLine`):

```
[media] considered=5 deleted=3 failed=2
```

Per-row failure (always emitted, immediately, distinct from the pass
summary):

```
[media] media=<id> was NOT swept and is left in place for the next pass —
storage removal failed: <redacted reason>
```

Both go through `redactLinks(safeErrorSummary(err))`, the same sanitiser
`formatPassFailure` already uses, so a bucket error that happens to
interpolate a URL doesn't leak one. A whole-pass failure (e.g.
`listUnclaimedBefore`'s query itself throwing — distinct from a per-row
storage failure, which never escapes `execute()`) goes through
`formatPassFailure("media", err)` → `[media] pass failed: ...`, extending its
existing tag union (`"outbox" | "renewals" | "churn"` → `+ "media"`).

## Test counts

- Before: worker suite **38 pass** (confirmed via `git show 81e6074:.../scheduled-passes.test.ts | grep -c "it("` = 18 tests in that file pre-task, vs. 50 total tests currently in the worker suite). After: **50 pass, 0 fail** across the worker's 3 test files.
- `scheduled-passes.test.ts` alone: 18 → 30 tests (12 added), 56 `expect()` calls, 0 fail.
- `tsc --noEmit` (worker workspace): clean, no errors.
- No `apps/api` files were touched, so I did not run the (slow, ~215 s) api
  suite — nothing there could have regressed.

## Self-review notes

- `git status` is clean; only the three brief-listed files changed
  (`main.ts`, `scheduled-passes.ts`, `scheduled-passes.test.ts`).
- Consolidated the `db/client` dynamic import in `main.ts` to one line
  (`const { db, sql } = await import(...)`) instead of importing the module
  twice for two different exports, removing the old separate import at the
  bottom of the file.
- Updated `main.ts`'s and `scheduled-passes.ts`'s own docstrings (loop
  counts, "THREE loops" → four in main.ts counting the outbox, "TWO loops" →
  "THREE loops" in `createScheduledPassLoops`'s docstring) rather than
  leaving stale prose next to new code.

## What I'm unsure about

- **Cadence choice.** I reused the existing hourly `renewalIntervalMs` for
  the sweep rather than adding a fourth env var
  (`WORKER_ORPHAN_SWEEP_INTERVAL_MS`). The brief's "same shape for interval
  resolution" line could be read either way; I judged a shared interval more
  consistent with "none of these three is latency-sensitive" than inventing
  a knob nobody asked for, but flag it in case a reviewer wanted a dedicated
  resolver.
- **Batch size (500, matching `ProcessRenewals`/`ProcessChurn`) and the
  `logError` injection point** are my own design choices, not specified in
  the brief or spec — reasonable by analogy to the existing passes, but
  worth a second look.
- I did not add an integration test against the real `DrizzleMediaRepository`
  + a real/fake `MediaStoragePort` adapter (e.g. `S3MediaStorageAdapter`'s
  actual `AggregateError` shape) — `SweepOrphanMedia`'s tests use local fakes
  only, since it's implemented in the worker workspace and the file's own
  documented policy is to avoid runtime imports from `apps/api` beyond
  `log-safety`. `drizzle-media.repository.test.ts` already pins
  `listUnclaimedBefore`'s SQL-level cutoff/claim behavior against a real DB,
  and `s3-media-storage.adapter.ts`'s own test presumably pins the
  `AggregateError` shape — I did not re-run or re-verify that file since it
  wasn't part of this task's diff.
