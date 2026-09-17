# DIUDARA

Paid community gateway: creators sell access to a community, members get a feed,
a library, direct messages, and live sessions they can actually watch.

React SPA + Bun/Hono API + Postgres, with MediaMTX relaying RTMP in and HLS out.
UI copy is Bahasa Indonesia; code, comments and commits are English.

```
frontend/   React 18 + Vite + TypeScript SPA
backend/    Bun + Hono + Drizzle API (port 3004)
infra/      docker-compose: Postgres (host port 5443), MediaMTX
deploy/     nginx site configs for the two public hostnames + TLS notes
scripts/    deploy.sh — one command, both hostnames, verifies it serves
SPEC.md     what the backend does, and §6 what it deliberately does not
```

## Running locally

```bash
cd infra    && docker compose up -d postgres
cd backend  && bun install && bun run db:migrate && bun run db:seed && bun run dev
cd frontend && bun install && bun run dev      # proxies /api -> :3004
```

Seed logins: any `*@diudara.id` address with password `password123`.
`rangga@diudara.id` owns `finansial-cerdas` and is admin of `bimbel-sbmptn`.
`bun run db:seed` prints the seeded room's OBS server and stream key.

## Architecture

The backend is layered and dependencies point inward:

```
domain/          entities + repository interfaces (no framework, no Drizzle)
  ^
application/     use-case services; all authorisation in AccessPolicy.ts
  ^
infrastructure/  Drizzle repositories, storage, JWT, payment gateway
presentation/    Hono routers
```

`container.ts` is the only module that names a concrete implementation, so
swapping Postgres for something else, or `MockPaymentGateway` for a real one,
is an edit to that file. Money is stored and transported as integer cents.

## Live streaming

A creator broadcasts from OBS over RTMP; members watch HLS in the Live Room.

- **Publishing** needs the room's `publish_secret`, not just the stream key —
  the key is a public path segment that appears in every viewer's playback URL,
  so it cannot also be the credential. Both rotate together, and rotating is
  the only revocation there is.
- **Watching** needs a `live_watch_tokens` row, issued to active members and
  checked by MediaMTX against `POST /api/webhooks/mediamtx/auth`.
- **The viewer count** counts viewers: players check in every 20s and are
  counted as present for 45s. There is no stored number.
- **RTMP ingest uses its own hostname.** The web hostnames are behind a CDN
  that forwards HTTP/HTTPS only, so `MEDIAMTX_RTMP_HOST` must name a DNS-only
  record pointing at the origin.

## What this does not do

Stated properly in [SPEC.md §6](SPEC.md), briefly here: there is no
browser-based publishing (a creator needs OBS or another RTMP encoder), the
Live Room's participant tiles were removed rather than faked because MediaMTX
is a broadcast relay and not an SFU, payments run through `MockPaymentGateway`
which confirms instantly, and a few dashboard deltas are still literals in the
JSX rather than period-over-period data.

## Deploying

`scripts/deploy.sh` brings up infra, migrates, restarts the API under pm2,
publishes the bundle to both document roots, syncs both nginx sites behind a
single `nginx -t`, and then verifies each hostname really serves: `/` is 200,
`/api` returns JSON rather than the SPA's HTML, and `/hls` reaches MediaMTX.
It never touches `.env` files or seeds the database.

See [CLAUDE.md](CLAUDE.md) for the environment constraints that look arbitrary
and are not — the ports, the database name, and which secrets must stay
server-side.
