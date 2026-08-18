# Resuming Phase 3 (posts and a feed) elsewhere

Phase 3 is **mid-flight**. Tasks 1-6 are complete and reviewed; **Tasks 7 and 8 are not started**,
and the whole-branch review has not run. This branch was merged to `main` early, at the user's
request, so that work could continue on another machine.

## What is done

| Task | Commit | State |
|---|---|---|
| 1 — `post` table + repository | `265c499`, `0c69083` | complete, reviewed, fix round applied |
| 2 — use cases, shared limit, routes | `97e4d77`, `53fb863` | complete, reviewed, fix round applied |
| 3 — relative time + `PostCard` | `6bf02f2` | complete, reviewed, **approved with no fix round** |
| 4 — `PostFeed` + pagination | `3121443`, `8a5568f` | complete, reviewed, fix round applied |
| 5 — Beranda's tabs, compose/edit/delete | `f8e7ad4`, `0592db2` | complete, reviewed, fix round applied |
| 6 — posts on the profile | `8749868` | **built, NOT yet reviewed** |

**2781 pass / 0 fail** (shared 82, worker 38, web 625, api 2036), typecheck clean in all four
workspaces.

## What remains

1. **Review Task 6.** It is the only task that has had no review. Its report is in this directory,
   and it self-discloses one deliberate gap: the `Edit` button on a profile's own posts **renders but
   is unwired** — tapping it does nothing. That was a scope judgement, and it is the first thing a
   reviewer should rule on.
2. **Task 7 — repair the split session.** See the plan.
3. **Task 8 — the gate.** Nothing in this phase has been run in a real browser.
4. **The whole-branch review**, then a fix round.

The plan is `docs/superpowers/plans/2026-08-18-posts-and-feed.md`; the spec is
`docs/superpowers/specs/2026-08-18-posts-and-feed-design.md`. `progress.md` in this directory is the
ledger — every ruling, every parked finding, every defect and why it was or was not fixed.

## Running it on another machine

- `bun install` at the repo root.
- Postgres reachable, and `apps/api/.env` present — it is **gitignored**, so it does not travel with
  the repo. Copy it across or recreate it.
- `bun run db:migrate` from `apps/api` if the database is fresh. The newest migration is
  `0022_violet_lila_cheney.sql` (the `post` table).
- Gates are **`bun run test`** and **`bun run typecheck`** from the repo root. **Never bare
  `bun test`** — it yields ~123 spurious failures, because `apps/web` needs its own `bunfig.toml`
  preload and Bun reads `bunfig.toml` from CWD only.

## Two things that will waste your time if you do not know them

**The `apps/api` flake family.** About a dozen tests fail under CPU contention — all of them compare
a Bun-side clock against Postgres's `now()`. They are `apps/api` only and clear on a re-run, so a
failure in `apps/web` is real until proven otherwise. Task 6's implementer lost time to a variant of
this: an **orphaned `bun test` process** left running from an earlier session produced 197 failures
across files it had never touched, including `dashboard/` files. If a run looks catastrophically
broken, check for stray `bun test` processes before believing it.

**Reviews on this project find results by mutation, not by reading.** Every genuine finding on this
branch came from breaking the code and checking whether a test noticed. A green suite has repeatedly
proved nothing here: two database indexes could be deleted outright with the API workspace green, a
projection was pinned on one of three select sites, and two documented guarantees of `PostFeedHandle`
were each broken by a one-line change while all 618 web tests passed.
