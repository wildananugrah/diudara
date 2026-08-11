# Live Streaming — Design Spec

Date: 2026-08-11
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phases 1-7 (merged), plus the landing page and the self-hosted deploy workflow.

## 1. Purpose

A creator goes live to their paying members, and only their paying members can watch. The
recording is kept and replayable under the same rule.

`event` has carried the columns for this since Phase 1 — `stream_key` with a unique partial
index, `status`, `hls_playback_path`, `recording_url` — dormant, waiting for this phase.

## 2. Three corrections to the parent spec, established by reading MediaMTX's documentation

The MVP spec (§8.5) was written before anyone read MediaMTX's manual. Three of its assumptions
are wrong, and the design changes accordingly.

**There is no `on-publish` or `on-unpublish` webhook.** The hooks are `runOnAvailable` then
`runOnOnline` when a publisher starts, and `runOnOffline` then `runOnUnavailable` when it stops.
This phase uses `runOnOnline` and `runOnOffline` as the lifecycle edges.

**Hooks are shell commands, not HTTP callbacks.** MediaMTX does not POST to us; it runs a command
and hands it `MTX_PATH` (the stream key) in the environment. So each hook is a `curl` against our
own API, carrying a shared secret header exactly like the Xendit and Telegram webhooks do.

**MediaMTX can ask us for an authorisation decision on every publish and every read**
(`authMethod: http` with `authHTTPAddress`). The parent spec assumed access control had to be
bolted on around MediaMTX. It does not, and that changes §5 substantially for the better.

## 3. Scope

**In scope:**
- `mediamtx` service in `infra/docker-compose.yml`: RTMP ingest, HLS output, recording to disk
- `StreamingProviderPort` + `MediaMtxAdapter` + a fake
- `StoragePort` + `S3StorageAdapter` (Biznet Gio NEO Object Storage) + a fake
- Scheduling a session, going live, ending, and the creator UI for all three
- Publish authorisation, read authorisation, and signed per-member watch tokens
- `/watch/:token` with `hls.js`
- Recording upload to object storage, and gated replay
- A "Tonton sekarang" link on the member's existing subscription status page

**Out of scope, with why:**
- **Transcoding and adaptive bitrate.** Single-quality passthrough, as the parent spec chose. A
  transcode ladder multiplies CPU by the number of renditions on a box that also runs the API,
  the worker and Postgres.
- **Chat, reactions, viewer counts.** None of it gates access or takes money.
- **RSVP.** The parent spec mentions "subscribers/RSVP'd members"; entitlement here is simply an
  active subscription, which is what the product already knows.
- **Multi-creator concurrency limits.** One VPS, low hundreds of viewers total (§9).

## 4. The lifecycle

1. **Schedule.** The creator creates an event with a title and optional time. `ScheduleLiveSession`
   mints a fresh `stream_key` (`openssl rand`-grade, unique) and returns the RTMP URL and key for
   OBS. `status = scheduled`.
2. **Go live.** The creator publishes to `rtmp://<host>:1935/live/<stream_key>`. MediaMTX asks our
   API to authorise the publish (§5.1). `runOnOnline` then curls the lifecycle endpoint;
   `HandleStreamPublished` sets `status = live`, records `hls_playback_path`, writes an
   `activity_log` row, and enqueues an outbox row to notify members.
3. **Watch.** A member opens `/watch/:token`. `hls.js` requests the playlist and segments;
   MediaMTX asks our API to authorise **each read** (§5.2).
4. **End.** The creator stops publishing. `runOnOffline` fires; `HandleStreamEnded` sets
   `status = ended` and writes `activity_log`.
5. **Recording.** `runOnRecordSegmentComplete` curls the API with the finished file path, which
   enqueues an outbox row. **The worker uploads it** — long, retryable I/O belongs where every
   other retryable side effect in this codebase already lives. On success, `recording_url` is set.

## 5. Access control

### 5.1 Publishing

MediaMTX calls our API for every publish attempt. We authorise only if the path resolves to an
`event` whose `stream_key` matches and whose `status` is `scheduled` or `live`.

This is stronger than the parent spec's implicit model, where secrecy of the RTMP path was the
only protection. A key that has already ended cannot be republished, and revoking a session is a
database update rather than a MediaMTX restart.

**The cost, stated plainly:** if the API is down, nobody can start a stream. That is the correct
failure direction — a stream that nobody can be authorised to watch is worth less than one that
cannot start.

### 5.2 Watching, and the entitlement re-check

A watch token is a **signed, time-limited token identifying a subscription** — not a bearer grant
of access. On every read authorisation, the API verifies the signature and expiry **and then
re-checks that the subscription is still active**.

That second half is not redundant, and this project has already paid for learning it: Phase 5
shipped a Critical where `RevokeChannelAccessForSystem` was the one outbox consumer that did not
re-check entitlement. A member who churns mid-stream must stop being able to watch, and a token
minted before they churned must not outlive their subscription.

Tokens are stateless (HMAC over subscription id, event id and expiry) precisely *because*
entitlement is re-checked live — there is no revocation list to maintain, because the
subscription itself is the source of truth.

**Lifetime: 6 hours.** Long enough for any realistic session plus overrun, short enough that a
leaked URL is not a permanent key. Replay access re-mints a token on each visit to the status
page.

### 5.3 What a leaked token gets you

Honest limit: a token shared with a non-member lets that person watch until it expires, because
the token identifies a *subscription*, not a device or a person. Binding to an IP or a device
would break the common case of a member opening the link on their phone after checking out on a
laptop. This is the same tradeoff the product already accepts for Telegram invite links.

## 6. Storage

Biznet Gio NEO Object Storage, which is S3-compatible: `region: "idn"` with a custom endpoint.
The adapter is written against the S3 API, so **the provider is configuration, not code** — the
same adapter works against IDCloudHost or AWS by changing environment variables.

**A deployment detail that will bite if missed:** MediaMTX runs in Docker and writes recordings
into a container path, while the worker runs on the host under pm2. They must share a real
directory — the compose service mounts a host path, and the worker reads from that same path.
Without it, the upload step finds nothing and the failure looks like a storage problem rather
than a mount problem.

**The other deployment detail:** the browser reaches HLS through nginx, not by talking to
MediaMTX directly. MediaMTX's HLS port (8888) stays bound to localhost, and nginx proxies a public
path to it — the same shape as the existing API proxy. Exposing 8888 publicly would let anyone
fetch segments without passing through the read authorisation in §5.2, which is the entire access
control mechanism. RTMP (1935) is different: it must be publicly reachable, because the creator's
OBS connects to it from outside, and it is protected by publish authorisation instead.

## 7. Configuration

New environment variables, following the `RELAXED_NODE_ENVS` allowlist Phase 3 established:

- `MEDIAMTX_RTMP_HOST`, `MEDIAMTX_HLS_BASE_URL` — what the creator's OBS and the member's browser
  are told to use.
- `MEDIAMTX_WEBHOOK_SECRET` — the shared secret on both MediaMTX endpoints. At least 32
  characters. It is the only thing authenticating them, exactly like `XENDIT_CALLBACK_TOKEN`.
- `STREAM_TOKEN_SECRET` — HMAC key for watch tokens. At least 32 characters, and **not**
  `JWT_SECRET`: a different audience, a different lifetime, and a compromise of one should not be
  a compromise of the other.
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — set
  together or not at all, and partial configuration throws in every environment, matching the
  Xendit and messaging selectors.

Absent streaming configuration must **not** block boot — it follows the AI co-builder's pattern
(§11 of the Phase 7 spec), not the payment adapter's: the product works without streaming, so the
API boots with the feature disabled and the creator UI hidden.

## 8. Errors

| Condition | Behaviour |
|---|---|
| Publish with an unknown or ended stream key | MediaMTX refuses the publish; nothing is written |
| Watch token invalid, expired, or malformed | 403, and the page says the link expired rather than that the stream does not exist |
| Watch token valid but the subscription is no longer active | 403, same message — never reveal another member's state |
| Stream ends while a member is watching | The player shows that the session ended; replay appears when the upload completes |
| Upload to object storage fails | Outbox retries; `recording_url` stays null and the event is still `ended` |
| Streaming not configured | The creator's streaming UI is hidden, exactly as the co-builder's is |

## 9. Honest limitations

**Bandwidth is the ceiling, and it is low.** One VPS serving single-quality HLS realistically
supports **low hundreds** of concurrent viewers. 100 viewers at 2 Mbps is 200 Mbps sustained and
roughly 90 GB per hour of transfer. Before this is promised to creators, check the VPS's actual
bandwidth allowance — this is a hosting-plan question, not a code question.

**Two more unverified adapters.** `MediaMtxAdapter` and `S3StorageAdapter` join Xendit, Telegram
and Fonnte. MediaMTX is at least self-hostable, so it *can* be exercised locally; Biznet Gio
cannot be until an account exists.

**Streaming is being built before the product has ever taken a real payment.** Xendit, Telegram
and Fonnte remain unverified. A creator can therefore stream to members who were activated by a
fake payment adapter. This was raised and the sequencing was chosen deliberately; it is recorded
here so nobody later reads this phase as evidence the core flow was proven.

## 10. Testing

- Use-case tests against fakes for every lifecycle transition, including out-of-order hooks —
  MediaMTX can fire `runOnOffline` for a session the API never saw go online.
- A publish authorisation test per state: `scheduled` allows, `live` allows, `ended` refuses,
  unknown key refuses.
- **A read authorisation test where the subscription is cancelled between minting the token and
  using it** — the entitlement re-check of §5.2, and the specific defect Phase 5 shipped.
- Signature and expiry tests, including a token signed with the wrong secret and one whose
  payload was edited.
- Cross-community: a member of community A cannot watch community B's stream, and the response
  leaks nothing.
- An end-to-end pass with a real MediaMTX in Docker: publish with `ffmpeg`, watch the HLS output,
  stop, and confirm the recording lands.
