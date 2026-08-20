# Task 1 fix round 1 re-review: `listActiveByOwner`'s owner-scoping test

Reviewed `a8bf3d4` against `0db6afb` (diff:
`review-0db6afb..a8bf3d4.diff`, 15 insertions / 1 deletion, single file:
`drizzle-user-tier.repository.test.ts`). Verified by mutation myself,
independent of the report's claims.

## Verdict: I1 — ADDRESSED

**Mutation, run directly against the working tree:** removed the `ownerId`
half of the `where(...)` clause in `listActiveByOwner`
(`drizzle-user-tier.repository.ts`), leaving only
`eq(userTiers.isActive, true)`. Ran:

```
bun test src/infrastructure/repositories/drizzle-user-tier.repository.test.ts
```

Result: **6 pass / 1 fail**. The single named test that reddens is
`DrizzleUserTierRepository > excludes deactivated tiers from
listActiveByOwner, and other owners' tiers too`, failing on the new
assertion at line 109 (`expect(rows.map((r) => r.id)).toEqual([active.id])`)
with the other owner's tier id (`80f88de3-...`) appearing in `received`
where it shouldn't. This matches the report's transcript exactly (same test
name, same 6/1 split, same shape of `toEqual` diff — only the UUIDs differ
run to run, as expected).

Restored with `git checkout -- apps/api/src/infrastructure/repositories/drizzle-user-tier.repository.ts`, re-ran the same command: **7 pass / 0 fail**. `git status --porcelain` clean before and after.

The finding is addressed: the mutation that previously slipped through
(deleting the `ownerId` filter, per the original review) is now caught.

## Fix is not narrower than the finding

- **Second owner's tiers are active, not merely present.** In the fixed
  test, `other`'s single tier ("Not mine") is created via `repo.create(...)`
  with no follow-up `repo.deactivate(...)` call — `isActive` defaults to
  `true` at the schema level (`is_active` boolean default `true`). So the
  second owner is excluded from the result purely by the `ownerId` filter,
  not by the `is_active` filter also happening to exclude them. Confirmed
  this is exactly why the mutation reddens: with only the `ownerId` clause
  removed and `isActive = true` still applied, the other owner's active tier
  passes the remaining filter and leaks into the result.
- **Assertion checks contents, not length.** The test asserts
  `expect(rows.map((r) => r.id)).toEqual([active.id])` — an ordered list of
  specific ids, not `rows.length`. A length-only assertion (`toHaveLength(1)`)
  would have passed under the mutation too (both owners have exactly one
  active tier each), giving a false sense of coverage. The actual assertion
  used forces the *identity* of the surviving row to match, which is what
  catches the leak.
- Test count is unchanged (7 → 7): the existing test was strengthened in
  place rather than a new test being bolted on, consistent with what the
  report describes and with the finding calling for the *same* test to
  actually prove scoping.

## Other checks

- **No production code changed.** `git diff --stat 0db6afb..a8bf3d4` touches
  exactly one file, the test file, 15 insertions / 1 deletion. Confirmed
  directly, not just from the diff summary in the review package.
- **Literal assertions.** The new/changed assertions
  (`expect(rows.map((r) => r.id)).toEqual([active.id])`) compare against
  locally-created row references (`active.id`), not against the constants
  under test — consistent with the rest of the file's style.
- **No new breakage.** Ran only the covering file (per instructions, not
  the full `apps/api` suite): 7 pass / 0 fail, 14 `expect()` calls, in
  2.04–2.10s across the two clean runs bracketing the mutation. No other
  files in this diff.

## Tree hygiene

`git status --porcelain` empty at the end of this re-review; the one
mutation applied was reverted with `git checkout --` and confirmed by a
second clean test run before restoring.
