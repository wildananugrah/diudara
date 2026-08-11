# GitHub Actions CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push to `main` and every pull request runs `bun run typecheck` and `bun run test`
against a real PostgreSQL 16, and the gate is proven to fail as well as pass.

**Architecture:** One workflow file, one job, a `postgres:16-alpine` service container. The suite
already creates and drops its own per-run database, so CI supplies only a server and two
environment values. Three tests that silently depend on `apps/api/.env` are made
environment-independent first, so the workflow is green for a stated reason rather than an
ambient one.

**Tech Stack:** GitHub Actions, Bun 1.3.11, PostgreSQL 16, Drizzle migrations.

## Global Constraints

From `docs/superpowers/specs/2026-08-11-github-actions-ci-design.md`.

- **Bun is pinned to `1.3.11`.** Not `latest` — an unpinned runtime turns an upstream release
  into a red build on an unrelated commit.
- **Postgres is `postgres:16-alpine`**, matching `infra/docker-compose.yml`.
- **CI supplies exactly two environment values: `DATABASE_URL` and `JWT_SECRET`.** Measured: with
  these two and no `.env`, the suite is green once Task 1 lands.
- **Neither value is a GitHub secret.** Both are literals in the workflow. They protect nothing —
  the database dies with the job, and the JWT secret signs only tokens created and verified inside
  the same run. A secret would imply otherwise. The moment CI needs a credential reaching a real
  external service, that one *is* a secret.
- **`JWT_SECRET` must be at least 32 characters and must not be the `.env.example` placeholder** —
  `bootstrap()` rejects both.
- **Triggers are `push` to `main` and `pull_request`.** No schedule, no manual dispatch.
- **Typecheck runs before tests** — it is faster and its failures are unambiguous.
- **`bun install --frozen-lockfile`**, so lockfile drift fails the build.
- **No dependency caching.** `bun install` measures 433 ms on this repository.
- The root gates are `bun run test` and `bun run typecheck` — **never bare `bun test`**, which from
  the repo root produces ~123 spurious failures because `apps/web` needs its own bunfig preload.

---

### Task 1: Make the three bootstrap tests environment-independent

**Files:**
- Modify: `apps/api/src/bootstrap.test.ts`

**Interfaces:**
- Produces: nothing other tasks import. Task 2's workflow depends on this task's outcome — a suite
  that passes with only `DATABASE_URL` and `JWT_SECRET` set.

**The defect.** Three tests set `NODE_ENV: "production"` and some provider variables inside
`withEnv`, then assert `bootstrap()` throws a particular message. They never set `APP_BASE_URL`,
so they inherit it from `apps/api/.env`. Without that file — a fresh clone, or a CI runner —
`bootstrap()`'s `APP_BASE_URL` guard fires first with a different message, and the assertion
misses. Measured: supplying `APP_BASE_URL` alone takes `bootstrap.test.ts` from 3 failures to
111 pass / 0 fail.

The three:
- `bootstrap() XENDIT_CALLBACK_TOKEN guard > refuses to boot a production process with no callback token` (~line 1331)
- `bootstrap() messaging provider selection > refuses to boot a production process with no messaging tokens` (~line 1375)
- `bootstrap() AI provider wiring > boots with the co-builder disabled even when AI_DAILY_MESSAGE_LIMIT is garbage — absent/irrelevant AI config must never block boot` (~line 2069)

- [ ] **Step 1: Reproduce the failure the way CI will see it**

```bash
cd apps/api
DB="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
DATABASE_URL="$DB" JWT_SECRET="ci_only_jwt_secret_at_least_32_characters_long" \
  bun --no-env-file test src/bootstrap.test.ts 2>&1 | grep -E "^\(fail\)|^ *[0-9]+ (pass|fail)"
```

`--no-env-file` is load-bearing: without it Bun re-loads `apps/api/.env` and the failure vanishes.
This exact trap has produced a false negative in this project before.

Expected: the three named tests fail, `108 pass / 3 fail`.

- [ ] **Step 2: Add `APP_BASE_URL` to every `withEnv` block in those three tests**

Use the value the tests have been inheriting, so behaviour is identical to today:

```ts
APP_BASE_URL: "http://localhost:5173",
```

For example, in the messaging test the block becomes:

```ts
withEnv(
  {
    NODE_ENV: "production",
    APP_BASE_URL: "http://localhost:5173",
    XENDIT_SECRET_KEY: "sk_live_x",
    XENDIT_SPLIT_RULE_ID: "splitrule_1",
    XENDIT_CALLBACK_TOKEN: REAL_CALLBACK_TOKEN,
    TELEGRAM_BOT_TOKEN: undefined,
    FONNTE_API_TOKEN: undefined,
  },
  () => {
    captureConsoleLog(() => {
      expect(() => bootstrap()).toThrow(/TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN/);
    });
  }
);
```

Apply the same addition to **each** `withEnv` block inside all three tests, including the
second block of the callback-token test (the one asserting `/NODE_ENV is production/`) and the
fully-configured block in the AI test. A block that does not call `bootstrap()` needs nothing.

Add a comment above one of them recording why it is there, so nobody deletes it as noise:

```ts
// APP_BASE_URL is set explicitly, not inherited. These assertions are about a
// specific guard; without it, bootstrap()'s APP_BASE_URL guard throws FIRST and
// the expected message never appears. That made these tests pass only on a
// machine with apps/api/.env — a fresh clone and CI both fail without this.
```

- [ ] **Step 3: Verify the three now pass with no ambient environment**

```bash
DATABASE_URL="$DB" JWT_SECRET="ci_only_jwt_secret_at_least_32_characters_long" \
  bun --no-env-file test src/bootstrap.test.ts 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
```

Expected: `111 pass`, `0 fail`.

- [ ] **Step 4: Verify the whole suite is green under CI conditions**

```bash
cd /Users/bellinnn/Documents/projects/diudara
DB="$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2-)"
for w in packages/shared apps/worker apps/web apps/api; do
  printf '%-16s ' "$w"
  (cd "$w" && DATABASE_URL="$DB" JWT_SECRET="ci_only_jwt_secret_at_least_32_characters_long" \
    bun --no-env-file test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' ')
  echo
done
```

Expected: `70/0`, `38/0`, `155/0`, `1260/0`. If `apps/api` reports anything other than 0 fail,
stop — a fourth hidden environment dependency exists and the workflow in Task 2 would be red.

- [ ] **Step 5: Confirm the normal developer path still works**

```bash
bun run test && bun run typecheck
```

Expected: 1523 pass / 0 fail, typecheck exit 0 across four workspaces.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/bootstrap.test.ts
git commit -m "test(bootstrap): stop three guard tests inheriting APP_BASE_URL from .env"
```

---

### Task 2: The workflow, proven to pass and to fail

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1's outcome — a suite that is green with only `DATABASE_URL` and `JWT_SECRET`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# A second push to the same ref makes the first run irrelevant. Cancel it
# rather than paying for both.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      # Matches infra/docker-compose.yml. The suite creates a database per run
      # (diudara_test_<ms>_<pid>_<rand>), migrates it with the generated Drizzle
      # migrations and drops it afterwards, so it needs `create database`
      # permission and the `postgres` maintenance database — both of which this
      # container's superuser has.
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: diudara
          POSTGRES_PASSWORD: ci_postgres_password
          POSTGRES_DB: diudara
        ports:
          - 5432:5432
        # Without this the suite can start against a server still booting.
        options: >-
          --health-cmd "pg_isready -U diudara -d diudara"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgres://diudara:ci_postgres_password@localhost:5432/diudara
      # Deliberately a literal, not a repository secret. It signs tokens that are
      # created and verified inside this run and nowhere else, and the database
      # above dies with the job. Storing either as a secret would imply they
      # protect something. A credential that reaches a real external service —
      # a Xendit key, a bot token, a deploy key — IS a secret. These are not.
      # Must be >= 32 chars and must not be .env.example's placeholder;
      # bootstrap() rejects both.
      JWT_SECRET: ci_only_jwt_secret_at_least_32_characters_long

    steps:
      - uses: actions/checkout@v4

      # Pinned, not `latest`: an unpinned runtime turns an upstream Bun release
      # into a red build on a commit that changed nothing.
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.11

      # --frozen-lockfile so drift fails the build instead of resolving
      # something different from what a developer has.
      - run: bun install --frozen-lockfile

      # Before the tests: faster, and its failures are unambiguous.
      - run: bun run typecheck

      # `bun run test`, never bare `bun test` — the root command runs each
      # workspace's suite from its own directory, which is the only way
      # apps/web's bunfig preload (happy-dom) applies.
      - run: bun run test
```

- [ ] **Step 2: Push on a branch and open a pull request**

The `pull_request` trigger must fire on the change that introduces it — a workflow merged straight
to `main` has never been observed running against a PR.

```bash
git checkout -b ci/github-actions
git add .github/workflows/ci.yml
git commit -m "ci: run typecheck and tests on push and pull request"
git push -u origin ci/github-actions
```

Then open the pull request against `main` at the URL GitHub prints.

- [ ] **Step 3: Confirm the run is green AND that it really ran the tests**

Open the run's `bun run test` step output. It must show all four workspaces with their counts:
`70`, `38`, `155`, `1260`.

A workflow that passes because it silently ran nothing is the failure mode to watch for. If any
workspace is missing from the output, the run is not green — it is empty.

- [ ] **Step 4: Prove the gate can fail**

A gate never seen to fail is not known to be a gate. Break a type deliberately:

```bash
printf '\nconst ciProof: number = "not a number";\n' >> apps/api/src/bootstrap.ts
git add apps/api/src/bootstrap.ts
git commit -m "ci: temporary type error, proving the gate fails"
git push
```

Expected: the run turns **red at the `bun run typecheck` step**, and the `bun run test` step does
not run. If it goes green, the workflow is not gating anything — stop and fix it before merging.

- [ ] **Step 5: Revert the deliberate break**

```bash
git revert --no-edit HEAD
git push
```

Expected: the run returns to green. Confirm before merging.

- [ ] **Step 6: Merge the pull request**

Merge to `main` once green. The `push` trigger then runs once more on `main` itself; confirm that
run is green too, since it is the first exercise of the `push` trigger as opposed to
`pull_request`.

---

## Verification checklist

- [ ] `bun run test` and `bun run typecheck` green locally.
- [ ] The suite is green with **only** `DATABASE_URL` and `JWT_SECRET` set and no `apps/api/.env`.
- [ ] A pull-request run is green, with all four workspace counts visible in the step output.
- [ ] A deliberate type error turns the run red at the typecheck step.
- [ ] Reverting it returns the run to green.
- [ ] The `push` trigger runs green on `main` after the merge.
