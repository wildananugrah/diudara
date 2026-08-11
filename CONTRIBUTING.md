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

## Live streaming (MediaMTX)

Task 6 brings up a real MediaMTX instance in `infra/docker-compose.yml`, running from
`infra/mediamtx.yml`. Like Postgres, it needs `apps/api/.env`'s four `MEDIAMTX_*`/
`STREAM_TOKEN_SECRET` variables (see `.env.example`) AND `infra/.env`'s own copy of
`MEDIAMTX_WEBHOOK_SECRET` — the two must match exactly, the same rule as
`POSTGRES_PASSWORD`/`DATABASE_URL` above.

```bash
cp infra/.env.example infra/.env               # if you haven't already; add MEDIAMTX_WEBHOOK_SECRET
# apps/api/.env: set MEDIAMTX_RTMP_HOST, MEDIAMTX_HLS_BASE_URL, MEDIAMTX_WEBHOOK_SECRET
# (same value as infra/.env), STREAM_TOKEN_SECRET (a DIFFERENT secret)
docker compose -f infra/docker-compose.yml up -d mediamtx
```

A creator publishes with OBS (or, to prove it locally, `ffmpeg`) to the `rtmpUrl` that
`POST /communities/:communityId/events` returns, and a member watches the `hlsPlaybackPath`
it also returns, with a `?token=<watch token>` query parameter. Every publish and every
read is authorised against `apps/api`'s `/webhooks/mediamtx/auth` — MediaMTX has no other
access-control mechanism, and without it a stream key is just "a path that's hard to
guess."

### The image must be the `-ffmpeg` tag, not the plain one — found running this for real

`bluenviron/mediamtx:<version>` (no suffix) is built `FROM scratch`: no shell, no `curl`,
nothing but the `mediamtx` binary. `runOnOnline`/`runOnOffline` in `mediamtx.yml` are shell
commands (there is no `runOnPublish`/`runOnUnpublish` — these are the real hook names), and
a `FROM scratch` container cannot run one at all. Pointed at the plain tag, MediaMTX logs
exactly this the moment a publish starts:

```
runOnOnline command exited: exec: "curl": executable file not found in $PATH
```

`docker-compose.yml` therefore uses `bluenviron/mediamtx:1.20.0-ffmpeg`, which is
Alpine-based and ships BusyBox — but Alpine does not install `curl` by default either, only
BusyBox's `wget`. `mediamtx.yml`'s hooks use `wget --header=... --post-data=...`, not the
`curl -H ... -d ...` an earlier draft of this spec assumed. Verified against a live
container: `wget` reaches `apps/api` and the hook fires correctly (see below).

### `authHTTPAddress` cannot send a header — the secret travels as a query parameter instead

MediaMTX's `authHTTPAddress` mechanism has no configuration option to attach a custom
header to the POST it makes (its entire surface is `authMethod`/`authHTTPAddress`/
`authHTTPExclude`/`authHTTPFingerprint`/`authInternalUsers`/`authJWT*` — verified against
mediamtx.org's authentication docs). A config that put the shared secret in that URL
directly would also put it in this repository's git history, since `infra/mediamtx.yml` is
committed — so `authHTTPAddress` is not set in that file at all. It is injected purely as
the `MTX_AUTHHTTPADDRESS` environment override (MediaMTX's own rule: any config key can be
overridden by `MTX_<UPPERCASE_KEY_NAME>`) in `docker-compose.yml`, built from
`infra/.env`'s `MEDIAMTX_WEBHOOK_SECRET` at container start — so the real value exists only
as a container environment variable, never as text in a committed file.
`apps/api/src/routes/mediamtx-webhooks.ts` accepts the secret either as that query
parameter OR as the `X-Mediamtx-Secret` header the `runOnOnline`/`runOnOffline` hooks send
— those genuinely are shell commands and can attach one, `authHTTPAddress` genuinely
cannot.

**This is also why `POST /webhooks/mediamtx/auth` must never be reachable from the public
nginx surface.** A query-string secret lands in access logs and sits in plain text as part
of a request URL — exposure a header does not have. MediaMTX reaches `apps/api` over the
container/host boundary (`host.docker.internal`), never through nginx, so publishing that
route publicly would only leak the secret for no functional gain. The nginx location block
below deliberately proxies `/live/` (MediaMTX's HLS output) and nothing under
`/webhooks/mediamtx/`.

### The port asymmetry is deliberate

- **RTMP `1935` is published publicly** (`"1935:1935"`) — a creator's OBS connects from
  outside this host, and publish authorisation (`authHTTPAddress`) is what protects it.
- **HLS `8888` is bound to `127.0.0.1` only** (`"127.0.0.1:8888:8888"`, the same pattern
  Postgres already uses above). Exposing it publicly would let anyone fetch segments
  directly, with no read authorisation at all — that authorisation is the *entire*
  mechanism deciding who gets to watch a paid stream.

### The nginx location block the real VPS needs

```nginx
location /live/ {
    proxy_pass http://127.0.0.1:8888;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

Nothing under `/webhooks/mediamtx/` is proxied here — see the security note above for why
that route stays off the public surface entirely.

### `host.docker.internal` needs an explicit mapping on Linux, not macOS

`docker-compose.yml`'s `mediamtx` service sets:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Docker Desktop on macOS (what local development uses) provides this hostname
automatically, so the line is a no-op here. The production VPS is Linux, where plain
`dockerd` does **not** provide it without `extra_hosts` — omitting this line would make
every `runOnOnline`/`runOnOffline` hook and every `authHTTPAddress` call fail to resolve
the API's host on that box specifically, while working the entire time in local
development, which is exactly the shape of bug that survives review.

### `$MTX_PATH`'s runtime shape, confirmed

`apps/api/src/application/use-cases/authorise-stream.ts`'s `streamKeyFromPath` and
`handle-stream-lifecycle.ts` both require `$MTX_PATH`/the auth webhook's `path` field to be
exactly `live/<key>`, reasoned from MediaMTX's docs ("MTX_PATH: path name") rather than a
running instance. Confirmed against a real publish: publishing to
`rtmp://localhost:1935/live/<key>` makes `$MTX_PATH` arrive as `live/<key>`, matching what
both use-cases assume, and the event correctly transitions `scheduled` → `live` → `ended`.
If a future MediaMTX version ever changes this, `handle-stream-lifecycle.ts` logs a
`console.warn` on the branch where parsing fails — watch for it, since the alternative is
every session silently staying `scheduled` forever with no error anywhere.

### A failing hook is not silent, but it is easy to miss — where to look

If `runOnOnline`/`runOnOffline` ever fail (wrong secret, `apps/api` unreachable, a
malformed URL after a future edit), MediaMTX does **not** treat it as an error and does
**not** retry — it just prints the failing command's own output as a plain log line, with
no `ERR`/`WAR` tag and nothing that greps for "error" would reliably catch. A wrong-secret
failure looks like this in `docker logs infra-mediamtx-1`:

```
wget: server returned error: HTTP/1.0 401 Unauthorized
```

No surrounding context, no indication of which hook or which stream it came from beyond
its position in the log relative to `runOnOnline command started`/`command exited` lines
just above it. If a session's `event.status` is stuck at `scheduled` after a real publish
started (MediaMTX itself says `stream is available and online`, but the database
disagrees), this — not `apps/api`'s own logs, which never see the request at all — is the
first place to look: `docker logs infra-mediamtx-1 | grep -A2 -B2 runOnOnline`.

## Running the test suite

```bash
bun run test        # every workspace
bun run typecheck   # every workspace
```

Both must be green before a commit. Postgres has to be up; only `apps/api`'s tests use it.
Nothing checks this for you — there is no CI, and a push to `main` deploys (see Deployment
below), so running these yourself is the only gate there is.

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

## Deployment

`.github/workflows/deploy.yml` runs on a **self-hosted** runner on the production VPS. It
triggers on a push to `main` and on manual dispatch, and its only job is to run
`scripts/deploy.sh` from the clone that already lives on that box. It does not check the
repository out — the script pulls, builds, migrates, publishes the web build, and reloads
pm2 itself.

**The trigger list is load-bearing, and this is the one thing not to get wrong.** This
repository is public, and a self-hosted runner executes whatever a workflow tells it to on
a real machine that serves real traffic. `push` to `main` and `workflow_dispatch` are safe
because a stranger can cause neither — a fork's pull request cannot push to `main`.
**Never add a `pull_request` trigger to this workflow.** Doing so would hand anyone who
opens a pull request a shell on the production server.

**There is no automated test gate.** CI was removed deliberately, so nothing verifies a
commit before it reaches production. A push to `main` deploys whether the tests pass or
not — which is why "Both must be green before a commit" above is a real obligation rather
than a formality.

### The secrets boundary

A credential that reaches a real external service — a Xendit key, a Telegram bot token, an
SSH or deploy key — **is** a repository secret, full stop. Nothing that reaches a real
service belongs in a workflow file, in a script, or in a committed `.env`.

`scripts/deploy.sh` deliberately never touches `infra/.env` or `apps/api/.env`. Those hold
the real secrets, they are placed on the box once by hand, and a redeploy must never
overwrite them.

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
