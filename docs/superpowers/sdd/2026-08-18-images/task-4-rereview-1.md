# Task 4 fix round 1 — scoped re-review

Re-reviewed commit `c7a9a0a` (on top of `1d8f771`, branch `feat/images`, worktree
`/home/wildandev/repo/diudara/.worktrees/images`), against
`.superpowers/sdd/2026-08-18-images/task-4-review.md`,
`.superpowers/sdd/2026-08-18-images/task-4-report.md` (fix round 1 section), and
`.superpowers/sdd/2026-08-18-images/review-1d8f771..c7a9a0a.diff`.

Scope: this diff only. 70 lines added, 1 removed, in
`apps/api/src/application/use-cases/upload-media.test.ts`. No other file changed.

## Finding 1 (Important) — bytes-before-row ordering: ADDRESSED

New test: `UploadMedia > inserts no row when the storage write fails — pins bytes-before-row`.

**Independent mutation verification.** Swapped `media.create` to run before the two `storage.put`
calls in `upload-media.ts` (kept the same `id` and same fields, only the order moved), then ran:

```
bun test src/application/use-cases/upload-media.test.ts src/routes/media.test.ts
```

Result: **8 pass, 1 fail** — matches the implementer's reported 4 pass / 1 fail for the use-case
file alone (route file's 4 tests are unaffected, giving 8/9 combined here). The one failure is the
named test above:

```
Expected length: 0
Received length: 1
(fail) UploadMedia > inserts no row when the storage write fails — pins bytes-before-row
```

Restored via `git checkout -- src/application/use-cases/upload-media.ts`; reran — back to 9 pass,
0 fail.

**Quality judgment.**

- *Fails for the right reason.* The failure is `rows` having length 1, i.e. the test found the
  orphaned `postMedia` row directly via a DB query keyed on `owner.id` — not an indirect symptom of
  storage failure propagating differently. This is exactly the failure mode the ordering exists to
  prevent (a media id that 404s forever), pinned precisely.
- *No network reached.* `FailingStorage` is a hand-written class that `implements MediaStoragePort`
  in the test file itself; its `put()` unconditionally throws. It is never `S3MediaStorageAdapter`.
  Confirmed by inspection (no `fetch`/`S3`/URL literals anywhere in the new test code — the one
  string match for "S3" is a docblock comment naming the adapter it deliberately isn't).
- The test also implicitly re-confirms `rejects.toThrow("simulated storage failure")` propagates
  unswallowed, which is a reasonable adjacent assertion, not padding.

Verdict: **ADDRESSED**, and the pinning test is sound.

## Finding 2 (Minor) — byteSize's meaning: ADDRESSED

New test: `UploadMedia > pins byteSize to the re-encoded full variant's size, not the original
upload's`.

**Independent mutation verification.** Changed `byteSize: processed.full.byteLength` to
`byteSize: input.bytes.byteLength` in `upload-media.ts`, reran the same two files:

Result: **8 pass, 1 fail**, the failure being the named test above:

```
Expected: 3490
Received: 26036
```

Restored via `git checkout --`; reran — back to 9 pass, 0 fail.

**The actual byte figures the assertion depends on:** fixture `photo-with-gps.jpg` is **26036
bytes** as uploaded, and re-encodes to **3490 bytes** for the `full` WebP variant — roughly 7.5×
smaller. These are not close and not equal, so the assertion cannot pass vacuously; a regression to
`input.bytes.byteLength` fails hard and visibly (26036 vs. 3490 is not a plausible off-by-something
match). This is the opposite of the "no EXIF in an EXIF-stripping test" trap the brief warned about
— the fixture's two sizes are verifiably, substantially different, and my mutation run reproduced
those exact numbers independently.

The test asserts two things: `row.byteSize === stored.bytes.byteLength` (must equal what's actually
in the bucket) and `row.byteSize !== original.byteLength` (must not equal what came in). Both are
meaningful; neither is redundant with the other.

Verdict: **ADDRESSED**, and the byte figures make the assertion non-vacuous.

## Also checked

- **No production code changed in this diff.** `git diff 1d8f771..c7a9a0a --stat` shows exactly one
  file, `upload-media.test.ts` (70 insertions, 1 deletion). `upload-media.ts` was last touched in
  `1d8f771` (the original commit), not in this fix round. Confirmed clean — test-only, as claimed.
- **New tests reach no network.** Both new tests use in-memory fakes (`FailingStorage`,
  `FakeMediaStorageAdapter`) and a real Postgres test DB via `DrizzleMediaRepository(db)` (same
  pattern as the pre-existing tests in this file) — no HTTP/S3 calls anywhere.
- **Literal-value assertions, not re-imported constants.** The new tests assert
  `toHaveLength(0)`, `toThrow("simulated storage failure")` (a literal string owned by the test's
  own `FailingStorage`, not a production constant), and numeric/byte-length comparisons — none of
  them re-import a production constant and compare it to itself.
- **Report's corrected figure.** Confirmed both places in `task-4-report.md` now say **4**, not 7:
  line 54 ("I ran that file and it is still 4/4 green") and line 136
  ("`drizzle-media.repository.test.ts`: 4/4 pass, unchanged (corrected in fix round 1 below; a
  prior version of this report wrongly said 7/7)"), plus the explicit correction note at line 237.

## New breakage

None found. No regressions, no new gaps introduced by this diff.

## Method notes

Ran only `src/application/use-cases/upload-media.test.ts` and `src/routes/media.test.ts` per
scope — did not run the full `apps/api` suite. Two mutations applied and reverted via
`git checkout --`; `git status --short` confirmed clean (empty output) after each revert and at the
end of the session. Baseline and post-revert runs both showed 9 pass / 0 fail across the two files.

## Overall verdict

Both findings from the original review — 1 Important (bytes-before-row ordering) and 1 Minor
(byteSize's meaning) — are **ADDRESSED** by commit `c7a9a0a`, confirmed independently by mutation.
The third (report-accuracy) finding is also corrected in both places it appeared. No new issues
found. Tree left clean.
