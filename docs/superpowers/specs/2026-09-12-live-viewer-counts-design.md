# Live viewer counts

Sub-project 2 of 3 towards a Discover page matching `docs/references/discover.png`.
This phase makes `StreamView` (`GET /streams`) carry a real, live, approximate
count of how many people are currently watching — the "128 nonton" the
reference shows on a live card. It does not touch the Discover page itself or
Jelajah's nav slot — those are sub-project 3.

## The constraint that shapes this design

A **public** stream's HLS reads carry no watch token at all —
`AuthoriseStream.authoriseUserStreamRead`'s own docstring: "a public row needs
no token — there is nothing to mint". Only a `members`-visibility stream's
reads carry one. Since the reference's live card is a community-wide discovery
signal (almost certainly `public`), a design that can only count token-bearing
viewers would show no count on exactly the card this exists for.

So two identities feed the same mechanism:

- **members-only**: the watch token already names a `viewerId` — exact.
- **public**: no token exists, so the identity is derived from the request's
  forwarded IP and User-Agent — approximate (two people behind the same NAT
  sharing a browser version collapse into one; a phone put down and picked
  up under a new IP counts twice). This is the accepted tradeoff for a number
  whose own product category (Twitch, YouTube Live) has always been
  approximate, never exact.

Both identities are recorded through the **same already-firing endpoint**:
nginx's `/auth-request`, which the codebase already calls on every single HLS
request (master playlist, every sub-playlist reload, every segment) because
MediaMTX's own `authHTTPAddress` only authorises a read once per session (see
that route's own docstring). No new MediaMTX hook is added — this phase
deliberately avoids depending on an undocumented MediaMTX hook variable
(`$MTX_READER_ID` or similar) that nothing in this codebase has ever run
against a real MediaMTX instance to confirm exists or behaves as hoped, the
exact class of mistake `task-9-report.md` already paid for once.

## The one unverified piece

`/auth-request` already receives `User-Agent` for free — nginx's
`auth_request` subrequest inherits the original request's headers unless a
directive overrides them, and nothing here does. The client's IP is not a
header, though; it is `$remote_addr`, so `live-hls.conf.template`'s internal
`/auth-request` location needs one added line:

```
proxy_set_header X-Client-IP $remote_addr;
```

This mirrors `api-proxy.conf.template`'s existing `X-Real-IP $remote_addr`
line verbatim — the same directive, already relied on elsewhere in this
codebase — so it is a low-risk, precedented change. It is still **unverified
against a real MediaMTX/nginx box**, the same standing every other
nginx-behaviour claim in `mediamtx-webhooks.ts` carries until someone runs it
for real (see that file's own docstrings, several of which record exactly
this kind of thing being "found running this for real, not from
documentation"). **Before deploying this phase, run a real HLS read through
the updated config and confirm `X-Client-IP` actually arrives** — do not
trust this document over that test. Until it is deployed, a public stream's
heartbeats silently degrade to one shared identity (see below) rather than
crashing.

## Design

### Identity

New pure module, `domain/anonymous-viewer-identity.ts`:

```
anonymousViewerIdentity(ip: string, userAgent: string): string
  // sha256("diudara.anon-viewer.v1:" + ip + ":" + userAgent), hex.
```

Domain-prefixed the same way `user-watch-token.ts`'s `DOMAIN` constant is —
so this hash can never collide with a token's own `viewerId` even by
coincidence, keeping the two identity kinds visibly distinct if ever
inspected. A request missing `X-Client-IP` (not yet deployed, or a
non-nginx caller) hashes `("unknown", userAgent)` instead of failing —
several genuinely-anonymous viewers collapse into a smaller number rather
than the route erroring, which is the same "approximate, never crashing"
posture the rest of this phase takes.

### `AuthoriseStream` — surfaces which identity a read used

`authoriseUserStreamRead`'s success cases widen from `{ allowed: true }` to
`{ allowed: true; viewerId: string | null }`: `null` for a public row (no
token to name one), the token's `viewerId` for a members-only row. The
refusal case is unchanged (`{ allowed: false }`). `authoriseUserReadByStreamId`
(nginx's entry point) carries this through into its own success case
alongside `streamKey`. `execute()`'s public contract (`/auth`, MediaMTX's own
hook, called once per session rather than repeatedly) is untouched — nothing
there needs a repeated identity.

### Recording a heartbeat

New table, `stream_viewer_heartbeat`:

```
id: uuid, primary key
streamId: uuid, references user_stream(id)
identity: varchar(64)   // a token's viewerId (uuid) or the sha256 hex above
lastSeenAt: timestamptz, default now()
```

- `uniqueIndex(streamId, identity)` — what makes recording an UPSERT
  (`on conflict ... do update set last_seen_at = excluded.last_seen_at`)
  rather than an ever-growing row per request.
- `index(streamId, lastSeenAt)` — what the count query below reads through.

New port, `StreamViewerRepositoryPort`:

```
heartbeat(streamId: string, identity: string, now: Date): Promise<void>
countRecentViewers(streamIds: string[], since: Date): Promise<Map<string, number>>
```

New use-case, `RecordStreamViewerHeartbeat` — a thin pass-through (this
codebase's routes call a use-case, never a repository directly; see
`EndUserStream` for the pattern this mirrors). Called from
`GET /webhooks/mediamtx/auth-request` immediately after
`authoriseUserReadByStreamId` returns `allowed: true`, computing the identity
from `viewerId` if present, else `anonymousViewerIdentity(X-Client-IP ??
"unknown", User-Agent ?? "")`.

**Awaited, not fire-and-forget** — a correction from this document's first
draft, made during implementation for the reason the test-driven-development
discipline this codebase follows names directly: a write nothing can
deterministically observe is a write nothing can be honestly tested against.
This endpoint already pays one database read to authorise the request; one
more small upsert next to it is a modest addition, not a second latency
class. A failed heartbeat is still swallowed (`try`/`catch`, never
rethrown) so it can never turn an authorised read into a 500 — the
resilience the fire-and-forget draft wanted, kept, without giving up
testability to get it. A REFUSED request (`allowed: false`) records
nothing — a refusal is not a viewer.

### Reading the count

`stream-views.ts` gains:

```
export const VIEWER_HEARTBEAT_WINDOW_MS = 20_000;
```

Twenty seconds, chosen to comfortably survive a normal HLS reload gap
(sub-playlists reload well inside that on a live stream) while dropping
someone within a few reloads of actually leaving.

`StreamView` gains `viewerCount: number`, present on every row (locked or
not) — a viewer count is a discovery signal, not something worth hiding on a
gated stream a visitor cannot yet watch. `ListLiveStreams.execute` takes a
new `StreamViewerRepositoryPort` dependency, fetches
`countRecentViewers(rows.map(r => r.id), new Date(now - VIEWER_HEARTBEAT_WINDOW_MS))`
alongside its existing membership check, and folds the result into
`toStreamView`'s output (defaulting to `0` for a stream with no recent
heartbeats — a stream nobody is polling yet, most commonly one that only
just went live).

### Keeping the table bounded

A sixth scheduled pass alongside the five `apps/worker` already runs hourly
(`SweepOrphanMedia`, `SweepExpiredMemberships`, `SweepStalePendingCheckouts`,
`SweepStaleUserStreams`, the reminder pass): `SweepStaleViewerHeartbeats`,
deleting every row older than one hour (a wide margin over the 20-second
count window — this cutoff only ever needs to outlive rows nothing will
count again, not protect the count itself). Defined directly in
`scheduled-passes.ts` against a narrow structural interface
(`{ deleteOlderThan(cutoff): Promise<number> }`), the same shape
`StaleUserStreamRepository` already takes there — `DrizzleStreamViewerRepository`
satisfies it for free alongside the full API-side port, exactly as
`DrizzleUserStreamRepository` does for its own sweep.

## Testing

- `anonymous-viewer-identity.test.ts` — same inputs hash identically;
  different ip or UA hash differently; the "unknown" fallback is exercised.
- `authorise-stream.test.ts` — widened: a public read's `viewerId` is `null`;
  a members-only read's is the token's; a refusal carries none.
- `drizzle-stream-viewer.repository.test.ts` — a repeated heartbeat for the
  same `(streamId, identity)` updates one row rather than inserting a second;
  `countRecentViewers` counts distinct identities within the window, excludes
  a stale one just past it, and excludes another stream's rows entirely;
  `deleteOlderThan` removes only rows past its cutoff.
- `record-stream-viewer-heartbeat.test.ts` — the use-case forwards to the
  port unchanged.
- The `ListLiveStreams` test file — `viewerCount` appears correctly per
  stream, defaults to `0` with no heartbeats, and is present on a locked row
  too.
- `mediamtx-webhooks.test.ts`'s `/auth-request` suite — an allowed public
  request with `X-Client-IP` records a heartbeat keyed by the IP+UA hash; an
  allowed public request WITHOUT `X-Client-IP` still succeeds and records
  under the "unknown" fallback rather than erroring; an allowed members-only
  request records under the token's `viewerId`; a refused request records
  nothing.
- `scheduled-passes.test.ts` — `SweepStaleViewerHeartbeats` deletes past its
  cutoff, leaves recent rows alone, and a thrown repository error is caught
  and logged rather than propagated (mirroring `SweepStaleUserStreams`'s own
  tests).

## Out of scope (sub-project 3)

The Discover page itself; deriving "is this community live" from its
owner's `user_stream`; Jelajah's nav slot and the fate of its "Orang" tab.
