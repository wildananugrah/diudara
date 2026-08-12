# Live Streaming Implementation Plan (part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator goes live from OBS and only their paying members can watch, with access
authorised by our own API on every publish and every segment read.

**Architecture:** MediaMTX runs as a container and asks the API to authorise each publish and each
read (`authMethod: http`). Watch tokens are stateless HMACs identifying a subscription; entitlement
is re-checked live on every read, so a churned member stops being able to watch mid-stream. Stream
lifecycle arrives as shell hooks that `curl` a secret-verified endpoint.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, MediaMTX, `hls.js`, Vite + React, `bun:test`.

**Scope:** live streaming only. Recording and replay are part 2
(`docs/superpowers/plans/2026-08-11-live-streaming-recording.md`), written after this lands.

## Global Constraints

From `docs/superpowers/specs/2026-08-11-live-streaming-design.md`.

- **The hooks are `runOnOnline` (publisher starts) and `runOnOffline` (publisher stops).** There is
  no `on-publish`/`on-unpublish` — the parent MVP spec is wrong about this. Hooks are **shell
  commands**, not HTTP callbacks: each runs a `curl` and receives `MTX_PATH` (the stream key) in
  its environment.
- **Every read is authorised, and entitlement is re-checked on each one.** A valid signature is not
  enough — the subscription must still be active. Phase 5 shipped a Critical because the one
  consumer that skipped this check skipped it.
- **Watch tokens are HMAC over `subscriptionId`, `eventId` and expiry, with a 6-hour lifetime**,
  signed with `STREAM_TOKEN_SECRET` — **never** `JWT_SECRET`. Different audience, different
  lifetime; one compromise must not be both.
- **`MEDIAMTX_WEBHOOK_SECRET` is the only thing authenticating both MediaMTX endpoints.** Verify it
  with the existing `verifyCallbackToken` from
  `apps/api/src/infrastructure/webhooks/webhook-token.ts` — constant-time, SHA-256'd first. Do not
  write a second comparison.
- **Absent streaming configuration must not block boot.** Follow the AI co-builder's pattern, not
  the payment adapter's: the API boots with streaming disabled and the creator UI hidden.
- **MediaMTX's HLS port stays bound to localhost**, proxied by nginx. Exposing 8888 publicly would
  let anyone fetch segments without passing read authorisation, defeating the entire mechanism.
  RTMP (1935) *is* public — OBS connects from outside — and is protected by publish authorisation.
- Cross-community access returns **404, not 403**, and leaks nothing.
- Ports-and-adapters; Drizzle only; **generated** migrations only.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never
  bare `bun test`**, which from the root produces ~123 spurious failures because `apps/web` needs
  its own bunfig preload.
- A failing `expect(<DOM element>).toBeNull()` **hangs `bun test`** (178 s, 335 MB). Count elements
  or assert booleans; there is a source-scan guard at
  `apps/web/src/test/no-hanging-dom-assertions.test.ts`.

---

### Task 1: Watch tokens

**Files:**
- Create: `apps/api/src/domain/watch-token.ts`
- Test: `apps/api/src/domain/watch-token.test.ts`

**Interfaces:**
- Produces `mintWatchToken({ subscriptionId, eventId, now, ttlMs, secret }): string` and
  `verifyWatchToken({ token, now, secret }): { subscriptionId: string; eventId: string } | null`.
- Later tasks consume both. `verifyWatchToken` returns `null` for every failure — bad signature,
  expired, malformed, wrong secret — and **never throws and never explains which**.

**Pure module, no imports from `application/` or `infrastructure/`.** It does crypto and nothing
else, which is what makes it exhaustively testable.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "bun:test";
import { mintWatchToken, verifyWatchToken, WATCH_TOKEN_TTL_MS } from "./watch-token";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = 1_760_000_000_000;
const SUB = "11111111-1111-4111-8111-111111111111";
const EVT = "22222222-2222-4222-8222-222222222222";

function mint(overrides: Partial<Parameters<typeof mintWatchToken>[0]> = {}) {
  return mintWatchToken({
    subscriptionId: SUB,
    eventId: EVT,
    now: NOW,
    ttlMs: WATCH_TOKEN_TTL_MS,
    secret: SECRET,
    ...overrides,
  });
}

describe("watch tokens", () => {
  it("round-trips the ids it was minted with", () => {
    expect(verifyWatchToken({ token: mint(), now: NOW, secret: SECRET })).toEqual({
      subscriptionId: SUB,
      eventId: EVT,
    });
  });

  it("is still valid one millisecond before expiry and invalid at expiry", () => {
    const token = mint();
    expect(verifyWatchToken({ token, now: NOW + WATCH_TOKEN_TTL_MS - 1, secret: SECRET })).not.toBeNull();
    expect(verifyWatchToken({ token, now: NOW + WATCH_TOKEN_TTL_MS, secret: SECRET })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyWatchToken({ token: mint(), now: NOW, secret: OTHER_SECRET })).toBeNull();
  });

  // The attack this exists to stop: swap in someone else's subscription id and
  // keep the signature. Editing the payload must invalidate it.
  it("rejects a token whose payload was edited", () => {
    const token = mint();
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    decoded.subscriptionId = "33333333-3333-4333-8333-333333333333";
    const forged =
      Buffer.from(JSON.stringify(decoded)).toString("base64url") + "." + signature;
    expect(verifyWatchToken({ token: forged, now: NOW, secret: SECRET })).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const token of ["", ".", "not-a-token", "a.b.c", "€.€"]) {
      expect(verifyWatchToken({ token, now: NOW, secret: SECRET })).toBeNull();
    }
  });

  it("gives two subscriptions different tokens for the same event", () => {
    const other = mint({ subscriptionId: "44444444-4444-4444-8444-444444444444" });
    expect(other).not.toBe(mint());
  });

  it("expires in six hours", () => {
    expect(WATCH_TOKEN_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/api && bun test src/domain/watch-token.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Six hours: longer than any realistic session plus overrun, short enough that a
 * leaked URL is not a permanent key. See the design spec §5.2.
 */
export const WATCH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

interface WatchTokenPayload {
  subscriptionId: string;
  eventId: string;
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintWatchToken(input: {
  subscriptionId: string;
  eventId: string;
  now: number;
  ttlMs: number;
  secret: string;
}): string {
  const payload: WatchTokenPayload = {
    subscriptionId: input.subscriptionId,
    eventId: input.eventId,
    exp: input.now + input.ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, input.secret)}`;
}

/**
 * Returns the ids, or null. NEVER throws, and never distinguishes between a bad
 * signature, an expired token and a malformed one — the caller answers 403 with
 * one message for all of them, so telling them apart here would only create a
 * chance to leak the difference later.
 *
 * This token proves WHO the request is for. It does NOT prove they are still
 * entitled: the caller must re-check the subscription. See the design spec §5.2.
 */
export function verifyWatchToken(input: {
  token: string;
  now: number;
  secret: string;
}): { subscriptionId: string; eventId: string } | null {
  const parts = input.token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = sign(encoded, input.secret);
  // Both are base64url of a 32-byte digest, so lengths match unless the input is
  // junk — in which case the length guard rejects it before timingSafeEqual,
  // which throws on mismatched lengths.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: WatchTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof payload?.subscriptionId !== "string") return null;
  if (typeof payload?.eventId !== "string") return null;
  if (typeof payload?.exp !== "number") return null;
  if (input.now >= payload.exp) return null;

  return { subscriptionId: payload.subscriptionId, eventId: payload.eventId };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test src/domain/watch-token.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the signature comparison**

Temporarily replace the `timingSafeEqual` line with `if (signature !== expected) return null;` and
confirm the suite still passes (it should — behaviour is identical), then replace it with
`return { subscriptionId: ..., eventId: ... }` before any verification and confirm the
edited-payload and wrong-secret tests **fail**. Restore. Report both results: the first proves the
tests are not accidentally coupled to the comparison mechanism, the second proves they pin the
security property.

- [ ] **Step 6: Root gates and commit**

```bash
cd ../.. && bun run test && bun run typecheck
git add apps/api/src/domain/watch-token.ts apps/api/src/domain/watch-token.test.ts
git commit -m "feat(streaming): add signed, time-limited watch tokens"
```

---

### Task 2: `StreamingProviderPort`, the MediaMTX adapter, and boot wiring

**Files:**
- Create: `apps/api/src/application/ports/streaming-provider.port.ts`
- Create: `apps/api/src/infrastructure/streaming/mediamtx.adapter.ts`
- Create: `apps/api/src/infrastructure/streaming/fake-streaming.adapter.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/.env.example`
- Test: adapter test, fake test, and `bootstrap.test.ts` additions

**Interfaces:**
- `StreamingProviderPort.createSession({ streamKey }): { rtmpUrl: string; hlsPlaybackPath: string }`
  — pure URL construction; MediaMTX needs no API call to accept a new path.
- `newStreamKey(): string` — 32 hex characters from `crypto.randomBytes(16)`.
- `selectStreamingProvider(env)` in `bootstrap.ts`, returning `StreamingProviderPort | undefined`.

**The adapter is deliberately thin, and that is worth stating in its docstring.** MediaMTX accepts
a publish to any path that authorisation allows, so "creating a session" is minting a key and
building two URLs. There is no provider call to make, and inventing one would be ceremony.

Follow `apps/api/src/infrastructure/payments/xendit-payment.adapter.ts` for the house style:
an `UNVERIFIED AGAINST A LIVE MEDIAMTX` banner, and errors that never contain the secret.

**Configuration**, added to `.env.example` with the same fail-closed reasoning as its neighbours:
`MEDIAMTX_RTMP_HOST`, `MEDIAMTX_HLS_BASE_URL`, `MEDIAMTX_WEBHOOK_SECRET` (≥32 chars),
`STREAM_TOKEN_SECRET` (≥32 chars). Set together or not at all; partial configuration throws in
**every** environment. **Absent configuration disables streaming and must not block boot.**

- [ ] **Steps:** failing tests (URL construction; key uniqueness across 1000 mints; the selector
  returns `undefined` when unconfigured, throws on partial configuration, and — the test that
  matters — **is inert outside `RELAXED_NODE_ENVS` with a garbage value**, which is the shape this
  project shipped twice in Phase 3) → implement → root gates → commit
  `"feat(streaming): add StreamingProviderPort and the MediaMTX adapter"`.

---

### Task 3: Scheduling a session

**Files:**
- Create: `apps/api/src/application/use-cases/schedule-live-session.ts`
- Create: `apps/api/src/application/ports/event-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-event.repository.ts`
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/bootstrap.ts`
- Test: use-case, repository and route tests

**Interfaces:**
- `EventRepositoryPort` — `createForCreator`, `findByIdForCreator`, `findByStreamKey`,
  `listForCommunityForCreator`, `markLive`, `markEnded`. **Every creator-facing method takes
  `creatorId`; `findByStreamKey` is the single sanctioned unscoped lookup** (MediaMTX knows only
  the key) and must carry a docstring saying so, in the shape `findBySlug` already uses.
- `ScheduleLiveSession.execute({ creatorId, communityId, title, scheduledAt })` →
  `{ id, title, status, rtmpUrl, streamKey, hlsPlaybackPath }`.
- `POST /communities/:communityId/events` and `GET /communities/:communityId/events`, behind
  `requireAuth`.

**The stream key is a secret.** It is returned to the creator who owns the community and to nobody
else — never in a list endpoint for another creator, never in an activity log, never in an error.
Cross-creator access to a community returns 404.

- [ ] **Steps:** failing tests (create returns an RTMP URL and a key; a second session gets a
  different key; cross-creator create and list both 404; the key never appears in the list
  response for a different creator) → implement → generated migration if the schema needs one →
  root gates → commit `"feat(streaming): schedule a live session"`.

---

### Task 4: Publish and read authorisation

**Files:**
- Create: `apps/api/src/application/use-cases/authorise-stream.ts`
- Create: `apps/api/src/routes/mediamtx-webhooks.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/bootstrap.ts`
- Test: use-case and route tests

**Interfaces:**
- Consumes `verifyWatchToken` (Task 1), `EventRepositoryPort.findByStreamKey` (Task 3).
- `AuthoriseStream.execute({ action, path, query, now })` → `{ allowed: boolean }`.
- `POST /webhooks/mediamtx/auth`, secret-verified with `verifyCallbackToken`.

**This is the security core of the phase.** MediaMTX POSTs a JSON body containing at minimum
`action` (`publish` or `read`), `path`, and `query`. Decide:

- **`publish`:** allow only if `path` resolves via `findByStreamKey` to an event whose `status` is
  `scheduled` or `live`. An `ended` event refuses — a finished session must not be republishable.
- **`read`:** parse the watch token from `query`, `verifyWatchToken` it, check the token's
  `eventId` matches the event the path resolves to, **and then re-check that the subscription is
  still `active` and belongs to that event's community.** All four must hold.

**The entitlement re-check is not optional and not redundant.** A member who churns mid-stream must
stop being able to watch on their next segment request. Phase 5 shipped a Critical for exactly this
omission in `RevokeChannelAccessForSystem`.

**Tests, each of which must exist:**
- publish: `scheduled` allows, `live` allows, `ended` refuses, unknown key refuses
- read: valid token allows
- read: **token minted while active, subscription then cancelled → refuses.** Drive the
  cancellation between the mint and the read, not by minting an already-invalid token
- read: token for event A used against event B refuses
- read: subscription belonging to community A, event in community B → refuses
- missing or wrong `MEDIAMTX_WEBHOOK_SECRET` header → 401, and **no database read happens**
- every refusal returns the same body; nothing distinguishes "no such event" from "not entitled"

- [ ] **Steps:** failing tests → implement → mutation-check by deleting the entitlement re-check
  and confirming exactly the cancelled-subscription test fails → root gates → commit
  `"feat(streaming): authorise every publish and every read"`.

---

### Task 5: The stream lifecycle

**Files:**
- Create: `apps/api/src/application/use-cases/handle-stream-lifecycle.ts`
- Modify: `apps/api/src/routes/mediamtx-webhooks.ts`
- Test: use-case and route tests

**Interfaces:**
- `HandleStreamLifecycle.execute({ hook, streamKey, now })` where `hook` is `"online" | "offline"`.
- `POST /webhooks/mediamtx/lifecycle`, secret-verified with the same secret as Task 4.

**Behaviour:**
- `online` → `status = live`, set `hls_playback_path`, write an `activity_log` row, enqueue an
  outbox row of type `notify_stream_live`.
- `offline` → `status = ended`, write an `activity_log` row.

**Out-of-order and repeated hooks are expected, not exotic.** MediaMTX may fire `offline` for a
session the API never saw go `online` (API restarted mid-stream), and a flapping publisher fires
both repeatedly. Each transition must be **idempotent** and must never move an event backwards:
`ended` → `live` must not happen from a late `online`.

**Tests:**
- `online` on a `scheduled` event → `live`, one activity row, one outbox row
- `online` twice → still one outbox row (a member must not be notified twice)
- `offline` on an event that was never `live` → `ended`, no crash
- `offline` then a late `online` → stays `ended`
- an unknown stream key → 200 with no write, because a hook that 500s makes MediaMTX retry forever

**The outbox row needs a consumer in this same task.** An enqueued `notify_stream_live` that
nothing processes sits pending for ever, and every phase since 4 has paired a new event type with
its consumer. Add one in `apps/worker` alongside the existing consumers: it loads the event's
community, finds the **active** subscriptions, mints a watch token per subscription (Task 1), and
sends each member the link over the messaging notifier — which is the Fonnte adapter in
production and the fake in development, so this works today and gets real delivery when a token
exists.

Ask the question this project made a rule after Phase 5: **what has changed by the time this row
is delivered?** A member may have churned between go-live and delivery, so the consumer filters on
`active` at send time rather than trusting the enqueue. And the stream may already have ended —
sending a watch link to a finished session is worse than sending nothing, so skip and record it.

Two more tests for the consumer:
- a member who churned between enqueue and delivery is not messaged
- the event ended before delivery → nothing is sent, and the skip is recorded

- [ ] **Steps:** failing tests → implement the use-case, the route and the worker consumer →
  root gates → commit `"feat(streaming): handle the MediaMTX online and offline hooks"`.

---

### Task 6: MediaMTX in the infrastructure

**Files:**
- Create: `infra/mediamtx.yml`
- Modify: `infra/docker-compose.yml`, `CONTRIBUTING.md`

**The config, with the three settings that carry the design:**

```yaml
# Authorise EVERY publish and EVERY read against our own API. Without this,
# access control is "the RTMP path is hard to guess", which is not access
# control. See the design spec §5.
authMethod: http
authHTTPAddress: http://host.docker.internal:3000/webhooks/mediamtx/auth
authHTTPExclude: []

paths:
  all_others:
    # The publisher started / stopped. These are the real hook names: there is
    # no runOnPublish or runOnUnpublish, whatever the MVP spec says. They are
    # SHELL COMMANDS, so they curl our API rather than MediaMTX posting to it.
    runOnOnline: >
      curl -sS -X POST http://host.docker.internal:3000/webhooks/mediamtx/lifecycle
      -H "X-Mediamtx-Secret: $MEDIAMTX_WEBHOOK_SECRET"
      -H "Content-Type: application/json"
      -d "{\"hook\":\"online\",\"streamKey\":\"$MTX_PATH\"}"
    runOnOnlineRestart: no
    runOnOffline: >
      curl -sS -X POST http://host.docker.internal:3000/webhooks/mediamtx/lifecycle
      -H "X-Mediamtx-Secret: $MEDIAMTX_WEBHOOK_SECRET"
      -H "Content-Type: application/json"
      -d "{\"hook\":\"offline\",\"streamKey\":\"$MTX_PATH\"}"
```

**Ports, and the asymmetry is deliberate:** RTMP `1935` is published publicly because OBS connects
from outside and publish authorisation protects it. HLS `8888` binds to `127.0.0.1` only and nginx
proxies to it — exposing it publicly would let anyone fetch segments without read authorisation,
which is the entire mechanism.

Document in `CONTRIBUTING.md`: how to run MediaMTX locally, the nginx location block needed on the
server, and that `host.docker.internal` needs
`extra_hosts: ["host.docker.internal:host-gateway"]` on Linux.

- [ ] **Steps:** bring it up locally, publish a test pattern with `ffmpeg`, confirm the auth
  endpoint is hit and refuses an unknown key → commit
  `"feat(infra): run MediaMTX with API-authorised publish and read"`.

---

### Task 7: The creator's streaming UI

**Files:**
- Create: `apps/web/src/dashboard/pages/EventsPage.tsx` + test
- Modify: `apps/web/src/App.tsx`, `apps/web/src/dashboard/ui.tsx`, `types.ts`, `styles.css`

A **Siaran langsung** tab on a community: schedule a session, and once created show the **RTMP URL
and stream key** with copy buttons and setup instructions for OBS, plus the current status.

**The stream key is a secret displayed on screen.** It gets the same treatment as any credential:
never logged, never in a URL, and the page must not render it for a community the creator does not
own (the API already 404s; the UI must not assume otherwise).

Hide the tab entirely when streaming is not configured server-side, the way the co-builder's nav
entry is hidden — reuse that pattern rather than inventing a second one.

- [ ] **Steps:** failing tests (renders the key only after creation; copy buttons; hidden when
  disabled; Indonesian copy) → implement → root gates → commit
  `"feat(web): add the creator's live streaming screen"`.

---

### Task 8: The watch page

**Files:**
- Create: `apps/web/src/pages/WatchPage.tsx` + test
- Modify: `apps/web/src/App.tsx`, `apps/web/src/pages/StatusPage.tsx`, `apps/web/src/api.ts`
- Modify: `apps/api/src/routes/public-subscription.ts` (a live-session field on the status payload)

`/watch/:token` plays the HLS stream with `hls.js` — the **one new dependency this plan adds**,
because Safari plays HLS natively and Chrome and Firefox do not.

The member's existing subscription status page gains a **"Tonton sekarang"** link whenever their
community has a live event, carrying a freshly minted token. That page is the only place a member
can reach a stream until Fonnte is configured, so it is not optional polish.

**Errors are one message.** An expired token, a token for another community, and a cancelled
subscription all render the same "tautan sudah tidak berlaku" — never reveal which.

- [ ] **Steps:** failing tests (renders a player for a valid token; the single error message for
  each failure mode; the status page shows the link only while live) → implement → root gates →
  commit `"feat(web): add the member watch page"`.

---

### Task 9: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green.
- [ ] Kill stale Vite, API, worker and MediaMTX processes first; start everything fresh.
- [ ] **In a real browser, recording actual output:**
  1. schedule a session, copy the RTMP URL and key
  2. publish with `ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine -c:v libx264 -preset veryfast -c:a aac -f flv "rtmp://localhost:1935/live/<key>"`
  3. confirm the event flips to `live` and an activity row appears
  4. open the member's status page, follow "Tonton sekarang", and **see the test pattern play**
  5. stop `ffmpeg`; confirm the event flips to `ended`
- [ ] **Publish with a wrong key and confirm MediaMTX refuses**, and that nothing is written.
- [ ] **Cancel the subscription while the stream is playing** and confirm playback stops failing
      authorisation on the next segment — the §5.2 property, driven for real.
- [ ] Confirm the stream key and the watch token appear in **no** log line and no URL beyond the
      watch URL itself.
- [ ] Run the full suite **3 times**; no flakes.
