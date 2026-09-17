# DIUDARA

Paid community gateway. Monorepo: React SPA + Bun/Hono API + Postgres.

```
frontend/   React 18 + Vite + TypeScript SPA
backend/    Bun + Hono + Drizzle API  (port 3004)
infra/      docker-compose: Postgres (host port 5443), MediaMTX
deploy/     nginx site configs (two hostnames, one app) + TLS notes
scripts/    deploy.sh
SPEC.md     backend spec — read this before changing the API
```

## Running locally

```bash
cd infra    && docker compose up -d postgres
cd backend  && bun install && bun run db:migrate && bun run db:seed && bun run dev
cd frontend && bun install && bun run dev      # proxies /api -> :3004
```

Seed logins: any `*@diudara.id` address with password `password123`.
`rangga@diudara.id` owns `finansial-cerdas` and is admin of `bimbel-sbmptn`.

## Environment constraints (do not "simplify" these)

- **API port 3004.** `deploy/nginx/` proxies there. 3000 is taken by another
  container on this host, 3005 by another.
- **Two public hostnames, one app.** `diudara2.mhamzah.id` and
  `diudara.mhamzah.id` both serve it, each with its own cert and document root.
  The two files in `deploy/nginx/` differ ONLY in server_name, cert and root —
  keep every location block identical, and `scripts/deploy.sh` deploys both.
- **RTMP ingest is `stream.mhamzah.id:1935`, not the site hostnames.** Both site
  names are proxied by Cloudflare, which forwards HTTP/HTTPS only, so OBS dialling
  them reaches a Cloudflare edge IP with nothing on 1935. `MEDIAMTX_RTMP_HOST` in
  `backend/.env` must name a DNS-only record pointing at this box.
- **Postgres host port 5443.** 5432 is taken by an unrelated container.
- **Database `diudara_app`.** The `diudara` database on the same volume holds
  rows from a previous backend; it was left untouched rather than dropped.
- **`OPENROUTER_API_KEY` is server-side only.** The AI co-builder proxies through
  `POST /api/ai/community-builder`; never move the key into a `VITE_*` var, which
  would ship it to every visitor. Leave it blank and that one endpoint 503s while
  the rest of the API works.

## Backend conventions

Layered, dependencies point inward: `domain/` (entities + repository interfaces)
← `application/` (use-case services) ← `infrastructure/` (Drizzle, storage, JWT)
and `presentation/` (Hono routers). `container.ts` is the only file that names a
concrete implementation.

- Services depend on interfaces from `domain/ports.ts`, never on Drizzle directly.
- All authorisation lives in `application/AccessPolicy.ts`. Never trust a
  client-supplied role — the UI's `isAdmin` is a rendering hint, not a control.
- Money is stored and transported as integer **cents** (`priceCents`).
  Formatting to "Rp149.000" is the frontend's job (`lib/format.ts`).
- Drizzle gotcha: interpolating a column into a `sql` template inside a
  correlated subquery renders it **unqualified**, so a bare `"id"` binds to the
  inner table. Use explicit table aliases in subqueries — see
  `DrizzleCommunityRepository.baseQuery()` for the bug this caused.

## Frontend conventions

- Plain CSS with design tokens in `src/styles/tokens.css` — no Tailwind/UI framework.
  Reuse `.card`, `.btn`, `.badge`, `.input` rather than inventing ad-hoc styles.
- Palette "Udara — Langit & Sinyal"; Bricolage Grotesque + Plus Jakarta Sans.
- Data comes from `src/lib/api.ts` via the `useApi` hook. **`src/data/mock.ts` is
  gone** — the app runs against the real API.
- Bahasa Indonesia for all UI copy; English for code, comments, commits.
- Keep components self-contained per page; avoid premature abstraction until a
  pattern repeats 3+ times.
- Don't add npm dependencies without a clear reason.

## Scope limits worth knowing

The Live Room is one broadcaster plus viewers, not a conference: MediaMTX is a
broadcast relay, not an SFU, and there is no WebRTC, so a creator streams from
OBS over RTMP and members watch HLS in the app. Session state, live chat and the
viewer count (`live_viewers` presence rows, 45s window) are real; browser-based
publishing is not. Publishing needs the room's `publish_secret`, not just the
stream key (the key is a public path segment — it appears in every viewer's
playback url), and watching needs a `live_watch_tokens` row. Payments
go through `MockPaymentGateway`, which confirms instantly — a real gateway
implements the same `PaymentGateway` port. See SPEC.md §6 for the full list.
