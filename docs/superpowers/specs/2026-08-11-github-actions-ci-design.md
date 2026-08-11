# GitHub Actions CI — Design Spec

Date: 2026-08-11
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phases 1-7 (merged: `d0904b8`, `565d43a`, `c78ad11`, `e722276`, `8f3acff`, `ca9c04f`,
`d96dc17`)

## 1. Purpose

The repository went public on 2026-08-11 (`github.com/wildananugrah/diudara`). Seven phases have
been gated by two commands run by hand — `bun run test` and `bun run typecheck` — and nothing
enforces them on a push or a pull request.

This adds that enforcement. It is deliberately small: the gates already exist and are trusted, so
CI's job is to run them, not to invent new ones.

## 2. What the suite actually needs, measured

Established by running each workspace with `bun --no-env-file` and no `apps/api/.env` present —
the state a fresh clone and a CI runner are both in:

| Workspace | Result with `DATABASE_URL` only |
|---|---|
| `packages/shared` | 70 pass, 0 fail |
| `apps/worker` | 38 pass, 0 fail |
| `apps/web` | 155 pass, 0 fail |
| `apps/api` | 1041 pass, **219 fail** |

Every one of the 219 was the same error: `JWT_SECRET is not set`. Supplying it leaves **3**
failures, addressed in §5.

So CI needs exactly two environment values and a real PostgreSQL 16 server. Nothing else.

**A real server, not a mock.** `src/test-env-preload.ts` creates a database per run
(`diudara_test_<ms>_<pid>_<rand>`), migrates it with the generated Drizzle migrations, points
`DATABASE_URL` at it, and drops it in an `afterAll`. That requires `create database` permission
and access to the `postgres` maintenance database, both of which a service container's superuser
has. It also means CI inherits Phase 5's isolation for free: concurrent jobs cannot collide.

## 3. The workflow

One file, `.github/workflows/ci.yml`, one job.

- **Triggers:** `push` to `main`, and `pull_request`. Nothing else — no schedule, no manual
  dispatch, until there is a reason.
- **Runner:** `ubuntu-latest`.
- **Service:** `postgres:16-alpine`, matching `infra/docker-compose.yml`, with a `pg_isready`
  health check so the suite never starts against a server that is still booting.
- **Steps:** checkout → set up Bun **pinned to 1.3.11** → `bun install --frozen-lockfile` →
  `bun run typecheck` → `bun run test`.
- **Concurrency:** one group per ref, cancelling superseded runs.

`--frozen-lockfile` is deliberate: it makes CI fail on lockfile drift rather than silently
resolving something different from what a developer has.

Typecheck runs **before** tests. It is the faster of the two and its failures are unambiguous, so
a broken type surfaces in seconds rather than after the suite.

## 4. Neither environment value is a GitHub secret

`DATABASE_URL` points at the service container on `localhost` — it is not reachable from anywhere
else and its credentials die with the job.

`JWT_SECRET` is a literal written in the workflow file. It signs tokens that are created and
verified entirely inside one test run. **Storing it as a repository secret would imply it protects
something, and it does not** — the misleading signal is the cost, and a reader who believes CI
holds a real key is worse off than one who can see it does not.

It must still satisfy the app's own guard: at least 32 characters, and not the `.env.example`
placeholder, both of which `bootstrap()` rejects.

**This is the boundary to hold.** The moment CI needs a credential that reaches a real external
service — a Xendit test key, a Telegram bot token, a deploy key — that value is a repository
secret, never a literal. Nothing in this spec's scope needs one.

## 5. Three tests depend on a file a clean checkout does not have

With `DATABASE_URL` and `JWT_SECRET` supplied, three `bootstrap.test.ts` cases still fail:

- `XENDIT_CALLBACK_TOKEN guard > refuses to boot a production process with no callback token`
- `messaging provider selection > refuses to boot a production process with no messaging tokens`
- `AI provider wiring > boots with the co-builder disabled even when AI_DAILY_MESSAGE_LIMIT is
  garbage`

Each asserts that `bootstrap()` throws a particular message under production settings, but sets
only *some* of the variables the boot sequence reads and inherits the rest from whatever
`apps/api/.env` holds. Without that file a different guard fires first, so the expected message
never appears.

**This is a real defect in the tests, not a CI problem.** It reproduces for any contributor
cloning the repository, and it means the assertions have been passing partly because of ambient
state rather than because of the guard under test. CI is simply the first thing to expose it.

**The fix is to make each of the three set every variable its assertion depends on**, so it passes
against an empty environment. Test files only; no production code changes. Rejected alternative:
having the workflow write an `apps/api/.env` from `.env.example` — that would make CI green while
preserving the hidden coupling, which is the failure mode this project has repeatedly paid for
(a guard that is correct but whose trigger is never established).

## 6. Deliberately out of scope

- **Dependency caching.** `bun install` on this repository measures 433 ms. A cache step would add
  configuration and a staleness failure mode to save under a second. Add it when install time
  justifies it.
- **A production build check** (`bun run build` for `apps/web`). Worth having, and it belongs with
  the deployment phase that will define what a production build even targets.
- **Deployment.** CI here verifies; it does not ship. Deployment is Phase 8's subject and needs
  real secrets, which §4 keeps out of this workflow.
- **Coverage reporting, matrix builds across Bun or Postgres versions, linting.** No linter is
  configured in this repository; adding one is its own decision.

## 7. How this is verified

CI cannot be proven correct locally — the only honest test is a run on GitHub. So:

1. The workflow is pushed on a branch and a pull request is opened, so the `pull_request` trigger
   fires on the change that introduces it.
2. The run must be **green**, with the API suite reporting its full count — a workflow that passes
   because it silently ran no tests is the failure mode to watch for. The step output must show
   all four workspaces and their counts.
3. One deliberate failure is then confirmed: a commit that breaks a type, pushed to the same
   branch, must turn the run red at the typecheck step. A gate never seen to fail is not known to
   be a gate.
4. That commit is reverted before merge.
