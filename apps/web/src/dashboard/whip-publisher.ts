/**
 * The WHIP (WebRTC-HTTP Ingestion Protocol) SDP offer/answer exchange, kept
 * OUT of any React component on purpose (Task 3 brief): device permission and
 * the local preview are UI concerns, but "build an offer, POST it, apply the
 * answer, remember the session URL to tear down later" is pure negotiation
 * logic that does not need a DOM to test.
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
 */

/** Matches `XenditPaymentAdapter`'s own `FetchFn` shape exactly. */
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface PublishHandle {
  /**
   * Stops publishing: closes the local `RTCPeerConnection` immediately (the
   * browser stops sending media the instant this returns) and best-effort
   * `DELETE`s the WHIP session sub-resource so MediaMTX tears down its side
   * without waiting for the ICE connection to time out. The `DELETE`'s
   * failure is swallowed — closing the peer connection already stops the
   * stream; a failed cleanup call only means MediaMTX notices a little later
   * than it otherwise would have, not that the stream keeps running.
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
 * Performs the WHIP offer/answer exchange for one publish, returning a handle
 * to stop it. Every step that can fail is wrapped so the caller only ever
 * sees a `WhipNegotiationError` with an Indonesian message naming the likely
 * cause — a creator meeting this screen has never heard of SDP or ICE.
 */
export async function publishToWhip({
  whipUrl,
  stream,
  fetchFn = (url, init) => fetch(url, init),
}: {
  whipUrl: string;
  stream: MediaStream;
  fetchFn?: FetchFn;
}): Promise<PublishHandle> {
  const pc = new RTCPeerConnection();

  try {
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

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
    const sessionUrl = new URL(location, whipUrl).toString();

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    return {
      close() {
        pc.close();
        fetchFn(sessionUrl, { method: "DELETE" }).catch(() => {
          // Best-effort — see this interface's own docstring on `close()`.
        });
      },
    };
  } catch (err) {
    pc.close();
    if (err instanceof WhipNegotiationError) throw err;
    // The one message this brief calls out by name: point at the most likely
    // real-world cause (a network — often a mobile carrier or a restrictive
    // office/campus network — blocking the UDP traffic WebRTC needs) and at
    // the alternative that does not need it.
    throw new WhipNegotiationError(
      "Gagal terhubung ke server siaran. Penyebab paling umum adalah jaringan yang " +
        "memblokir lalu lintas UDP (dibutuhkan WebRTC) — coba jaringan lain (mis. bukan WiFi " +
        "kantor/kampus), atau gunakan OBS / Streamlabs sebagai alternatif.",
      { cause: err }
    );
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
