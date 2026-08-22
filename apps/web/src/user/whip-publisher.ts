/**
 * The WHIP (WebRTC-HTTP Ingestion Protocol) SDP offer/answer exchange, kept
 * OUT of any React component on purpose (Task 3 brief): device permission and
 * the local preview are UI concerns, but "build an offer, POST it, apply the
 * answer, wait for the connection to actually come up, remember the session
 * URL to tear down later" is pure negotiation logic that does not need a DOM
 * to test.
 *
 * `fetchFn` is injected exactly the way `XenditPaymentAdapter`
 * (apps/api/src/infrastructure/payments/xendit-payment.adapter.ts) injects
 * one — so this module's tests exercise the real request/response shapes
 * without a network, and without a real `RTCPeerConnection` either: tests
 * install a fake `RTCPeerConnection` on `globalThis` before calling this
 * function, the same way a browser provides a real one. This module never
 * constructs the connection any other way, so a real browser and a test both
 * go through the identical code path.
 *
 * The endpoint itself — `POST https://<host>/whip/<streamKey>`, answered with
 * SDP and a `Location` header naming a session sub-resource to `DELETE` on
 * stop — is Task 1 and Task 2's verified shape (see CONTRIBUTING.md's
 * "Browser publishing (WebRTC / WHIP)" section and
 * infra/nginx/whip-proxy-test/negotiate.mjs, the harness that proved it
 * against a real nginx + MediaMTX). This module does not construct that URL;
 * it is handed `whipUrl` exactly as the API returns it.
 *
 * ====================== FIX ROUND 1 — "success" used to mean "the POST worked" ======================
 * Review found that this function used to resolve the instant
 * `setRemoteDescription` returned, which only proves the SIGNALLING
 * succeeded — the SDP round trip. On a network that blocks the UDP traffic
 * WebRTC actually needs to move media (a common corporate/campus-network
 * shape), that HTTPS POST still succeeds, MediaMTX still answers 201, and
 * `setRemoteDescription` still resolves — while ICE never connects and no
 * frame ever arrives. The UI would show "live" over a dead stream. Now this
 * function ALSO awaits the peer connection's own `connectionState` reaching
 * `"connected"`, bounded by `CONNECT_TIMEOUT_MS`, and treats `"failed"` or a
 * timeout as a negotiation failure — which is what makes the UDP/OBS message
 * fire for the case the brief actually named, not just for a fetch that
 * threw. It also keeps listening after a successful connect, so a mid-stream
 * drop (`onDisconnected`) surfaces instead of leaving a live badge over
 * nothing.
 * =======================================================================
 *
 * ====================== FIX ROUND 2 — two more real-browser findings ======================
 * N2: `onDisconnected` used to fire once per QUALIFYING STATE TRANSITION,
 * not once per drop — a real connection failure was measured going
 * `"failed"` then `"closed"`, firing the callback TWICE for one drop.
 * `EventsPage.tsx`'s handler runs `unregisterUnloadWarning()` each time,
 * which is exactly the double-decrement the ref-COUNTER (not a boolean) was
 * introduced to survive when TWO ROWS are live at once: two calls from one
 * row's single drop wrongly decrements the shared counter twice, silencing
 * the warning for a second row that is still genuinely broadcasting. Fixed
 * with a `notifiedDisconnected` flag scoped to this one `publishToWhip`
 * call — `onDisconnected` is now guaranteed at most once per publish,
 * regardless of how many qualifying events the underlying connection fires,
 * which is the version of this fix that holds even if some future caller
 * is not itself idempotent.
 *
 * N4: the connect check depended on `connectionState` alone, which some
 * RTCPeerConnection implementations (older Firefox, Safari) do not expose
 * at all — on those, `connectionState` reads `undefined` forever, so a
 * publish that was actually working would wait the full `CONNECT_TIMEOUT_MS`
 * and then show the UDP/OBS message, a false negative in the OPPOSITE
 * direction from Fix Round 1's Critical 1. `hasConnected`/`hasFailed` below
 * now fall back to `iceConnectionState` (`"connected"`/`"completed"` count as
 * success, matching how `connectionState` unifies them) whenever
 * `connectionState` is undefined, and both `connectionstatechange` AND
 * `iceconnectionstatechange` are listened for so the fallback actually
 * fires on a browser that never dispatches the former.
 * =======================================================================
 *
 * ====================== FIX ROUND 3 — "connected" is not "sending video" ======================
 * Observed in production, on `diudara.mhamzah.id`: a creator published from
 * Firefox. The UI showed "Hentikan siaran" and the don't-close-this-tab
 * warning — every signal Fix Rounds 1 and 2 above check said this publish
 * was healthy. MediaMTX's own log told the real story:
 *
 *   INF [path live/<key>] stream is available and online, 1 track (Opus)
 *
 * One track. Audio only. Firefox's H264 encoder depends on Cisco's OpenH264
 * binary being present on the machine — `preferH264` below only REORDERS
 * codec preferences and, correctly, does not restrict the offer to H264 when
 * it is missing (see that function's own docstring on why restricting would
 * be worse). But when H264 is unavailable AND the server-negotiated codec is
 * one Firefox also cannot actually encode, the browser can end up with a
 * video transceiver that never produces a single RTP packet — while ICE and
 * signalling both report total success, because they never carried video in
 * the first place. Nothing before this fix ever checked that video SPECIFICALLY
 * was moving, only that the CONNECTION was up. The creator spent an hour
 * chasing server config before the MediaMTX log revealed it; their own screen
 * never said anything was wrong.
 *
 * `verifyVideoIsFlowing` below runs once `waitForConnection` succeeds and
 * checks `RTCRtpSender.getStats()` for the video sender specifically —
 * `bytesSent` staying at zero for a couple of seconds after "connected" means
 * no video is reaching the server, full stop, regardless of what the
 * connection state says. Two distinguishable failures, because a creator's
 * next move differs slightly by cause (see the two message constants below
 * and `verifyVideoIsFlowing`'s own docstring): no video sender existed at all
 * (nothing to send in the first place) vs. a video sender existed and never
 * transmitted (the Firefox/OpenH264 case actually observed). Feature-detected
 * exactly like `preferH264` — a browser without `getSenders`/`getStats`
 * publishes exactly as before this fix; this is a diagnostic added on top of
 * a working path, never a new way for a working path to fail.
 * =======================================================================
 */

/** Matches `XenditPaymentAdapter`'s own `FetchFn` shape exactly. */
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface PublishHandle {
  /**
   * Stops publishing: closes the local `RTCPeerConnection` immediately (the
   * browser stops sending media the instant this returns) and best-effort
   * `DELETE`s the WHIP session sub-resource so MediaMTX tears down its side
   * without waiting for the ICE connection to time out. The `DELETE`'s
   * failure is swallowed and NEVER logged (not even to the console) — the
   * target URL carries the stream key, and `pc.close()` above has already
   * genuinely stopped the stream, so a failed cleanup call means only that
   * MediaMTX notices a little later than it otherwise would have, never that
   * the stream keeps running. Telling the creator anything here would be
   * both false (the stream DID stop) and unactionable.
   */
  close(): void;
}

/**
 * Every failure this module can throw carries an Indonesian, creator-facing
 * message already — see `EventsPage.tsx`'s docstring on why each failure
 * needs its own wording. Callers can show `error.message` directly rather
 * than re-translating a generic Error.
 */
export class WhipNegotiationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WhipNegotiationError";
  }
}

/**
 * How long to wait for ICE candidate gathering before sending the offer
 * anyway. Mirrors `infra/nginx/whip-proxy-test/negotiate.mjs`'s own 4s
 * timeout — trickle ICE is not implemented here (this is a one-shot POST,
 * not a PATCH-based trickle exchange), so an offer sent before gathering
 * finishes would carry fewer candidates than it could, but gathering that
 * takes longer than this is unusual enough that a creator waiting to go live
 * matters more than holding out for one more candidate.
 */
const ICE_GATHERING_TIMEOUT_MS = 4000;

/**
 * How long to wait for the peer connection to actually reach `"connected"`
 * after the SDP answer is applied, before treating this as a failed
 * negotiation (Fix Round 1, Critical 1). On the order the review asked for
 * (10-15s): long enough that a slow but working ICE check does not get
 * cut off, short enough that a creator on a UDP-blocking network is not left
 * staring at "Menghubungkan..." for a minute before finding out it never
 * would have worked.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long the signalling POST itself may hang before this gives up on it. */
const SIGNALLING_TIMEOUT_MS = 20_000;

/**
 * How long to keep polling the video sender's `getStats()` for evidence of
 * `bytesSent > 0` before concluding video is not really flowing (Fix Round
 * 3). "A couple of seconds" per the observed defect — long enough that a
 * genuinely working encoder's first RTP packets are not mistaken for a
 * failure, short enough that a creator is not left staring at "Menghubungkan…"
 * for anywhere near as long as `CONNECT_TIMEOUT_MS`.
 */
const VIDEO_FLOW_CHECK_TIMEOUT_MS = 2_000;

/** How often `verifyVideoIsFlowing` re-checks `getStats()` inside that window. */
const VIDEO_FLOW_POLL_INTERVAL_MS = 250;

/**
 * Fix Round 3, case 1: no video `RTCRtpSender` existed for this publish at
 * all — this browser had nothing to offer the server for video in the first
 * place, so there was never anything the server could have accepted. See
 * `verifyVideoIsFlowing`'s own docstring for how this is told apart from
 * `VIDEO_NOT_SENDING_MESSAGE` below, and why the remedy is the same either
 * way: a creator has no way to tell "nothing was offered" from "something was
 * offered and quietly failed" without reading a server log, so both point at
 * the same two ways out.
 */
const NO_VIDEO_TRACK_MESSAGE =
  "Siaran ini akan tayang tanpa gambar — peramban ini tidak berhasil menyertakan video sama " +
  "sekali saat terhubung ke server siaran, sehingga penonton nantinya hanya akan mendengar " +
  "suara tanpa gambar. Coba mulai siaran dari Chrome atau Edge, atau gunakan OBS / Streamlabs " +
  "sebagai alternatif.";

/**
 * Fix Round 3, case 2 — the message for the ACTUAL defect observed in
 * production (see this file's own "FIX ROUND 3" docstring above): a video
 * sender existed and the connection reported "connected", but not one byte
 * of video ever left the browser. Names Firefox and explains, in one clause,
 * what a "codec" is (a way of packing video so it can be sent) rather than
 * using the word bare — a creator meeting this screen has never heard it.
 */
const VIDEO_NOT_SENDING_MESSAGE =
  "Siaran ini akan tayang tanpa gambar — video sudah tersambung ke server, tapi tidak ada data " +
  "video yang benar-benar terkirim (hanya suara). Penyebab paling umum adalah Firefox yang belum " +
  "memiliki komponen tambahan untuk mengemas video ke format yang bisa dikirim (dikenal sebagai " +
  "codec) di perangkat ini. Coba mulai siaran dari Chrome atau Edge, atau gunakan OBS / " +
  "Streamlabs sebagai alternatif.";

/**
 * Performs the WHIP offer/answer exchange for one publish AND waits for the
 * resulting connection to actually come up, returning a handle to stop it.
 * Every step that can fail is wrapped so the caller only ever sees a
 * `WhipNegotiationError` with an Indonesian message naming the likely cause —
 * a creator meeting this screen has never heard of SDP or ICE.
 */
export async function publishToWhip({
  whipUrl,
  stream,
  fetchFn = (url, init) => fetch(url, init),
  onDisconnected,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  videoFlowTimeoutMs = VIDEO_FLOW_CHECK_TIMEOUT_MS,
  videoFlowPollIntervalMs = VIDEO_FLOW_POLL_INTERVAL_MS,
}: {
  whipUrl: string;
  stream: MediaStream;
  fetchFn?: FetchFn;
  /**
   * Called if the connection drops AFTER a successful go-live — a
   * mid-broadcast failure, distinct from a failed initial negotiation
   * (which instead rejects this function's own returned promise and never
   * calls this). Never called for a stop the caller itself initiated via
   * the returned handle's `close()`.
   */
  onDisconnected?: () => void;
  /**
   * Overrides `CONNECT_TIMEOUT_MS`. Exists for tests (a "never connects"
   * fake would otherwise make a test wait out the real 15s production
   * value) — production callers should not pass this.
   */
  connectTimeoutMs?: number;
  /**
   * Overrides `VIDEO_FLOW_CHECK_TIMEOUT_MS` (Fix Round 3). Exists for tests
   * for the same reason `connectTimeoutMs` does — production callers should
   * not pass this.
   */
  videoFlowTimeoutMs?: number;
  /** Overrides `VIDEO_FLOW_POLL_INTERVAL_MS` (Fix Round 3) — tests only. */
  videoFlowPollIntervalMs?: number;
}): Promise<PublishHandle> {
  // `RTCPeerConnection` missing entirely (not every environment has WebRTC)
  // used to throw a raw, English `ReferenceError` straight out of this
  // function, breaking the all-Indonesian-message rule. Checked explicitly,
  // before anything that could throw natively.
  if (typeof RTCPeerConnection === "undefined") {
    throw new WhipNegotiationError(
      "Peramban ini tidak mendukung siaran langsung dari browser (WebRTC tidak tersedia). " +
        "Gunakan OBS / Streamlabs sebagai alternatif, atau buka dasbor ini dari Chrome, Edge, " +
        "atau Firefox versi terbaru."
    );
  }

  const pc = new RTCPeerConnection();
  let closedByCaller = false;

  try {
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    // BEFORE `createOffer` — `setCodecPreferences` only affects offers built
    // after it. See `preferH264` for the black-player defect this fixes.
    preferH264(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (localSdp === undefined || localSdp.length === 0) {
      throw new WhipNegotiationError(
        "Peramban ini gagal membuat penawaran koneksi siaran. Coba muat ulang halaman, " +
          "atau gunakan OBS / Streamlabs sebagai alternatif."
      );
    }

    const response = await fetchFn(whipUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: localSdp,
      signal: AbortSignal.timeout(SIGNALLING_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new WhipNegotiationError(
        `Server penyiaran menolak permintaan ini (status ${response.status}). Sesi ini ` +
          "mungkin sudah tidak bisa menerima siaran baru — muat ulang halaman untuk melihat " +
          "status terbaru, atau gunakan OBS / Streamlabs sebagai alternatif."
      );
    }

    const location = response.headers.get("Location");
    if (location === null) {
      throw new WhipNegotiationError(
        "Server penyiaran tidak mengirim alamat sesi yang diharapkan, sehingga siaran ini " +
          "tidak bisa dihentikan dengan rapi nanti. Gunakan OBS / Streamlabs sebagai alternatif."
      );
    }
    // The session sub-resource is ALWAYS same-origin with `whipUrl` by
    // construction (see infra/nginx/live-hls.conf.template's `/whip/`
    // location — nginx's own `proxy_redirect` only ever rewrites the PATH of
    // MediaMTX's Location header, never its origin). `new URL(location,
    // whipUrl)` alone is not safe here: when `location` is itself absolute
    // (which nginx's rewrite produces), the `URL` constructor ignores the
    // base entirely and keeps whatever scheme/host/port the upstream
    // happened to construct — measured, under one specific Docker
    // port-remapping arrangement, to be a container-internal port no
    // external client could reach. Since the stream key travels in the
    // PATH, keeping only `pathname`+`search` and re-resolving against
    // `whipUrl` pins the DELETE to the origin the browser actually reached,
    // regardless of what origin nginx's own redirect happened to construct.
    const locationPath = new URL(location, whipUrl);
    const sessionUrl = new URL(locationPath.pathname + locationPath.search, whipUrl).toString();

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    // Signalling succeeding proves nothing about media actually flowing —
    // see this file's own "Fix Round 1" docstring above. This is the check
    // that turns a UDP-blocked network into a reported failure instead of a
    // silent, permanent "live" badge.
    await waitForConnection(pc, connectTimeoutMs);

    // "Connected" proves signalling and ICE, not that a picture is moving —
    // see this file's own "Fix Round 3" docstring above for the production
    // defect (Firefox, audio-only, no on-screen warning) this catches.
    await verifyVideoIsFlowing(pc, videoFlowTimeoutMs, videoFlowPollIntervalMs);

    // See this file's own "Fix Round 2, N2" docstring above: guaranteed at
    // most one `onDisconnected` call per publish, no matter how many
    // qualifying state-change events the connection fires for one drop.
    let notifiedDisconnected = false;
    const notifyDisconnected = () => {
      if (closedByCaller || notifiedDisconnected) return;
      if (hasClosedOrFailed(pc)) {
        notifiedDisconnected = true;
        onDisconnected?.();
      }
    };
    pc.addEventListener("connectionstatechange", notifyDisconnected);
    pc.addEventListener("iceconnectionstatechange", notifyDisconnected);

    return {
      close() {
        closedByCaller = true;
        pc.close();
        fetchFn(sessionUrl, { method: "DELETE" }).catch(() => {
          // Best-effort, and deliberately unlogged — see this interface's
          // own docstring on `close()`.
        });
      },
    };
  } catch (err) {
    pc.close();
    if (err instanceof WhipNegotiationError) throw err;
    // The one message this brief calls out by name: point at the most likely
    // real-world cause (a network — often a mobile carrier or a restrictive
    // office/campus network — blocking the UDP traffic WebRTC needs) and at
    // the alternative that does not need it. Reached both by the signalling
    // fetch itself throwing (server unreachable, DNS, CORS) AND by
    // `waitForConnection` rejecting (signalling succeeded, media never
    // connected) — both are, from a creator's point of view, "I clicked go
    // live and it did not work", and the fix is the same for both.
    throw new WhipNegotiationError(
      "Gagal terhubung ke server siaran. Penyebab paling umum adalah jaringan yang " +
        "memblokir lalu lintas UDP (dibutuhkan WebRTC) — coba jaringan lain (mis. bukan WiFi " +
        "kantor/kampus), atau gunakan OBS / Streamlabs sebagai alternatif.",
      { cause: err }
    );
  }
}

/**
 * Reorders this connection's VIDEO codec preferences to put H264 first.
 *
 * ====================== TASK 4 (the phase gate): why this exists ======================
 * Found by opening the MEMBER watch page against a real browser publish —
 * something no earlier task in this phase had done. Chromium's default video
 * codec preference is VP8, so that is what the WHIP offer asked for and what
 * MediaMTX accepted. MediaMTX's own log, captured live:
 *
 *   INF [path live/<key>] stream is available and online, 2 tracks (Opus, VP8)
 *   WAR [HLS] [muxer live/<key>] skipping track 2 (VP8)
 *   INF [HLS] [muxer live/<key>] is converting into HLS, 1 track (Opus)
 *
 * HLS cannot carry VP8. MediaMTX therefore DROPPED the video track and served
 * every member an audio-only stream. Measured on the member's own `<video>`:
 * `readyState: 4`, `paused: false`, `currentTime` genuinely advancing, and
 * `videoWidth: 0, videoHeight: 0`. Healthy by every signal except the only
 * one that matters — there was no picture.
 *
 * Nothing surfaces this to either side. The creator's preview is their LOCAL
 * camera, not the round trip, so it looks perfect; the API never learns what
 * codec was negotiated; the `WAR` line above is the only evidence anywhere.
 * OBS/RTMP was never affected because ffmpeg publishes H264 — which is why
 * this survived the entire live-streaming phase and only appeared once
 * browsers became publishers.
 * =====================================================================
 *
 * A PREFERENCE, NOT A RESTRICTION: every codec the browser supports stays in
 * the list, just with H264 moved to the front. A server that cannot do H264
 * still negotiates something rather than failing to negotiate video at all —
 * a worse outcome than a codec HLS happens not to carry.
 *
 * Every step is optional-chained or feature-checked because all three pieces
 * (`RTCRtpSender.getCapabilities`, `getTransceivers`, `setCodecPreferences`)
 * are absent on older Safari/Firefox — the same browsers `hasConnected`'s own
 * fallback exists for. On those, publishing must still work; only the
 * preference is lost.
 */
function preferH264(pc: RTCPeerConnection): void {
  // `typeof` rather than `RTCRtpSender?.` — an ABSENT global is a
  // `ReferenceError`, not `undefined`, and optional chaining does not save
  // you from that. The same reason `publishToWhip` above checks
  // `typeof RTCPeerConnection === "undefined"` instead of testing the value.
  if (typeof RTCRtpSender === "undefined") return;
  const capabilities = RTCRtpSender.getCapabilities?.("video");
  const codecs = capabilities?.codecs;
  if (!codecs || codecs.length === 0) return;

  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
  if (h264.length === 0) return;
  const reordered = [...h264, ...codecs.filter((codec) => !h264.includes(codec))];

  for (const transceiver of pc.getTransceivers?.() ?? []) {
    // `kind` is on the transceiver's receiver in the spec; several
    // implementations also expose it directly. Reading both keeps this from
    // silently reordering the AUDIO transceiver's codecs with a video list.
    const kind =
      (transceiver as { kind?: string }).kind ?? transceiver.receiver?.track?.kind ?? undefined;
    if (kind !== "video") continue;
    try {
      transceiver.setCodecPreferences?.(reordered);
    } catch {
      // A browser that rejects the list must not take the publish down with
      // it — the un-preferred negotiation is still a working publish, just
      // one whose video HLS may not carry.
    }
  }
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, ICE_GATHERING_TIMEOUT_MS);
  });
}

/**
 * `connectionState` is the unified, spec-current signal — but it is
 * `undefined` on RTCPeerConnection implementations that predate it (older
 * Firefox, older Safari; see this file's own "Fix Round 2, N4" docstring
 * above), which otherwise only ever expose `iceConnectionState`. Every
 * caller of these three goes through them rather than reading either state
 * field directly, so the fallback cannot be forgotten at a second call site.
 */
function hasConnected(pc: RTCPeerConnection): boolean {
  if (pc.connectionState !== undefined) return pc.connectionState === "connected";
  return pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
}

function hasFailed(pc: RTCPeerConnection): boolean {
  if (pc.connectionState !== undefined) return pc.connectionState === "failed";
  return pc.iceConnectionState === "failed";
}

function hasClosedOrFailed(pc: RTCPeerConnection): boolean {
  if (pc.connectionState !== undefined) {
    return pc.connectionState === "failed" || pc.connectionState === "closed";
  }
  return pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed";
}

/**
 * Resolves once the connection reaches "connected" (`hasConnected`); rejects
 * on a failure (`hasFailed`) or on timeout. `"disconnected"` is deliberately
 * NOT treated as failure here — per the WebRTC spec it can be transient (a
 * momentary network blip that recovers on its own), so treating it as
 * terminal during the INITIAL connect would fail negotiations that were
 * about to succeed. Listens for BOTH `connectionstatechange` and
 * `iceconnectionstatechange` — a browser without `connectionState` never
 * fires the former at all, so relying on it alone would silently never
 * resolve on exactly the browsers `hasConnected`'s own fallback exists for.
 */
function waitForConnection(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (hasConnected(pc)) return Promise.resolve();
  if (hasFailed(pc)) return Promise.reject(new Error("peer connection failed"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      pc.removeEventListener("connectionstatechange", onChange);
      pc.removeEventListener("iceconnectionstatechange", onChange);
      clearTimeout(timer);
    };
    const onChange = () => {
      if (hasConnected(pc)) {
        cleanup();
        resolve();
      } else if (hasFailed(pc)) {
        cleanup();
        reject(new Error("peer connection failed"));
      }
    };
    pc.addEventListener("connectionstatechange", onChange);
    pc.addEventListener("iceconnectionstatechange", onChange);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("peer connection did not connect in time"));
    }, timeoutMs);
  });
}

/**
 * Fix Round 3: checks that video is ACTUALLY reaching the server, not just
 * that the connection is up — see this file's own "FIX ROUND 3" docstring
 * for the production defect (Firefox, audio-only, no on-screen warning) this
 * exists to catch. Called only after `waitForConnection` has already
 * resolved.
 *
 * Two distinguishable outcomes, because a creator's next move differs
 * slightly by cause:
 *  - No video `RTCRtpSender` exists at all (`videoSender === undefined`) —
 *    this browser never had a video track to offer in the first place, so
 *    the server never had anything to accept. Reported immediately, with no
 *    need to wait for stats that will never appear.
 *  - A video sender exists, but its `outbound-rtp` `bytesSent` stays at zero
 *    for `timeoutMs` — the sender was negotiated, yet nothing it produces is
 *    ever reaching the server. This is the ACTUAL defect observed in
 *    production: Firefox without Cisco's OpenH264 present can end up here,
 *    reporting "connected" while its encoder silently never emits a frame.
 *
 * FEATURE-DETECTED throughout, exactly like `preferH264` above: `getSenders`
 * and `getStats` are both optional-chained/`typeof`-checked, because this is
 * a diagnostic layered on top of an already-working publish path, and a
 * browser (or test fake) that lacks either capability must publish exactly
 * as it did before this fix existed — "cannot verify" is never reported as
 * "verified broken". The same reasoning applies to `getStats()` itself
 * throwing: caught and treated as unverifiable, not as evidence of failure.
 */
async function verifyVideoIsFlowing(
  pc: RTCPeerConnection,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<void> {
  if (typeof pc.getSenders !== "function") return;

  const videoSender = pc.getSenders().find((sender) => sender.track?.kind === "video");
  if (videoSender === undefined) {
    throw new WhipNegotiationError(NO_VIDEO_TRACK_MESSAGE);
  }
  if (typeof videoSender.getStats !== "function") return;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let bytesSent: number | null;
    try {
      bytesSent = await outboundBytesSent(videoSender);
    } catch {
      // See this function's own docstring: a `getStats()` that throws tells
      // us nothing about whether video is really flowing.
      return;
    }
    if (bytesSent !== null && bytesSent > 0) return;
    if (Date.now() >= deadline) {
      throw new WhipNegotiationError(VIDEO_NOT_SENDING_MESSAGE);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Sums `bytesSent` across every `outbound-rtp` report in this sender's own
 * `getStats()` (normally exactly one) — `RTCStatsReport` is Map-like
 * (iterable via `.values()`), not a plain object, on every real browser and
 * on the `Map` this file's own tests use to stand in for one. Returns `null`
 * rather than `0` when the report carries no `bytesSent` field at all (some
 * implementations may omit it entirely rather than reporting zero), so a
 * caller can tell "definitely zero" apart from "field absent" if it ever
 * needs to — `verifyVideoIsFlowing` above currently treats both the same
 * (neither is evidence of a byte having been sent).
 */
async function outboundBytesSent(sender: RTCRtpSender): Promise<number | null> {
  const stats = await sender.getStats();
  let total: number | null = null;
  for (const report of stats.values() as Iterable<{ type?: string; bytesSent?: number }>) {
    if (report.type === "outbound-rtp" && typeof report.bytesSent === "number") {
      total = (total ?? 0) + report.bytesSent;
    }
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
