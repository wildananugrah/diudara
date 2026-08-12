# Browser Publishing (WHIP) — Design Spec

Date: 2026-08-12
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-11-live-streaming-design.md`
Builds on: the live-streaming phase, merged to `main` as `1dc3067` (PR #2).

## 1. Purpose

Today a creator can only go live through OBS or Streamlabs: install software, find the RTMP
URL and stream key, paste both in, configure a scene. For a tutor who wants to talk to their
class for twenty minutes, that is most of the friction in the product.

This phase adds a second way in: **click a button in the dashboard, allow camera and
microphone, and broadcast.** The existing RTMP path stays exactly as it is — a creator chooses
which suits them.

## 2. What does not change, which is most of it

A browser publish arrives at MediaMTX as just another publisher. Everything downstream is
untouched:

- the session, its `stream_key`, and `ScheduleLiveSession`
- `runOnOnline` / `runOnOffline`, so the event still flips `live` then `ended`
- the notify-members outbox fan-out
- watch tokens, the entitlement re-check, and the nginx `auth_request` proxy
- HLS playback and the member watch page

**Members see no difference.** They watch over HLS exactly as they do now, at the same latency.
This phase changes how video gets *in*, not how it gets out.

## 3. Scope

**In scope:**
- WebRTC (WHIP) ingest enabled on MediaMTX, proxied through nginx
- A **Siaran dari browser** flow on the existing Siaran langsung tab: device selection,
  preview, go live, stop
- Camera and microphone capture only
- The UI making the choice between browser and OBS/Streamlabs explicit
- Refusing a second publisher clearly rather than failing obscurely

**Out of scope, with why:**
- **Screen sharing.** Deliberately deferred. It is the obvious next request for a tutoring
  product, but it doubles the capture UI (source switching, what happens to the camera while
  sharing) and behaves differently across browsers. Ship talking-head first.
- **WHEP browser playback.** Sub-second latency for members is a real prize, but it would put
  every viewer on the WebRTC path. Prove WebRTC works on this network with one publisher before
  betting all playback on it.
- **TURN relay.** Restrictive networks that block UDP will fail (§7). A TURN server is its own
  operational commitment.
- **Recording, bitrate control, scenes.** OBS exists for creators who need them.

## 4. Authentication needs no new mechanism

This is the part that could have been hard and is not.

MediaMTX authorises WebRTC publishes through the same `authHTTPAddress` the API already
answers, and the WHIP URL carries the **stream key in its path** — so `AuthoriseStream`'s
existing publish branch runs unchanged: the key must resolve to an event whose status is
`scheduled` or `live`. An `ended` session still cannot be republished.

**Putting the stream key in the creator's browser is not the exposure the last phase closed.**
That work stopped the key reaching *members*, who see only an event id. The creator owns the
key — the dashboard already displays it for OBS — so it is theirs to hold.

Two consequences to implement deliberately:

- The WHIP signalling endpoint is proxied through nginx over 443, so it is TLS-protected and
  behind the existing setup. That location gets **`access_log off`**, because the stream key
  travels in the URL — the same rule the HLS location already follows.
- `getUserMedia` requires a secure context, so the dashboard being HTTPS is a hard prerequisite,
  not a nicety.

## 5. The networking, which is the actual work

RTMP is one TCP connection. WebRTC is not, and this is where the phase can fail.

**Signalling** is HTTP: the browser POSTs an SDP offer to the WHIP endpoint and gets an answer.
That rides on 443 through nginx and is unremarkable.

**Media is UDP on port 8189** (`webrtcLocalUDPAddress`), direct from the browser to the server.
Two things follow, and neither is optional:

- **8189/UDP must be open** on the host firewall *and* at the VPS provider's network layer. The
  RTMP port needed exactly this and the provider's firewall was the thing that blocked it, so
  expect the same.
- **`webrtcAdditionalHosts` must contain the server's public IP.** ICE candidates are how the
  browser learns where to send media; without the public address it will negotiate an
  unreachable path and fail with no useful error.

**Cloudflare is not involved in the media path.** The proxy only forwards HTTP ports, which is
why RTMP needed a DNS-only subdomain. Media goes straight to the server's IP, so the existing
`stream.mhamzah.id` record is the natural host for it.

**TCP fallback** (`webrtcLocalTCPAddress`) exists and needs 8189/TCP open as well. MediaMTX
prefers UDP; TCP is there for networks that block it.

**One thing the implementer must verify rather than assume: the exact WHIP endpoint path.**
MediaMTX's own browser publish *page* is `/<path>/publish`; the WHIP ingest endpoint is a
different URL. Get it from MediaMTX's documentation, not from this spec. This project has been
wrong three times about MediaMTX specifics that were written down without being run — the hook
names, the image having no shell, and per-session auth caching.

## 6. The creator chooses, and only one publisher wins

The Siaran langsung tab presents both paths for a session:

- **Siaran dari browser** — device pickers, a live preview, and a go-live button
- **OBS / Streamlabs** — the RTMP URL and stream key with copy buttons, as today

**MediaMTX refuses a second concurrent publisher**, so only one can be live at a time. If the
session is already being published, the browser button must say so plainly rather than starting
a WebRTC negotiation that fails with a stack trace. `event.status` already distinguishes
`scheduled` from `live`, which is the signal the UI needs.

## 7. Errors

| Condition | Behaviour |
|---|---|
| Camera or microphone permission denied | A clear Indonesian message saying access is needed and how to grant it — never a raw browser error |
| No camera or microphone present | Say so before offering to go live, rather than failing at the negotiation |
| Session already `live` (OBS is publishing) | The browser button is disabled with an explanation |
| Session already `ended` | Publish is refused by the existing authorisation; the UI says the session is finished and offers to schedule a new one |
| WebRTC negotiation fails | A message naming the likely cause — a network blocking UDP — and pointing at OBS as the alternative |
| The creator closes the tab | Publishing stops, `runOnOffline` fires, the session ends. Same as OBS disconnecting (§8) |

## 8. Honest limitations

**Quality is worse than OBS.** No scenes, no bitrate control, no overlays. Browser capture is
for convenience, not production.

**Networks that block UDP will fail**, with no fallback short of TURN. Corporate and campus
networks are the common case. The UI must point those creators at OBS rather than leaving them
stuck.

**Closing the tab ends the session permanently.** The live-streaming phase deliberately deferred
a fix for `runOnOffline` firing on any disconnect, and browser publishing makes it sharper: a
tab is far easier to close by accident than OBS is to quit. This phase does not fix that, and
the UI should warn before leaving while live.

**iOS remains the weakest surface.** Safari's WebRTC support for publishing exists but is the
least tested path here, and the last phase already left real-device iOS verification open.

## 9. Configuration

MediaMTX gains WebRTC settings in `infra/mediamtx.yml`: the WebRTC address, `webrtcAdditionalHosts`
with the public IP, and explicit local UDP configuration. The API gains one variable for the
WHIP base URL the browser should publish to, following the same all-or-nothing rule as the other
streaming variables — set with the rest or not at all, and absent configuration disables browser
publishing while leaving RTMP working.

## 10. Testing

- Unit tests for the publish-URL construction, mirroring the existing adapter's tests.
- Component tests for the capture UI: permission denied, no devices, session already live,
  session ended — each rendering its own message.
- A test that the browser path is hidden or disabled when browser publishing is unconfigured,
  matching how the streaming tab itself is hidden.
- **An end-to-end pass in a real browser**: publish from the dashboard, confirm the event flips
  to `live`, open the member watch page in a second browser and *see the video*, then stop and
  confirm the session ends. Anything less does not prove WebRTC negotiated.
- A deliberate check that a second publisher is refused while one is live.
