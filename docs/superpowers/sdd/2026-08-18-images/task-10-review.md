# Task 10 review: the orphan sweep

**Verdicts**

1. Spec compliance (§8): ✅
2. Task quality: **Approved**, with two Important findings and one Minor observation (none blocking).

## What was checked and how

Read: `.superpowers/sdd/2026-08-18-images/task-10-brief.md`, spec §8 (`docs/superpowers/specs/2026-08-18-images-design.md`), the implementer report, and the full diff `81e6074..3b25304` (three files: `apps/worker/src/main.ts`, `apps/worker/src/scheduled-passes.ts`, `apps/worker/src/scheduled-passes.test.ts`; no `apps/api` file touched — confirmed with `git diff --stat 81e6074..3b25304 -- apps/api`, empty).

Ran `bun test` (apps/worker): 50 pass, 0 fail, matching the report's claimed count. Ran `bun run typecheck` (apps/worker): clean.

### Mutation 1 — delete ordering (objects before row)

Flipped `sweepOne`'s two calls (`deleteById` before `storage.remove`) and reran `bun test src/scheduled-passes.test.ts`. Result: exactly the two named tests the report claims redden did redden —
`"sweeps an unclaimed row past the window: the OBJECTS are removed before the ROW"` (event order `["delete:m1","remove:m1"]` vs expected `["remove:m1","delete:m1"]`) and `"does not abort the pass when one row's storage removal fails, and that row survives for retry"` (`b` now appears in `deletedIds`). 28 pass / 2 fail, matching the report's own transcript verbatim. Reverted with `git checkout --`; 50/50 green again.

### Mutation 2 — per-row error handling

Removed `sweepOne`'s try/catch entirely (bare awaits, `result.deleted += 1` unconditional, no catch/logError). Reran the suite: the injected `AggregateError` from `FakeOrphanMediaStorage.remove("b")`/`"x"`/`"y"` now propagates unhandled out of `execute()`, and exactly the two tests exercising that path fail — `"does not abort the pass when one row's storage removal fails..."` and `"does not loop forever when every row in a page fails"`. This confirms independently that a naive loop dies on the first bad row (would silently skip every later, older orphan forever, since the next pass re-hits the same row first) and that the current code's try/catch is load-bearing, not decorative. Reverted; tree confirmed clean (`git status --short` empty, `git diff --stat` empty).

### 24-hour window

`ORPHAN_SWEEP_WINDOW_MS` is asserted against the literal `24 * 60 * 60_000`, not compared to itself. The `SweepOrphanMedia` tests use `hoursAgo(h)` — a locally-defined literal-hours helper independent of the constant — with `hoursAgo(25)` (swept) and `hoursAgo(1)` (untouched); the "claimed, however old" test uses `hoursAgo(24*365)`. No test sits at the exact 24h edge (23:59:59 vs 24:00:01) in either this file or `drizzle-media.repository.test.ts` (which uses 48h-old vs freshly-created), but the brief only asked to confirm literals-not-constants, which holds. Noted as a Minor observation, not a defect — the strict `<` in both the fake and the real query (`lt(postMedia.createdAt, cutoff)`) agree, and neither is exercised at the literal boundary instant.

### Visibility of per-row failures

The failure line — `` `[media] media=${id} was NOT swept and is left in place for the next pass — storage removal failed: ${redactLinks(safeErrorSummary(err))}` `` — matches the voice `ProcessChurn` already uses for its own per-item warning (`` `[churn] subscription=${id} is churned but its access is NOT being revoked: ... — recorded in activity_log` `` in `apps/api/src/application/use-cases/process-churn.ts`): `[tag] subject=<id> is/was <state> — <reason>`. It goes through the same `redactLinks(safeErrorSummary(err))` sanitiser `formatPassFailure` uses, so a bucket error that happens to interpolate a URL doesn't leak one. Both are pinned by named tests (`errors` array assertions in `"does not abort the pass..."`).

### Wiring and patterns

`main.ts` follows the existing pattern exactly: dynamic imports staged after `loadApiEnv()`, `selectMediaStorage` called with the identical argument shape the API's own `bootstrap.ts` uses at its own call site (verified both call sites side by side), `createScheduledPassLoops` extended from two to three loops with matching `onError`/`log` wiring, `installShutdownSignals` and the final `Promise.all` extended to include `orphanSweepLoop`, docstrings updated in place ("THREE loops"→"FOUR loops" etc.) rather than left stale. `formatPassFailure`'s tag union correctly extended to include `"media"`. Query semantics cross-checked: the in-memory `FakeOrphanMediaRepository.listUnclaimedBefore` reimplements exactly `post_id is null AND created_at < cutoff`, oldest-first, sliced to limit — matching `DrizzleMediaRepository.listUnclaimedBefore`'s real query against `postMedia` and the partial index `post_media_unclaimed_idx` (`WHERE post_id is null`) in `apps/api/src/db/schema.ts`.

## Findings

- **Important — no DB-backed integration test glues `SweepOrphanMedia` to `DrizzleMediaRepository`.** `listUnclaimedBefore`'s real SQL is proven correct by Task 1's own repository test (`drizzle-media.repository.test.ts`), and `SweepOrphanMedia`'s orchestration (ordering, per-row failure isolation, no-progress guard) is proven correct against fakes — but nothing exercises the two composed together against a real database, unlike `ProcessRenewals`/`ProcessChurn`, which both have DB-backed tests over the whole pass (`process-renewals.test.ts`/`process-churn.test.ts`, `resetDatabase` + real repositories). TypeScript's structural typing and a clean `tsc --noEmit` catch a signature drift, but not a semantic one (e.g., a timezone/precision mismatch between the fake's `Date.getTime()` comparison and Postgres's `timestamp with time zone` comparison, or a future change to `clampLimit`/ordering that both sides silently drift on). Not a blocker — the brief named only worker-side files and the design (structural ports, fakes, no `apps/api` runtime import) is coherent and deliberate — but worth a follow-up test, most naturally added next to `drizzle-media.repository.test.ts` or as a new `apps/api`-side integration test wiring the real repository into `SweepOrphanMedia`.

- **Important-leaning-Minor — reusing `renewalIntervalMs` couples two cadences that don't have to move together.** Verified there is no correctness bug: the sweep's own `ORPHAN_SWEEP_WINDOW_MS` (24h) is what actually protects fresh uploads, and `PollLoop`'s failure isolation means changing the shared interval can't break another pass's correctness — only its *frequency*. The realistic risk is operational surprise: someone raises `WORKER_RENEWAL_INTERVAL_MS` to reduce renewal/churn query load without realizing they've also slowed the orphan sweep, in a codebase that otherwise gives each pass its own knob when the passes differ in nature. I would ship the implementer's choice — a fourth interval env var genuinely is a knob nobody has asked for yet, and the reasoning ("none of the three is latency-sensitive") is sound — but flag it as the one place in this task where "structurally identical" was chosen over "semantically independent," worth a one-line env var if it ever becomes a real complaint.

- **Minor — no test sits at the exact 24-hour boundary instant.** All window tests use clearly-past (25h, 30h, 48h, 47h) or clearly-fresh (1h) literals; none probes the strict-`<` edge itself (23h59m59s vs 24h00m01s) in either `scheduled-passes.test.ts` or the pre-existing `drizzle-media.repository.test.ts`. The brief's actual ask — literals, not the constant — is satisfied regardless.

## Judgement calls

1. **Reusing `renewalIntervalMs` instead of a new `WORKER_ORPHAN_SWEEP_INTERVAL_MS`.** Sound, ship it. The coupling is a configuration nicety, not a functional one — `PollLoop` already isolates failures per-pass, and the 24-hour window (not the poll interval) is what actually bounds correctness. A fourth env var would be unused surface area today. See the Important-leaning-Minor finding above for the one real cost (an operator changing renewal cadence unknowingly changes sweep cadence too) — acceptable, not worth a new knob yet.

2. **`SweepOrphanMedia` living entirely in `apps/worker`, tested only with fakes.** The placement itself is right: it has no domain logic (no WIB days, no grace periods), so forcing it into `apps/api` next to `ProcessRenewals`/`ProcessChurn` would be structure for its own sake. The test-only-with-fakes choice is more debatable — see the first Important finding. TypeScript compatibility plus the repository's own SQL-level test cover most of the risk, but the composed pair (`SweepOrphanMedia` + real `DrizzleMediaRepository` + real/fake storage) is untested as a unit, which `ProcessRenewals`/`ProcessChurn` do not share. I'd want one DB-backed integration test before treating this pass as fully proven, but it does not block this task's merge — the brief scoped this task to the worker-side files only, and the gap is additive follow-up work, not a defect in what was built.

## Hygiene

Both mutations reverted with `git checkout --`. `git status --short` and `git diff --stat` both empty after the review. No file outside `apps/worker/src/{main.ts,scheduled-passes.ts,scheduled-passes.test.ts}` was touched by the implementer or by this review.
