# Contributing to DIUDARA

Everything below is something that cost somebody real debugging time. It is ordered so you
can follow it from a fresh clone to a working local stack, then a green test suite.

## The four workspaces

| Workspace | What it is | Needs a `.env`? |
| --- | --- | --- |
| `apps/api` | Hono HTTP API, Drizzle, all the use-cases | **Yes** — `apps/api/.env` is the only application `.env` in the repo |
| `apps/worker` | The outbox worker, plus Phase 5's renewal and churn passes | **No, deliberately** — it reads `apps/api/.env` |
| `apps/web` | React + Vite public checkout/confirmation pages | No |
| `packages/shared` | Zod schemas shared by API and web | No |

`infra/` holds the Postgres `docker-compose.yml` and needs its own `infra/.env` for the
container's credentials.

## First-time setup

```bash
bun install

cp infra/.env.example infra/.env          # then choose a real POSTGRES_PASSWORD
cp apps/api/.env.example apps/api/.env    # set the SAME password in DATABASE_URL

docker compose -f infra/docker-compose.yml up -d
cd apps/api && bun run db:migrate
```

Both `.env.example` files are heavily commented and are the authority on every variable;
this file only covers what the comments cannot tell you in advance.

Two things about `infra/.env` that catch people:

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` take effect **only on the first
  start**, when the data volume is initialised. Changing them later does nothing until you
  drop the volume: `docker compose -f infra/docker-compose.yml down -v` (destroys local
  data).
- Postgres is bound to `127.0.0.1` on purpose. `infra/` is also the VPS deploy path, and a
  `0.0.0.0` binding would put the database on the internet.

### Why `apps/worker` has no `.env`

It reads the same database and the same messaging tokens as the API, so a second copy of
those values would be a second thing to keep in sync. Bun auto-loads `.env` from the
**current working directory only**, and the worker runs from `apps/worker` — so it loads
`apps/api/.env` itself, before it imports anything, in `src/api-env.ts`. Real environment
variables always win over the file, which is what makes a container that injects its own
configuration work unchanged.

If you see `DATABASE_URL is not set and no value was found in …/apps/api/.env`, that is
this mechanism telling you the file is missing — not a bug in the worker.

### `apps/web` needs no configuration

`vite.config.ts` proxies `/c` and `/webhooks` to `http://localhost:3000`, so the pages
call the API on their own origin in dev exactly as they will in production. The API's
`APP_BASE_URL` (in `apps/api/.env`) is what points the other way — it builds the
`success_redirect_url` Xendit sends a payer back to, **and** the checkout link inside a
renewal reminder. Both processes resolve it, so leave it at `http://localhost:5173`
locally and set the real origin on a deployment.

## Running it

Three processes, in three terminals:

```bash
cd apps/api    && bun run dev          # http://localhost:3000
cd apps/worker && bun run src/main.ts  # NOT `bun run --filter @diudara/worker start`
cd apps/web    && bun run dev          # http://localhost:5173
```

### The worker must be running, or a payment appears to do nothing

This is the single most common local surprise. The API **never** issues a Telegram invite
and **never** sends a WhatsApp message on the checkout path. A settled payment writes a
`grant_access` row to the `outbox` table inside its own transaction and returns; the
**worker** is what claims that row and performs the send. Same for renewal reminders and
for the removal of a churned member.

So with no worker running: the invoice is paid, the subscription goes `active`, the
confirmation page says so — and nothing ever arrives. There is no error anywhere, because
nothing has failed yet. Check `select status, event_type, attempts, last_error from outbox`
if you are unsure; `pending` rows with `attempts = 0` mean nobody is polling.

The worker also runs Phase 5's two clock-driven passes:

- **renewals** — the reminder schedule (`pre_3d`, `due`, `overdue_1d`, `overdue_3d`,
  `overdue_7d`) and the `active` → `past_due` transition;
- **churn** — `past_due` past its stored `grace_ends_at` → `churned`, with a queued
  revocation. The grace period is **10 days** after the due date, deliberately not 7.

That last number is load-bearing and easy to "tidy" back into a bug. `overdue_7d` is the
final warning, and the grace period must exceed the last reminder offset by enough that
the warning is always claimable well before churn. When both were 7 the warning opened at
00:00 WIB on day 7 and the deadline fell at 07:00 WIB the same day — a seven-hour window
in which the two passes, which run on independent loops, raced. Measured: churn won both
times a lifecycle was walked in a real worker, so the member was revoked having received
`overdue_3d` as their last word. `GRACE_DAYS` in `apps/api/src/domain/renewal-schedule.ts`
has the full account, and `renewal-schedule.test.ts` asserts the *relationship* — the last
stage's offset against the deadline, with a minimum gap — so changing one number alone
fails rather than silently reintroducing the race.

They run hourly by default, not every 5 seconds like the outbox, and not daily. See
`DEFAULT_RENEWAL_INTERVAL_MS` in `apps/worker/src/scheduled-passes.ts` for the reasoning,
and set `WORKER_RENEWAL_INTERVAL_MS` (milliseconds) to something small when you want to
watch a lifecycle locally. Reminders are claimed once per `(subscription, stage)` by a
unique index, so running the pass more often does **not** send more messages.

### Start the worker as the process, not behind a wrapper

`bun run --filter @diudara/worker start` stays in the foreground as a **parent** process
and does not forward SIGTERM to the child. Signalling it kills only the parent; the worker
is reparented and keeps polling and claiming outbox rows until it is SIGKILLed, so its
graceful shutdown never runs and whatever it had claimed sits in `processing` for five
minutes until `reclaimStaleProcessing` picks it up. Run `bun run src/main.ts` from
`apps/worker` instead.

## Telegram

Three rules, each of which has already been learned the hard way.

### 1. `TELEGRAM_WEBHOOK_SECRET` must be hex, from `openssl rand -hex 32`

```bash
openssl rand -hex 32
```

**Not `openssl rand -base64 32`.** A base64 secret is rejected at boot with an
explanation, because Telegram's `setWebhook` accepts only `A-Z a-z 0-9 _ -` in
`secret_token` (1–256 characters) and base64 produces `+`, `/` and `=`. Without the boot
check, the value looks fine, the API starts, `setWebhook` fails with an opaque 400 — and
the endpoint then rejects every real delivery, which looks like a completely different
problem. It must also be at least 32 characters: this secret is the **only**
authentication on `POST /webhooks/telegram`, and a forged `chat_member` update writes an
attacker-chosen user id onto a membership — the very id `banChatMember` is later aimed at.

### 2. `setWebhook` must list `chat_member` in `allowed_updates`

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-host>/webhooks/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["chat_member"]'
```

Telegram does **not** send `chat_member` by default, and omitting it fails silently: the
webhook installs, returns `ok: true`, and no update ever arrives. That update is the only
thing that tells us a member's numeric Telegram user id — checkout only ever knew a
WhatsApp number — so without it `channel_membership.external_member_id` stays `NULL`
forever and a member who stops paying can never be removed.

Locally, `cloudflared tunnel --url http://localhost:3000` is enough of a public HTTPS URL
to install a webhook against.

### 3. A Telegram channel needs the **numeric** chat id

Connect a channel with `-1001234567890`, not `@kelasbudi` and not an invite URL. The
`@username` form is what you see in the Telegram client and it is the form everyone
reaches for — and it **works for the outbound half**: `createChatInviteLink` succeeds and
the member gets a working link. The inbound half is where it breaks. The `chat_member`
update carries `chat.id` as a number, and it must match the stored id for the join to be
attributed to that channel; `@kelasbudi` never equals `-1001234567890`, so the update is
dropped as `unknown_invite_link`, no user id is recorded, and every later revocation
reports `no_provider_member_id_recorded` — forever, in a log line that looks like ordinary
noise. `POST /communities/:communityId/channels` therefore rejects a non-numeric Telegram id at
connect time, while you can still go and find the right one (`getChat`, or any group-info
bot). WhatsApp ids (`120363…@g.us`) are unconstrained, because nothing inbound depends on
them.

## Running the test suite

```bash
bun run test        # every workspace
bun run typecheck   # every workspace
```

Both must be green before a commit. Postgres has to be up; only `apps/api`'s tests use it.
This is now machine-enforced — see Continuous integration below.

To run one workspace or one file:

```bash
cd apps/api && bun test
cd apps/api && bun test src/application/use-cases/process-renewals.test.ts
```

### Each run gets its own database

`resetDatabase()` truncates every table, and until Phase 5 every process pointed at the
same `diudara` database. That shared state cost three phases real time, so the test
preload (`apps/api/src/test-env-preload.ts`) now creates
`diudara_test_<ms>_<pid>_<rand>`, runs the generated migrations into it, points
`DATABASE_URL` at it for that process only, and drops it when the run finishes. You do
not have to do anything; one line at the start of a run tells you which database it got.

What this buys you, all of it measured on the commit that introduced it:

- **Two runs at once are safe.** Before: 168 failures in one and 191 in the other, out of
  894 tests, none of them a real defect. After: both green.
- **A running worker is safe.** It polls every 5 seconds and claims whatever outbox rows
  it finds, so it used to send the suite's rows out from under it — before: 7 failures
  with a worker on the same database; after: green with the same worker still running.
  You no longer have to stop the worker to run the tests.
- **A finished run leaves nothing behind.** Fixtures clean up in `beforeEach`, not
  `afterAll`, so a completed run used to leave rows in the development database — which is
  the recorded trigger for the migration hazard below.

Two things worth knowing:

- `DIUDARA_TEST_DB_ISOLATION=off` runs against `DATABASE_URL` as-is and keeps the rows,
  for when you want to inspect what a failing run left in its tables. That is the only
  thing per-run databases make harder.
- A run that is killed (Ctrl-C) cannot drop its database, so the next run collects any
  `diudara_test_*` database that is more than ten minutes old and has nobody connected to
  it. Nothing else is ever a candidate — `diudara` itself cannot match the name pattern.

If you see `resetDatabase() refused: this run has no database of its own`, the preload did
not run: check that the directory you ran `bun test` from has a `bunfig.toml` with a
`[test] preload` entry (there is one at the repo root and one in `apps/api`, because Bun
reads `bunfig.toml` from the working directory and does not search upwards). That guard
exists because the alternative is silently truncating your development database.

### Writing tests

- Add every new table to `resetDatabase()`'s delete list, respecting foreign keys.
- **Count things.** Assert the number of reminders sent, `activity_log` rows, outbox rows
  and provider calls — not just the final state. A five-credential leak once shipped past
  a test that asserted final state only.
- Pin concurrency deterministically. A bare `Promise.all` has produced a false pass three
  times in this project; force the interleaving (see `src/test-support/arrival-latch.ts`)
  or assert the emitted SQL.
- Never put an invite link, a phone number or bound SQL parameters in a log line. Use the
  helpers in `apps/api/src/application/log-safety.ts`; there are tests that check this.
- **A test must set every environment variable its assertion depends on.** Inheriting one
  from `apps/api/.env` instead makes the test pass only on a machine that has that
  file — the suite must pass with no `apps/api/.env` present at all. Check it the way CI
  runs it: `cd apps/api && DATABASE_URL=<your local Postgres URL> JWT_SECRET=<32+ chars>
  bun --no-env-file test`, with only those two variables set. `--no-env-file` is
  load-bearing — without it Bun re-loads `apps/api/.env` and the coupling you're checking
  for hides again. Three `bootstrap()` tests shipped exactly this bug before CI existed;
  nothing stops a fourth from re-acquiring it except this check.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs `bun run typecheck` then `bun run test`
on every push to `main` and on every pull request. A red run blocks the merge — Postgres
being up and both commands being green are no longer things you have to remember to check
yourself before committing; a machine now checks them for you, on every branch, not just
the one you're staring at.

The workflow brings up its own Postgres as a service container (matching
`infra/docker-compose.yml`), so the per-run-database mechanism described above applies
inside CI exactly as it does locally.

### The secrets boundary

CI's `DATABASE_URL` and `JWT_SECRET` are literals written directly into
`.github/workflows/ci.yml`, not repository secrets — deliberately, not by oversight.
Neither protects anything: the database in the job dies with the job, and the JWT secret
signs and verifies tokens that never leave that same run. Storing either as a repository
secret would imply they guard something, and they don't.

A credential that reaches a real external service — a Xendit key, a Telegram bot token, a
deploy key — **is** a repository secret, full stop. The next phase is deployment, and
whoever adds the first one of those should be reading this section, not reverse-engineering
the rule from `ci.yml`.

## Migrations

Drizzle, **generated only**:

```bash
cd apps/api
bun run db:generate   # after editing src/db/schema.ts
bun run db:migrate
```

- Never hand-write migration SQL, and **never edit a migration that has already been
  applied anywhere**. Drizzle records each applied file's hash in the
  `drizzle.__drizzle_migrations` **table**, so an edited file will not re-run and the
  change silently diverges from what the database actually has.
- Adding a `NOT NULL` column to a table that may hold rows takes **three** generated
  steps, not one: add it nullable, backfill, then tighten. `0003_romantic_rattler.sql`
  did it in one and therefore fails outright on a non-empty `community` table —
  `column "slug" of relation "community" contains null values`. A later migration cannot
  fix that, because migrations run in order and `0004` never executes.
- `apps/api/drizzle/README.md` has the full account of that hazard, including how to
  hand-repair a database that hits it, and why you must not edit `meta/_journal.json` to
  work around it.

Test runs can no longer cause it: a per-run database is empty by construction, which is
the state `0003` needs.

## Conventions

- **Ports and adapters.** Use-cases depend on interfaces in
  `apps/api/src/application/ports`; Drizzle and HTTP live in `infrastructure/` and
  `routes/`.
- **Time is injected**, never `Date.now()` inside a use-case — `ClockPort`. Renewal dates
  are interpreted in **Asia/Jakarta**, in one place (`domain/renewal-schedule.ts`).
- **Creator-scoped reads return 404, not 403**, so a stranger cannot confirm that a
  community exists.
- `NODE_ENV` is an **allowlist**: only exactly `development` or `test` may relax a guard.
  Anything else — including unset — refuses to start. That is why a box with no Xendit or
  messaging tokens fails loudly instead of quietly using fakes.
- **Member-facing strings are Indonesian.** This is an Indonesian product.


## Deployment requirement: Postgres logs secret values on constraint violations

Found during Phase 6's end-to-end gate, and it sits **underneath every layer this codebase
controls**.

When a unique constraint is violated, PostgreSQL emits a line like:

```
DETAIL:  Key (invite_link)=(https://t.me/+AbCdEf...) already exists.
DETAIL:  Key (whatsapp_number)=(+628110000001) already exists.
```

**Bound parameters do not protect you.** The accompanying `STATEMENT:` line correctly shows only
`$1, $2` — but the `DETAIL:` line is built from the *index tuple*, not the statement, so the real
value appears in the database's own log. The application's logs are clean; this is beneath them.

It fires unprovoked today: the test suite triggers it about five times per run, because several
phases deliberately let the database arbitrate uniqueness rather than pre-checking. That design is
correct and should not be changed to avoid this.

**Before any production deploy, pick one deliberately** — each has a real cost:

| Option | Cost |
|---|---|
| `log_error_verbosity = terse` | Loses `DETAIL`/`HINT` on *every* error, everywhere, which is a genuine debugging loss |
| Redact at the log-shipping layer | Keeps diagnostics, but only works if logs never leave the host unredacted |
| Restrict who can read the Postgres log | Simplest, but does not help if logs are aggregated |

Dropping the constraints is not viable (they are the idempotency mechanism), and hashing the
columns breaks revocation, which needs the literal invite link to match a join back.

This matters for Indonesia's UU PDP 27/2022: `whatsapp_number` is members' personal data, and an
invite link is a bearer credential for a paid group.
