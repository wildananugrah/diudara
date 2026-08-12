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

**A THIRD copy, as of Task 9 — final whole-branch review, Important.**
`infra/nginx/live-hls.conf.template` also carries `${MEDIAMTX_WEBHOOK_SECRET}` (rendered
via `envsubst` at deploy time, never committed as plaintext), because nginx's own
`auth_request` subrequest has to authenticate to `apps/api` the same way MediaMTX's
`runOnOnline`/`runOnOffline` hooks do. **If this third copy ever drifts from the other
two, the failure is silent and total**: `/webhooks/mediamtx/auth-request` returns `401`,
nginx's `auth_request` treats a `401` as an ordinary access denial — not an error, nothing
logged beyond the routine deny — and **every single viewer** sees "Tautan sudah tidak
berlaku" (`WatchPage.tsx`'s generic-refusal message), indistinguishable from an expired
token. There is no alarm, no distinct error page, nothing in `apps/api`'s own logs (the
request never reaches a route handler that would log anything — the secret check in
`mediamtx-webhooks.ts` throws before that). If every viewer suddenly can't watch anything
at once, and the creator says their broadcast is definitely running, this three-way secret
mismatch is the first thing to check — see `infra/.env.example`'s own note.

```bash
cp infra/.env.example infra/.env               # if you haven't already; add MEDIAMTX_WEBHOOK_SECRET
# apps/api/.env: set MEDIAMTX_RTMP_HOST, MEDIAMTX_HLS_BASE_URL, MEDIAMTX_WEBHOOK_SECRET
# (same value as infra/.env), STREAM_TOKEN_SECRET (a DIFFERENT secret)
docker compose -f infra/docker-compose.yml up -d mediamtx
```

A creator publishes with OBS (or, to prove it locally, `ffmpeg`) to the `rtmpUrl` that
`POST /communities/:communityId/events` returns. Every publish and every read is
authorised against `apps/api`'s `/webhooks/mediamtx/auth` — MediaMTX has no other
access-control mechanism, and without it a stream key is just "a path that's hard to
guess."

**A member never sees `rtmpUrl` or the stream key at all — final whole-branch review
fix.** An earlier version of this feature had `POST .../events`'s `hlsPlaybackPath`
(built from the SAME stream key that authorises a publish) go straight to the member's
browser via `GET /c/watch/:token`, which meant every paying member's network tab, browser
history, and any link they forwarded carried the creator's publish credential — directly
contradicting `EventRepositoryPort`'s own docstring on `streamKey` ("A SECRET. It travels
to the creator who owns the community and nobody else."). Fixed by decoupling the two
identities: MediaMTX's INTERNAL path is still `live/<streamKey>` (RTMP publishing is
completely unaffected), but the PUBLIC HLS path a member's browser ever requests is now
`/live/<eventId>/...` — an opaque row id, not a credential — and nginx (see below) rewrites
one onto the other after re-authorising. `AuthoriseStream` grew a second read entry point
(`authoriseReadByEventId`, resolving via the existing unscoped `findById` lookup) alongside
the original stream-key-based one MediaMTX's own `authHTTPAddress` still uses; the two
never share which identifier is legitimate for the other's purpose.

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

### The nginx location block the real VPS needs — now with `auth_request` (Task 9)

**MediaMTX's own HLS read-authorisation is per-VIEWER-SESSION, not per-request — confirmed
empirically, not assumed.** `authHTTPAddress` is called once, on the first request for a
stream; MediaMTX then mints an internal session identifier — returned as `hlsSession`/
`cookieCheck` cookies for cookie-capable clients, AND rewritten directly into every
sub-manifest URI as a `?session=` query parameter for clients that never send cookies at
all (confirmed with a real browser: `hls.js`'s default, credential-less cross-origin XHR
loader never sends a `Cookie` header, over hundreds of real requests) — and every
subsequent request carrying that identifier is let through **without calling
`authHTTPAddress` again**. A member who churns mid-stream keeps receiving segments in an
already-open tab for as long as that MediaMTX-internal session lives, which for a real
broadcast is the rest of it — directly contradicting design spec §5.2 and
`authorise-stream.ts`'s own docstring. See `task-9-report.md` for the full empirical trace
(including how the finding was obtained: a raw-socket test proving portability across
connections, then a real Chromium/`hls.js` session with request-header interception).

**The fix**: nginx's `auth_request` directive, re-authorising **every single proxied HLS
request** — the master playlist, every sub-playlist reload, every init segment, every media
segment, every LL-HLS part — against `apps/api` fresh, regardless of what MediaMTX itself
would have cached. `auth_request` has no caching of its own.

**The actual config is `infra/nginx/live-hls.conf.template` — that file is the single source,
not duplicated here.** An earlier version of this section inlined a full second copy of the
same two `location` blocks; the two copies diverged within the same task (one had
`access_log off`, the other briefly didn't) purely because there were two places to remember
to edit. Read the comments in that file directly rather than trusting a paraphrase here — they
carry the same empirical findings (the `$arg_token`-is-empty-in-subrequests bug, the
error-log token exposure, the trailing-slash regex bug, all found running this for real) at
the point in the config they apply to. In short:

- It is **three `location` blocks, not a standalone `server`** — meant to be pasted (or,
  after rendering `${MEDIAMTX_WEBHOOK_SECRET}`, `include`d) inside the real public HTTPS
  server block that already serves this app's SPA and API paths, not a second listener on a
  second port. (An earlier version of the template WAS its own `server { listen 8443; }` —
  that was this task's own local Docker-based proof harness, committed as if it were the
  deployable artifact. Fixed.)
- Both `proxy_pass` targets are `127.0.0.1`, matching the documented deployment: nginx and
  `apps/api` both run directly on the VPS host (there is no `api` service in
  `infra/docker-compose.yml` to containerise it), and MediaMTX's HLS port is mapped to the
  *host's* loopback by that same compose file, not to a container-network address.
- `${MEDIAMTX_WEBHOOK_SECRET}` is a literal placeholder, meant for whatever secrets-injection
  mechanism the real deploy uses — plain `envsubst 'MEDIAMTX_WEBHOOK_SECRET'` is enough for
  this bare-VPS nginx. (The template's header comment also records what a *containerised*
  nginx would need instead — `host.docker.internal`'s resolved address in place of
  `127.0.0.1` for both upstreams, plus `NGINX_ENVSUBST_FILTER=MEDIAMTX_WEBHOOK_SECRET` for
  nginx's own Docker image templating — since this task's own local proof needed exactly
  that, but it is a documented variant, not the deployed path.)
- Timeouts are bounded (`proxy_connect_timeout`/`proxy_read_timeout` at `3s`) on the internal
  auth location, not nginx's 60s defaults, and there's an explicit note on the new
  operational coupling this whole approach introduces: **every HLS request now blocks on a
  live round trip to `apps/api`**, so an `apps/api` restart now stalls (briefly, bounded by
  those timeouts) every in-flight viewer — before Task 9, an API restart had no effect on an
  already-playing viewer at all, because MediaMTX's own cache kept serving them regardless.
  This is the accepted trade for closing the entitlement gap; see `task-9-report.md` §1 for
  why the alternative is a real security problem, not a hypothetical one.

**`/webhooks/mediamtx/auth-request` — the new endpoint this calls — must stay off the public
surface exactly like `/webhooks/mediamtx/auth` and `/webhooks/mediamtx/lifecycle` above.**
Nothing under `/webhooks/mediamtx/` is proxied by this (or any) public-facing nginx location;
this new route is reached only by the `internal;`-marked location's own subrequest, over the
same private `127.0.0.1` path MediaMTX's own webhook calls already use.

**"Nothing is proxied there" is now enforced by the template, not only a claim about
what it omits — final whole-branch review, Important.** `/webhooks/xendit` and
`/webhooks/telegram` MUST be publicly proxied (Xendit and Telegram both call them from the
internet), and the ordinary way to wire that is one `location /webhooks/ { proxy_pass
...; }` covering the whole prefix — which `/webhooks/mediamtx/*` sits directly under. A
template that said nothing about this would make the DEFAULT outcome of that ordinary
`/webhooks/` proxy a PUBLICLY REACHABLE `/webhooks/mediamtx/auth?secret=...`, writing the
shared secret into `apps/api`'s access log on every call. The template now ships
`location ^~ /webhooks/mediamtx/ { deny all; }` — a `^~` PREFIX location, which nginx picks
over a shorter `/webhooks/` prefix location purely by being the longer, more specific match
(nginx's own longest-prefix rule, independent of file order or `^~`), and which additionally
cannot lose to any REGEX location a real deploy's own config might also have. Paste this
block anywhere in the server block — unlike the `/live/` location below, its ordering
relative to other locations does not matter.

**Regex-location ordering could otherwise defeat the whole `auth_request` fix silently —
final whole-branch review, Important, and worth understanding even though the template
now avoids it.** nginx evaluates REGEX (`~`) locations in the order they appear in the
config file and uses the FIRST one that matches — not the most specific one. A real
deploy's existing SPA/static-asset config plausibly already has something like
`location ~ \.(m3u8|ts)$ { ... }` for caching headers; if that location happened to be
declared before an equivalent `~ /live/...` location, it would intercept every HLS request
with `auth_request` never running at all — a silent, total bypass that neither `nginx -t`
nor a quick read of the file would reveal. The template sidesteps this rather than merely
warning about it: `/live/` is a `location ^~ /live/` PREFIX location, not a regex one.
Per nginx's own location-selection algorithm, once a `^~` prefix location is the longest
matching prefix, nginx **never evaluates any regex location at all** for that request —
not "first match wins", but "the regex phase does not run". Verified directly for this
fix wave: a real nginx server block with a deliberately-planted `location ~
\.(m3u8|ts)$ { return 200 "INTERCEPTED..."; }` declared BEFORE the `/live/` include still
routed every `/live/...` request through `auth_request` (a bad token correctly got `403`,
not the trap's `200`), while the SAME trap location still correctly caught an unrelated
`.m3u8` path outside `/live/` — see `final-fix-report.md` for the transcript. (This
guarantee assumes no OTHER `^~` or exact-match `location =` shares the `/live/` prefix
with equal or greater specificity — worth an explicit `grep` before pasting this in, same
as any nginx change.)

**The public path carries only an event id — the rewrite, and the redirect it has to
cover too.** `/live/` used to be a straight pass-through (`location ~
^/live/(?<mtx_key>[^/]+)...`, proxying the SAME path segment MediaMTX itself understood).
As of the final whole-branch review's Critical fix, the public segment is an EVENT ID and
MediaMTX's own internal path is UNCHANGED (still `live/<streamKey>`), so this location has
to translate one into the other:
1. The event id (and the rest of the requested path — `index.m3u8`, a segment filename,
   a part filename) is captured with a plain `if ($request_uri ~ "...")` inside the `^~`
   location (a `~` LOCATION can't be used here without reopening the ordering problem
   above, but a `~` inside an `if` is a different, safe mechanism — see the template's own
   comment for why this specific "if" is not the kind the "if is evil" warnings are about).
2. `auth_request` calls `/webhooks/mediamtx/auth-request` with the event id as
   `X-Mtx-Event-Id` (NOT `X-Mtx-Path` — that header is gone; `AuthoriseStream` now resolves
   this call via `findById`, the same unscoped-by-id lookup `ResolveWatchToken` uses,
   never via `findByStreamKey`).
3. On success, the route hands back the resolved event's stream key as an `X-Stream-Key`
   RESPONSE HEADER — read only by nginx's `auth_request_set` over `127.0.0.1`, never
   forwarded to the client — and `proxy_pass` uses it to rewrite the request onto
   MediaMTX's internal `live/<streamKey>/...` path before proxying to port `8888`.
4. **Found running this for real, not anticipated from the design**: MediaMTX answers a
   stream's first HLS request with its own `302` "cookie check" redirect (see below), and
   that redirect's `Location` header is MediaMTX echoing back the path it actually
   received — the rewritten, streamKey-shaped INTERNAL one. Left unhandled, the stream key
   would reach the member's browser through this header instead of the body, defeating the
   fix through a different channel. `proxy_redirect /live/$mtx_key/ /live/$mtx_event/;`
   rewrites it back before nginx returns it. MediaMTX's own sub-manifest URIs (segment and
   part filenames) needed no equivalent handling — they are RELATIVE, with no `/live/<key>/`
   prefix at all, so they resolve against whatever path the browser already has (the public,
   event-id one).

Verified end to end against the SHIPPED file (not a hand-reproduced stand-in): a real
`nginx:1.27-alpine` container with the actual template `include`d inside a real `server {}`
block (self-signed local proof, not the production TLS termination — that part of nginx is
untouched by any of this), a real MediaMTX, a real `apps/api`, and a real `ffmpeg` publish.
`GET /c/watch/:token` returned an `hlsUrl` containing the event id and, byte-for-byte, not
the stream key; the master playlist, its `302` cookie-check redirect, the variant playlist,
the init segment and a media segment all played through the proxy with no stream key
anywhere in a header or a body; cancelling the subscription mid-playback cut the SAME
already-open session off on its very next request (`403`, both the playlist reload and the
next segment); and an `ffmpeg` publish attempt using the event id in place of a stream key
was refused by MediaMTX itself (`RTMP ... failed to authenticate: server replied with code
403`). See `final-fix-report.md` for the full transcript.

**The watch token's exposure through nginx, stated precisely rather than as a blanket
"never logged" claim**: it travels as a header (`X-Watch-Token`) into the internal auth
subrequest, not a query parameter, so `access_log off` on both locations keeps it out of
nginx's access log entirely. It does **not** stay out of nginx's **error** log: `auth_request`
logs `"auth request unexpected status"` at ERROR level for any subrequest status outside
2xx/401/403 (an unhealthy `apps/api`, a route drift, an upstream timeout), and that error-log
line independently includes the full original request line — `?token=...` included —
regardless of `access_log off`. Reproduced directly: pointing the internal location at a stub
that always answers `500` produces exactly that line, token and all, in nginx's error log.
**Deliberate choice, not an oversight**: this project keeps nginx's error-log level at its
default rather than raising the threshold to suppress those lines, because that log is
exactly what an operator needs when many viewers break at once — losing it to protect one
query parameter is the wrong trade here. The consequence: **nginx's error log for this server
must be handled as a secret-bearing file**, the same way `apps/api/.env` already is
(restricted permissions, never shipped to a less-trusted log aggregator without stripping
query strings first) — not treated as an ordinary, freely-shippable log. The token DOES still
appear in the *client-facing* HLS URLs themselves (`?token=...` on every playlist/segment
request) — that was always true since Task 8 and is unrelated to this change; see
`apps/web/src/pages/WatchPage.tsx`'s own docstring for why the token, not a header, is the
only mechanism `hls.js` and Safari's native player both have available.

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

### Finding events stuck by a lost hook — the reconciliation query

Both failure directions above are MUTE: a lost `runOnOnline` leaves an event `scheduled`
forever with nobody notified while the creator sees a working broadcast in OBS; a lost
`runOnOffline` leaves an event `live` forever, which is also what widens the publish-key
reuse window `authorise-stream.ts`'s own docstring describes (`PUBLISHABLE_STATUSES`
includes `live`, so an event stuck `live` stays publishable by anyone who still has the
key for far longer than a real session ever runs). Neither failure raises an alert on its
own — this query is how an operator finds them rather than waiting for a support message.

`event` carries no `created_at`/`updated_at` column of its own, so "how long has this been
stuck" has to be reconstructed from whatever timestamp IS available for each direction:

```sql
-- Stuck SCHEDULED (a lost runOnOnline): flags anything scheduled more than
-- 2 hours in the past. "Go live now" sessions (scheduledAt IS NULL) have NO
-- timestamp anywhere on the row to judge age by — listed separately rather
-- than silently dropped, since ignoring them would miss exactly the
-- sessions a creator most likely started immediately.
select id, community_id, title, scheduled_at,
       (stream_key is not null) as has_stream_key
from event
where status = 'scheduled'
  and scheduled_at is not null
  and scheduled_at < now() - interval '2 hours'
order by scheduled_at;

select id, community_id, title
from event
where status = 'scheduled' and scheduled_at is null;
-- ^ no age to filter on — cross-check each one with the creator directly
--   ("did you ever open OBS for this one?") rather than a date threshold.

-- Stuck LIVE (a lost runOnOffline): joins the `stream_live` activity_log
-- row HandleStreamLifecycle writes on go-live (metadata->>'eventId') for a
-- went-live timestamp the event row itself doesn't have. Flags anything
-- live for more than 6 hours — longer than any realistic single session.
select e.id, e.community_id, e.title, al.created_at as went_live_at,
       now() - al.created_at as live_for
from event e
join activity_log al
  on al.event_type = 'stream_live'
  and al.metadata ->> 'eventId' = e.id::text
where e.status = 'live'
  and al.created_at < now() - interval '6 hours'
order by al.created_at;
```

**What to do about a hit:**
1. Check `docker logs infra-mediamtx-1 | grep -A2 -B2 runOnOnline` (or `runOnOffline`) for
   the failure symptom described just above — a wrong-secret 401, a connection failure to
   `apps/api`, or a malformed URL. Fix whatever it names (the usual culprit is the
   three-way `MEDIAMTX_WEBHOOK_SECRET` drift the previous section describes, or `apps/api`
   having been down at the moment the hook fired).
2. For a stuck `live` row where the creator confirms the broadcast is genuinely over: it is
   safe to `update event set status = 'ended' where id = '<id>';` directly — `markEnded`'s
   own allowlist predicate (`{scheduled, live}` -> `ended`) is exactly what this mirrors,
   and nothing downstream re-notifies members on end (`NotifyStreamLive` only ever fires on
   go-live), so a manual correction here has no side effect beyond closing the publish
   window early.
3. For a stuck `scheduled` row: ask the creator whether they ever opened OBS for it. If
   not, it is simply a forgotten schedule — safe to leave, or the creator can just start a
   new session. If they DID try and the hook failure is now fixed, have them stop and
   restart their publish in OBS — a fresh RTMP connection is what re-fires `runOnOnline`;
   nothing retries the original failed call on its own.

### Deferred, on purpose: an OBS reconnect currently kills the session

**Known, accepted, not fixed in this wave — a creator support question this note exists to
answer, not a bug to chase.** `runOnOffline` fires on ANY publisher disconnect, not only a
deliberate stop — a Task 6 end-to-end run proved this directly (`ffmpeg` stopped → `live` →
`ended`). So a few seconds of packet loss that makes OBS auto-reconnect hits exactly the
same hook a deliberate "Stop Streaming" click does: the event flips to `ended`, and `ended`
is excluded from `PUBLISHABLE_STATUSES` (`authorise-stream.ts`), so the creator's own
reconnecting encoder is refused by the SAME authorisation that protects the stream from
everyone else. Every member's watch token is bound to that `eventId`, and any WhatsApp link
already sent is now dead too. **The only way to resume today is scheduling a brand-new
session** (`POST .../events` again) — there is no "resume" affordance, and telling a creator
to "just reconnect OBS" is the wrong answer; tell them to start a fresh session instead.
This is a known, real gap for the most likely first-hour failure mode on an Indonesian
home/mobile uplink, deliberately left alone for this wave rather than folded in with the
security fixes above — do not attempt to fix the underlying behaviour without a fresh
design pass (naively excluding `ended` from `runOnOffline`'s effect would reopen the
republish window `PUBLISHABLE_STATUSES` excluding `ended` exists to close).

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
