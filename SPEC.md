# DIUDARA — Backend Spec

Backend for the DIUDARA paid-community gateway. Replaces `frontend/src/data/mock.ts`
with a real API so every feature the mockup depicts works against a database.

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Bun 1.3 | Already installed; native TS, `Bun.password` (argon2id) means no bcrypt dep |
| HTTP | Hono | Requested; tiny, Web-standard `Request`/`Response` |
| DB | PostgreSQL 16 | Already in `infra/docker-compose.yml` |
| ORM | Drizzle | Requested; SQL-first, typed schema, real migrations |
| Auth | JWT (HS256) in `Authorization: Bearer` | Stateless; SPA already has Login/Register pages |
| Uploads | Local disk (`backend/storage/`) | Mockup needs working attachments; S3 swap is one adapter |

### Ports (environment-constrained — do not change casually)

- **API: 3004.** `deploy/nginx/diudara2.mhamzah.id` already proxies to `127.0.0.1:3004`.
  3000 is occupied by `carreel-grafana`, 3005 by `crypto-api`.
- **Postgres: 5443** (host side). The compose default of 5432 **collides** with the
  already-running `carreel-driver-db` container bound to `0.0.0.0:5432`.

### Routing

All API routes are mounted under a single **`/api`** prefix. The existing nginx config
declares a separate `location` block per resource (`/communities`, `/streams`, `/users`),
and its own comments record the bug that causes: a route without a block falls through to
the SPA and returns `index.html` instead of JSON. One `/api` block eliminates that class of
bug and cannot collide with any client-side route.

## 2. Architecture (SOLID)

Four layers, dependencies point inward only.

```
src/
  domain/          entities + repository INTERFACES (ports). Zero imports from other layers.
  application/     use-case services. Depend on domain interfaces, never on Drizzle.
  infrastructure/  Drizzle repo implementations, db client, storage, jwt, hasher.
  presentation/    Hono routers, middleware, DTO mapping.
  container.ts     composition root — the only file that knows a concrete class.
```

- **SRP** — a service owns one use-case area; routers only parse/serialise.
- **OCP** — swapping storage or payments means adding an adapter, not editing a service.
- **LSP** — every adapter honours its port's contract.
- **ISP** — narrow ports (`PostRepository`, `MembershipRepository`) over one fat `IRepository`.
- **DIP** — services receive ports via constructor injection; `container.ts` picks the impls.

The seam that matters most: `PaymentGateway`. `MockPaymentGateway` confirms instantly (what
the mockup shows). A real Midtrans/Xendit adapter implements the same port — no service changes.

## 3. Data model

Single `posts` table with a `type` discriminator, because the mock already *derives*
`feedPosts` from `forumPosts` + `announcements` + `calendarSchedule`. Tabs are filtered
queries over one table, so the feed can never drift from the tabs.

```
users                    id, email, password_hash, name, handle, avatar_color, initials
communities              id(slug), name, niche, category, description, color,
                         price_cents, billing_period, owner_id
tiers                    id, community_id, name, price_cents, billing_period,
                         benefits(jsonb), highlight, sort_order
community_members        community_id, user_id, role(owner|admin|member),
                         status(active|pending|churned), tier_id, joined_at, ended_at
posts                    id, community_id, author_id, type(diskusi|pengumuman|konten|
                         event|anggota), tag, topic, title, body, syllabus,
                         event_date, event_time, event_location, has_live_room,
                         invite_target, created_at, updated_at
post_attachments         post_id, upload_id
comments                 id, post_id, author_id, body, created_at
comment_likes            comment_id, user_id
uploads                  id, uploader_id, filename, mime, size_bytes, storage_key, kind
syllabi                  id, community_id, title, sort_order
syllabus_items           id, syllabus_id, title, type(video|ebook|audio|quiz), duration
documents                id, community_id, upload_id, name, type, size_bytes
document_downloads       document_id, user_id, created_at      -- backs topDocuments
subscriptions            id, community_id, user_id, tier_id, status, started_at, ends_at
payments                 id, subscription_id, amount_cents, method,
                         status(pending|paid|failed), gateway_ref, paid_at
conversations            id
conversation_participants conversation_id, user_id, last_read_at
messages                 id, conversation_id, sender_id, body, created_at
message_attachments      message_id, upload_id
live_sessions            id, community_id, title, status(idle|live|ended),
                         stream_key, publish_secret, started_at, ended_at
live_watch_tokens        token, session_id, user_id, expires_at, created_at
live_viewers             session_id, user_id, last_seen_at   -- presence; the viewer
                         count is COUNT(*) of these inside a 45s window, nothing else
live_chat_messages       id, session_id, user_id, body, created_at
```

Money is stored as `price_cents` integers, never floats. `"Rp149.000"` is a **presentation**
concern — the API returns `149000` and the client formats it.

## 4. Authorisation rules (server-enforced)

The mockup decides admin-ness with `myCreatedCommunityIds.includes(id)` — a static client
array. That is not a security control. Server rules:

| Action | Allowed |
|---|---|
| Create post type `diskusi` | any active member |
| Create post type `konten`/`event`/`pengumuman` | `owner` or `admin` of that community |
| Edit/delete a post | community `admin`/`owner`, **or** the author of a `diskusi`/`anggota` post |
| Read any community content | active member (or anyone, if the community is free) |
| View creator dashboard | `owner`/`admin` only |
| Publish RTMP to `c/<streamKey>` | a publisher presenting that room's `publish_secret` (`?user=…&pass=…` on the RTMP url). The key alone is NOT enough — it travels in every viewer's playback url |
| See or rotate a room's stream key and secret | `owner`/`admin` of that community |
| Read HLS from `c/<streamKey>` | an unexpired `live_watch_tokens` row issued to an active member for that room. Rotating the key deletes the room's outstanding tokens |

Every rule is re-checked server-side regardless of what the UI renders.

## 5. Endpoints (all under `/api`)

**Auth** `POST /auth/register` · `POST /auth/login` · `GET /auth/me`

**Discovery** `GET /communities?q=&category=&isLive=` · `GET /communities/:id` ·
`GET /categories` · `GET /trending-tags` · `GET /me/communities` (joined + created, one call)

**Community** `GET /communities/:id/feed?tag=&topic=&q=&sort=` · `/members` · `/events` ·
`/announcements` · `/documents` · `/materi` · `/topics` · `/stats`

**Posts** `POST /communities/:id/posts` · `PATCH /posts/:id` · `DELETE /posts/:id` ·
`GET /posts/:id` · `GET /posts/:id/comments` · `POST /posts/:id/comments` ·
`POST /comments/:id/like`

**Commerce** `GET /communities/:id/tiers` · `GET /payment-methods` ·
`POST /communities/:id/subscriptions` · `POST /webhooks/payment`

**Chat** `GET /conversations` · `POST /conversations` (idempotent per user-pair) ·
`GET|POST /conversations/:id/messages` · `POST /conversations/:id/read`

**Uploads** `POST /uploads` · `GET /uploads/:id` · `GET /documents/:id/download`

**Live** `GET /communities/:id/live` · `GET|POST /communities/:id/live/chat` ·
`GET /communities/:id/live/stream-key` (admin-only; provisions the room on first ask) ·
`POST /communities/:id/live/stream-key/rotate` (admin-only; the only way to revoke a key) ·
`POST /communities/:id/live/watch-token` · `POST /communities/:id/live/heartbeat`
(presence; the viewer count is derived from it) · `POST /webhooks/mediamtx/auth` (publish/read
authorisation, decided from the payload's `action` + `path`) ·
`POST /webhooks/mediamtx/lifecycle` (`online`/`offline` — how a session learns it is
actually broadcasting)

## 6. Scope limits — stated plainly

These are things the mockup *depicts* that the backend cannot honestly deliver as drawn.

1. **Live Room is not a video call.** `LiveRoomPage.tsx` drew a multi-party conference —
   participant tiles, per-person mute. MediaMTX is a broadcast relay, **not an SFU**, so it
   cannot produce the pictured many-to-many call. A real conference needs LiveKit/mediasoup.
   **Delivered:** one broadcaster (OBS over RTMP) plus HLS viewers, end to end — session
   state, live chat, real playback in a `<video>` driven by hls.js and gated by watch
   tokens, and a viewer count that counts actual viewers (`live_viewers`, refreshed by each
   player every 20s, present for 45s). The participant tiles and their per-person mute
   controls are **gone**, not disabled: they were buttons for a call this app cannot hold.
   Still missing: browser-based publishing — no `getUserMedia`/WHIP in the app, so a creator
   needs OBS or another RTMP encoder.

   Two properties of MediaMTX bound what the token can promise, both confirmed against this
   deployment rather than taken from docs: it authorises a playback **session** once and then
   trusts its own `hlsSession` cookie, so a token that expires mid-watch does not interrupt
   the viewer; and it authorises a publish only at connect, so rotating a key cannot kick a
   publisher already on air, only stop the next connection.

2. **Payments are simulated.** `MockPaymentGateway` marks payments paid immediately, which
   is what the mockup shows. Membership and payment rows are real, so dashboard revenue is
   real. Swapping in a gateway is one adapter + the existing `POST /webhooks/payment`.

3. **Stats with no real source.** Derived by SQL: `totalMembers`, `newMembersThisMonth`,
   `churnRate`, `revenueByMonth`, `totalRevenue`, `tierDistribution`, `activityLog`,
   `recentMembers`, `successRate` (needs failed attempts — so failed payments are recorded),
   `topDocuments.downloads` (needs the `document_downloads` table — added for this).
   **Still fabricated:** the deltas `"+12% bulan ini"`, `"-0,4% dari bulan lalu"` are string
   literals in the JSX, not data; they need period-over-period comparison to mean anything.

4. **Chat is polled, not realtime.** Nothing in the current UI receives inbound messages, so
   polling reaches feature parity. WebSockets would be a genuine upgrade, not a restoration.

5. **`trending` has no source.** Needs a rule; defaulting to "most new members in 7 days".

6. **The WhatsApp invite** promised in the checkout success copy has no backing feature.

## 7. Seeding

`bun run db:seed` loads exactly the content of `mock.ts` (same Indonesian copy, same
community ids) so the app looks identical to the mockup on first run, but every byte now
comes from Postgres. Seed users get password `password123`; `rangga@diudara.id` is the
`currentUser` equivalent and owns `bimbel-sbmptn` + `finansial-cerdas`.

## 8. Frontend integration

`mock.ts` is replaced by `src/lib/api.ts` (typed fetch client, attaches JWT) plus per-page
loading/error states. `VITE_API_URL` defaults to `http://localhost:3004/api` in dev; in prod
it is same-origin `/api`.

Note: `frontend/CLAUDE.md` currently says "never wire up real APIs here" and "all data is
dummy". That instruction described the mockup phase and is superseded by this spec; it is
updated in the same change.
