import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Hls from "hls.js";
import { fetchWatchSession } from "../api";

/**
 * Re-attaches `?token=<token>` to `url`, overwriting any query string
 * already there.
 *
 * THE MOST IMPORTANT FUNCTION IN THIS FILE. MediaMTX re-authenticates EVERY
 * playlist request AND every segment/part request `hls.js` makes — and it
 * does NOT propagate a query string from `index.m3u8` to the segment URLs
 * it lists inside that playlist (confirmed against a real MediaMTX in
 * Task 6). A naive `hls.loadSource(url + "?token=...")` therefore
 * authorises the FIRST request and then 401s every one after it: the
 * playlist loads, playback starts, and dies on the first segment. Every
 * single request this player makes must run its URL back through this
 * function — see `buildXhrSetup` below, which is the ONE place that
 * happens.
 *
 * Exported (and kept pure — no DOM, no hls.js) so the exact rewriting
 * behaviour is directly testable without constructing a real player: see
 * `WatchPage.test.tsx`.
 */
export function withToken(url: string, token: string): string {
  const parsed = resolveUrl(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

/**
 * `url` is always absolute in real use — hls.js resolves a playlist's
 * relative segment references to absolute URLs itself before ever handing
 * one to `xhrSetup` — so the relative branch below exists only as a safety
 * net, never the expected path in production.
 *
 * `window.location.origin` is deliberately NOT used as the base
 * unconditionally: under a test DOM (happy-dom's default document is
 * `about:blank`), `origin` is the literal string `"null"`, which is not a
 * valid `URL` base and throws — a real browser's location is never in that
 * state, but this function has to be safe in both.
 */
function resolveUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    const origin =
      typeof window !== "undefined" && window.location.origin !== "null"
        ? window.location.origin
        : "http://localhost";
    return new URL(url, origin);
  }
}

/**
 * The `xhrSetup` hls.js hands every request it makes through — the
 * mechanism the carry-forward note names explicitly ("via xhrSetup or a
 * custom loader"). hls.js calls this BEFORE opening the connection, and its
 * own default loader only calls `xhr.open` itself if this function has not
 * already done so — calling `xhr.open` here, rather than merely rewriting
 * `url` and returning it, is what makes the override take effect (this is
 * hls.js's documented contract for `xhrSetup`, not an assumption).
 */
export function buildXhrSetup(token: string): (xhr: XMLHttpRequest, url: string) => void {
  return (xhr, url) => {
    xhr.open("GET", withToken(url, token), true);
  };
}

export interface WatchPlayerHandle {
  destroy(): void;
}

export type AttachPlayer = (input: {
  video: HTMLVideoElement;
  hlsUrl: string;
  token: string;
  onFatalError: () => void;
}) => WatchPlayerHandle | null;

/**
 * The real player wiring: native HLS on Safari (which never runs `hls.js`'s
 * XHR loader at all, so `withToken`/`buildXhrSetup` do not apply there —
 * see this project's Task 8 report for the known gap that leaves), `hls.js`
 * everywhere else, and `null` when neither is available.
 *
 * Kept as a plain, exported function — not a class, not a hook — so
 * `WatchPage` can accept a fake in tests via the `attachPlayer` prop and
 * never has to mock the `hls.js` module itself.
 */
export function defaultAttachPlayer({
  video,
  hlsUrl,
  token,
  onFatalError,
}: {
  video: HTMLVideoElement;
  hlsUrl: string;
  token: string;
  onFatalError: () => void;
}): WatchPlayerHandle | null {
  // Safari plays HLS natively and has no `hls.js`-style hook to re-attach
  // the token to a relative segment URL — this is the ONE new dependency
  // this plan adds existing in the first place. Checked first because a
  // browser that says yes here has no MediaSource path worth preferring.
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = withToken(hlsUrl, token);
    video.addEventListener("error", onFatalError);
    void video.play().catch(() => {
      // Autoplay can be refused by the browser; the member still has visible
      // controls to press play themselves. Not a fatal stream error.
    });
    return {
      destroy() {
        video.removeEventListener("error", onFatalError);
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (Hls.isSupported()) {
    const hls = new Hls({ xhrSetup: buildXhrSetup(token) });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatalError();
    });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    void video.play().catch(() => {});
    return {
      destroy() {
        hls.destroy();
      },
    };
  }

  return null;
}

type Phase =
  | { name: "loading" }
  | { name: "playing"; hlsUrl: string }
  | { name: "ended" }
  | { name: "unsupported" }
  | { name: "unavailable" };

/**
 * `/watch/:token` — plays the HLS stream a "Tonton sekarang" link (the
 * member's subscription status page) or a WhatsApp "we're live" message
 * points at. This is the ONLY page a bare `/watch/<token>` URL has to work
 * against with no other context: it resolves the token itself via
 * `GET /c/watch/:token` rather than trusting anything passed through
 * router state.
 *
 * ERRORS ARE ONE MESSAGE. An expired token, a token for another community,
 * and a cancelled subscription all render as "unavailable" — the API
 * already collapses every one of those into the identical 403
 * (`ResolveWatchToken`), and this component does not read the response
 * body's `error` text at all, so there is nothing here that COULD start
 * distinguishing them even by accident.
 */
export default function WatchPage({
  attachPlayer = defaultAttachPlayer,
}: { attachPlayer?: AttachPlayer } = {}) {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!token) {
      setPhase({ name: "unavailable" });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const session = await fetchWatchSession(token);
        if (cancelled) return;
        // The API answered 200, but a response that does not actually carry
        // a usable URL is not a "playing" state — never hand a
        // player-attach an `hlsUrl` that isn't a real string.
        if (typeof session.hlsUrl !== "string" || session.hlsUrl === "") {
          setPhase({ name: "unavailable" });
          return;
        }
        setPhase({ name: "playing", hlsUrl: session.hlsUrl });
      } catch {
        // Deliberately not reading the caught error's message into the UI —
        // see the class docstring. Every failure (network error, non-JSON
        // body, any `ApiError` status) renders the same phase.
        if (cancelled) return;
        setPhase({ name: "unavailable" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (phase.name !== "playing") return;
    const video = videoRef.current;
    if (!video || !token) return;

    const handle = attachPlayer({
      video,
      hlsUrl: phase.hlsUrl,
      token,
      onFatalError: () => setPhase({ name: "ended" }),
    });

    if (!handle) {
      setPhase({ name: "unsupported" });
      return;
    }

    return () => handle.destroy();
    // `phase` itself (not just `phase.hlsUrl`) is a dependency so this effect
    // re-runs — and re-attaches — every time the phase transitions INTO
    // "playing", not only on the first mount.
  }, [phase, attachPlayer, token]);

  return (
    <main style={styles.page}>
      {phase.name === "loading" ? (
        <>
          <h1 style={styles.heading}>Memuat siaran...</h1>
          <p>Menyiapkan tautan tontonan Anda.</p>
        </>
      ) : null}

      {phase.name === "playing" ? (
        <>
          <h1 style={styles.heading}>Sedang tayang langsung</h1>
          <video ref={videoRef} controls playsInline style={styles.video} />
        </>
      ) : null}

      {phase.name === "ended" ? (
        <>
          <h1 style={styles.heading}>Siaran telah berakhir</h1>
          <p>Sesi ini sudah selesai. Tayangan ulang akan tersedia setelah rekaman diunggah.</p>
        </>
      ) : null}

      {phase.name === "unsupported" ? (
        <>
          <h1 style={styles.heading}>Peramban tidak didukung</h1>
          <p>
            Peramban ini tidak mendukung pemutaran siaran langsung. Coba buka tautan ini di Chrome,
            Firefox, atau Safari versi terbaru.
          </p>
        </>
      ) : null}

      {phase.name === "unavailable" ? (
        <>
          <h1 style={styles.heading}>Tautan sudah tidak berlaku</h1>
          <p>
            Tautan ini sudah kedaluwarsa atau tidak berlaku lagi. Kembali ke halaman status
            keanggotaan Anda untuk mendapatkan tautan yang baru.
          </p>
        </>
      ) : null}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 720,
    margin: "0 auto",
    padding: "48px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    textAlign: "center",
  },
  heading: {
    fontSize: "1.5rem",
    marginBottom: 4,
  },
  video: {
    width: "100%",
    marginTop: 16,
    borderRadius: 8,
    backgroundColor: "#000",
  },
};
