# Browser Publishing (WHIP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator clicks "Siaran dari browser", grants camera and microphone access, and goes
live — with OBS and Streamlabs still working exactly as they do now.

**Architecture:** MediaMTX gains WebRTC (WHIP) ingest alongside RTMP. The browser POSTs an SDP
offer to a WHIP endpoint proxied through nginx; media flows over UDP direct to the server.
Authorisation is unchanged — the WHIP URL carries the stream key, so `AuthoriseStream`'s existing
publish branch decides, and a browser publish arrives downstream as just another publisher.

**Tech Stack:** MediaMTX WebRTC, browser `RTCPeerConnection` + `getUserMedia`, Bun, Hono, Vite +
React, `bun:test`.

**Task order is deliberate:** the infrastructure task comes **first**, because whether WebRTC
negotiates at all on this network is the phase's real risk. Settle it before writing a UI against
an assumption.

## Global Constraints

From `docs/superpowers/specs/2026-08-12-browser-publishing-design.md`.

- **Camera and microphone only.** Screen sharing is explicitly out of scope.
- **The RTMP path must keep working unchanged.** This adds a second way in; it replaces nothing.
- **Authentication gains no new mechanism.** The WHIP URL carries the stream key in its path, so
  `AuthoriseStream`'s existing publish branch applies: `scheduled` or `live` allows, `ended`
  refuses. Do not add a second credential.
- **The WHIP location gets `access_log off`** — the stream key travels in the URL, the same rule
  the HLS location already follows.
- **`webrtcAdditionalHosts` must contain the server's public IP**, or ICE negotiates an
  unreachable path and fails with no useful error.
- **8189/UDP must be open** on the host firewall and at the VPS provider's network layer. The RTMP
  port needed exactly this and the provider's firewall is what blocked it.
- **No new dependency.** WHIP is an SDP offer POSTed with `fetch` and an `RTCPeerConnection` — the
  browser has everything needed. Do not add a WebRTC library.
- **Only one publisher at a time.** MediaMTX refuses a second concurrent publisher; the UI must
  say so rather than starting a negotiation that fails obscurely.
- **All copy in Bahasa Indonesia.**
- **Absent configuration disables browser publishing while leaving RTMP working** — the
  co-builder's pattern, not the payment adapter's.
- A failing `expect(<DOM element>).toBeNull()` **hangs `bun test`** (178 s, 335 MB); there is a
  source-scan guard at `apps/web/src/test/no-hanging-dom-assertions.test.ts`. Count elements or
  assert booleans.
- Root gates: `bun run test` and `bun run typecheck` from the repo root — **`bun run test`, never
  bare `bun test`**, which from the root produces ~123 spurious failures because `apps/web` needs
  its own bunfig preload.

---

### Task 1: WebRTC ingest on MediaMTX, proven with a real publish

**Files:**
- Modify: `infra/mediamtx.yml`, `infra/docker-compose.yml`, `infra/nginx/live-hls.conf.template`,
  `CONTRIBUTING.md`

**Interfaces:**
- Produces: the verified WHIP endpoint URL shape that Task 2 builds, and the public path nginx
  exposes it on. **Record the exact verified URL in your report** — Task 2 depends on it.

**Verify the endpoint rather than assuming it.** MediaMTX's browser publish *page* is
`/<path>/publish`; the WHIP ingest endpoint is a different URL. Get it from MediaMTX's own
documentation, and then confirm it by publishing for real. This project has been wrong three
times about MediaMTX specifics that were written down without being run — the hook names, the
image being `FROM scratch` with no shell, and read authorisation being cached per session. Do not
make it four.

**What to configure:**
- WebRTC enabled, with its HTTP address bound so nginx can reach it — following how `hlsAddress`
  is already treated, and **not** exposed publicly.
- `webrtcAdditionalHosts` containing the server's public IP.
- The media port published: **8189/UDP** by default (`webrtcLocalUDPAddress`).
- An nginx location proxying the WHIP endpoint, with `access_log off`.

**Ports, and the asymmetry matters:** the WHIP *signalling* endpoint is reached through nginx on
443 like the HLS one. The WebRTC *media* port 8189/UDP is direct to the server, because Cloudflare
does not proxy UDP — the same reason RTMP needed `stream.mhamzah.id`.

- [ ] **Steps:** configure → bring the stack up → **publish from a real browser** using MediaMTX's
  own publish page against a real session's stream key → confirm the auth webhook allowed it,
  `runOnOnline` fired, and the event flipped to `live` → confirm a wrong key is refused → stop and
  confirm `ended` → document the ports and the public-IP requirement in `CONTRIBUTING.md` →
  commit `"feat(infra): enable WebRTC (WHIP) ingest on MediaMTX"`.

**If WebRTC does not negotiate, stop and report rather than working around it.** A UI built on a
broken transport is worse than no UI, and the cause is likely one of: 8189/UDP closed at the
provider, the public IP missing from `webrtcAdditionalHosts`, or the browser on a network that
blocks UDP.

---

### Task 2: The WHIP URL through the port, adapter and API

**Files:**
- Modify: `apps/api/src/application/ports/streaming-provider.port.ts`
- Modify: `apps/api/src/infrastructure/streaming/mediamtx.adapter.ts`
- Modify: `apps/api/src/infrastructure/streaming/fake-streaming.adapter.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/.env.example`
- Modify: `apps/api/src/application/use-cases/schedule-live-session.ts` and the events route
- Test: the adapter, fake, bootstrap and route tests

**Interfaces:**
- Consumes: Task 1's verified WHIP URL shape.
- Produces: `StreamingProviderPort.createSession({ streamKey })` gains **`whipUrl: string`**
  alongside the existing `rtmpUrl` and `hlsPlaybackPath`. `ScheduleLiveSession`'s result and the
  events endpoints carry it through to the dashboard.

The adapter today is:

```ts
createSession(input: { streamKey: string }): { rtmpUrl: string; hlsPlaybackPath: string } {
  return {
    rtmpUrl: `rtmp://${this.rtmpHost}:${RTMP_PORT}/live/${input.streamKey}`,
    hlsPlaybackPath: `${this.hlsBaseUrl}/live/${input.streamKey}/index.m3u8`,
  };
}
```

Extend it in the same shape, from a new `whipBaseUrl` constructor value. Keep the trailing-slash
stripping rule the constructor already applies to `hlsBaseUrl`, and say why in a comment.

**Configuration:** one new variable for the WHIP base URL, following the all-or-nothing rule its
neighbours use — set with the rest of the streaming variables or not at all, partial configuration
throws in every environment, and **absent streaming configuration still disables the feature
without blocking boot.**

**The stream key is in this URL**, exactly as it is in the RTMP URL. It goes to the creator who
owns the community and nobody else — never to a member, never in a log line. The last phase
separated the *member's* playback path from the key; this does not undo that, because the WHIP URL
never reaches a member.

- [ ] **Steps:** failing tests (URL construction for the verified shape; trailing slash stripped;
  the fake mirrors the real adapter's shape exactly; the selector still returns a disabled feature
  outside `RELAXED_NODE_ENVS` with a garbage value — the Phase 3 shape this project shipped twice;
  the events response carries `whipUrl` for the owner and 404s for a stranger) → implement → root
  gates → commit `"feat(streaming): expose a WHIP publish URL for browser broadcasting"`.

---

### Task 3: Going live from the browser

**Files:**
- Create: `apps/web/src/dashboard/whip-publisher.ts` + test
- Modify: `apps/web/src/dashboard/pages/EventsPage.tsx` + test
- Modify: `apps/web/src/dashboard/types.ts`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `whipUrl` from Task 2's events response.
- Produces: `publishToWhip({ whipUrl, stream, fetchFn? }): Promise<{ close(): void }>` — a pure
  module doing the SDP exchange, with `fetchFn` injected so it is testable without a network,
  exactly as `XenditPaymentAdapter` injects one.

**`getUserMedia` requires a secure context**, so camera access works on `https://` and on
`http://localhost` — which browsers exempt — but on nothing else. That means the Vite dev server
is fine and production is fine, while testing from another device against your laptop's LAN
address over plain HTTP will fail with a permission error that looks like the user denied access.
Say so in a comment; it is a confusing failure to meet cold.

**Keep the WHIP mechanics out of the component.** The SDP offer/answer exchange is testable logic;
device permission and preview are React. Splitting them means the negotiation can be unit-tested
and the component tested against a fake.

**The screen**, on the existing Siaran langsung tab, presenting both paths for a session:

- **Siaran dari browser** — device pickers for camera and microphone, a muted local preview, and a
  go-live button. While live: a stop button, and a warning before leaving the page.
- **OBS / Streamlabs** — the RTMP URL and stream key with copy buttons, exactly as today.

**Each failure gets its own Indonesian message**, and this is most of the task's value:
permission denied (say how to grant it), no camera or microphone present (say so *before*
offering to go live), the session already `live` because OBS is publishing (disable the button and
explain), the session already `ended` (offer to schedule a new one), and a failed negotiation
(name the likely cause — a network blocking UDP — and point at OBS).

**Closing the tab ends the session permanently.** That is the deferred limitation from the
previous phase, and a browser tab is far easier to close by accident than OBS is to quit. Warn
before unload while publishing.

- [ ] **Steps:** failing tests (the SDP exchange against an injected `fetchFn`; each failure state
  rendering its own message; the browser button disabled while a session is `live`; the path hidden
  when browser publishing is unconfigured) → implement → **drive it in a real browser** → root
  gates → commit `"feat(web): let a creator go live from the browser"`.

---

### Task 4: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green.
- [ ] Kill stale Vite, API, worker and MediaMTX processes first; start everything fresh.
- [ ] **In a real browser, recording actual output:**
  1. schedule a session, choose **Siaran dari browser**, grant camera and microphone
  2. see the local preview, go live
  3. confirm the event flips to `live` and an `activity_log` row appears
  4. **open the member watch page in a second browser and see the video playing**
  5. stop, and confirm the event flips to `ended`
- [ ] **Confirm OBS still works** against a fresh session — this phase must not have broken it.
- [ ] **Confirm a second publisher is refused** while one is live, and that the UI says so rather
      than failing obscurely.
- [ ] Confirm the stream key appears in **no** log line — including nginx's access log for the WHIP
      location, which is why it is `access_log off`.
- [ ] Run the full suite **3 times**; no flakes. If a transient failure appears, capture which test
      and what error — five sightings in this project have been recorded and only one was ever
      named.
