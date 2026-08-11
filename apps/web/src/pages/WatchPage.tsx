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
 * How many times to attempt hls.js's own documented recovery calls
 * (`startLoad()` for a fatal `NETWORK_ERROR`, `recoverMediaError()` for a
 * fatal `MEDIA_ERROR`) before giving up on THIS attach and calling
 * `onFatalError`. Bounded so a persistently broken stream cannot retry
 * forever, but present at all so the ordinary case for this audience —
 * mobile, an Indonesian network dropping out for a few seconds — recovers
 * silently instead of ending the session. Not tuned against real traffic;
 * a round number chosen for "clearly more than one blip, clearly not
 * infinite."
 */
const MAX_FATAL_ERROR_RECOVERY_ATTEMPTS = 3;

/**
 * Which playback mechanism `defaultAttachPlayer` should use.
 *
 * ORDER IS LOAD-BEARING, and that is exactly what this function exists to
 * make directly testable without constructing a real `Hls` instance or
 * mocking the `hls.js` module. Review finding: an earlier version checked
 * `video.canPlayType("application/vnd.apple.mpegurl")` BEFORE `Hls.
 * isSupported()`. Desktop Safari answers `true` to both (it plays HLS
 * natively there too), so that ordering routed desktop Safari onto the
 * native path — the one with no `xhrSetup` hook, no token re-attachment,
 * and (at the time) no test coverage — even though `hls.js` (fully
 * instrumented, fully tested) works fine on desktop Safari. Checking
 * `isHlsSupported()` FIRST means only a browser where `hls.js` genuinely
 * cannot run (iOS Safari, for lack of MediaSource Extensions) ever reaches
 * the native branch.
 *
 * `isHlsSupported` is an injected function (default: `Hls.isSupported`)
 * purely so a test can force each branch without needing a real `Hls`
 * class or a real MediaSource-capable environment — see
 * `WatchPage.test.tsx`'s "prefers hls.js over native Safari" test, which
 * would have failed against the old ordering.
 */
export function choosePlaybackStrategy(
  video: HTMLVideoElement,
  isHlsSupported: () => boolean = () => Hls.isSupported()
): "hls.js" | "native" | "unsupported" {
  if (isHlsSupported()) return "hls.js";
  if (video.canPlayType("application/vnd.apple.mpegurl")) return "native";
  return "unsupported";
}

/**
 * The real player wiring: `hls.js` wherever it can run, native HLS only
 * where it genuinely cannot (iOS Safari, which has no MediaSource
 * Extensions support at all), and `null` when neither is available — see
 * `choosePlaybackStrategy` for the ordering this depends on.
 *
 * `choosePlaybackStrategy`'s native branch remains a genuine, disclosed
 * gap (see this project's Task 8 report): iOS Safari's native engine has no
 * hook equivalent to `xhrSetup`, so a segment URL's token cannot be
 * re-attached there if MediaMTX's query-propagation gap applies to it the
 * same way it does to `hls.js`'s XHR loader. Untested, for the same reason
 * — no iOS Safari was available to verify against.
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
  const strategy = choosePlaybackStrategy(video);

  if (strategy === "hls.js") {
    // WARNING FOR ANY FUTURE CONFIG CHANGE HERE: `xhrSetup` only applies to
    // hls.js's DEFAULT (XHR-based) loader. Setting `config.progressive: true`
    // (or otherwise supplying a custom loader) swaps in hls.js's `FetchLoader`,
    // which honours a DIFFERENT hook — `fetchSetup` — and would silently stop
    // calling `xhrSetup` at all, dropping the token from every request with
    // no error of any kind. Do not add `progressive` or a custom `loader`
    // here without carrying `buildXhrSetup`'s rewrite over to whatever hook
    // the new loader actually uses.
    const hls = new Hls({ xhrSetup: buildXhrSetup(token) });

    let networkErrorRecoveries = 0;
    let mediaErrorRecoveries = 0;

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      // hls.js's own documented recovery path — attempt it before treating
      // a fatal error as the end of the session. A dropped connection on a
      // mobile network is the NORMAL case for this audience, and it must
      // not look identical to the creator actually stopping.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (networkErrorRecoveries < MAX_FATAL_ERROR_RECOVERY_ATTEMPTS) {
          networkErrorRecoveries += 1;
          hls.startLoad();
          return;
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (mediaErrorRecoveries < MAX_FATAL_ERROR_RECOVERY_ATTEMPTS) {
          mediaErrorRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
      }

      // Recovery exhausted, or a fatal error type hls.js has no documented
      // recovery call for at all. `onFatalError` does NOT mean "the stream
      // ended" — see `WatchPage`'s "disconnected" phase, which offers a
      // retry rather than claiming something this code cannot actually know.
      onFatalError();
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

  // Only reached on a browser with no MSE support at all (iOS Safari is
  // the real-world case) — see this function's own docstring for the gap
  // that leaves.
  if (strategy === "native") {
    let reloadAttempts = 0;

    function handleNativeError() {
      if (reloadAttempts < MAX_FATAL_ERROR_RECOVERY_ATTEMPTS) {
        reloadAttempts += 1;
        // Native `<video>` exposes no equivalent to hls.js's typed
        // NETWORK_ERROR/MEDIA_ERROR recovery calls — the closest analogue is
        // reloading the same (token-bearing) source and trying to resume.
        video.load();
        void video.play().catch(() => {});
        return;
      }
      onFatalError();
    }

    video.src = withToken(hlsUrl, token);
    video.addEventListener("error", handleNativeError);
    void video.play().catch(() => {
      // Autoplay can be refused by the browser; the member still has visible
      // controls to press play themselves. Not a fatal stream error.
    });
    return {
      destroy() {
        video.removeEventListener("error", handleNativeError);
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  return null;
}

type Phase =
  | { name: "loading" }
  | { name: "playing"; hlsUrl: string }
  /**
   * Reached only after `attachPlayer`'s own recovery attempts (hls.js's
   * `startLoad()`/`recoverMediaError()`, or the native path's reload) are
   * exhausted — see `defaultAttachPlayer`. Deliberately NOT named "ended":
   * nothing available to this page can distinguish "the creator stopped"
   * from "this connection dropped and could not recover", so the copy says
   * neither, and offers a retry rather than a dead end.
   */
  | { name: "disconnected" }
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
  // Bumped by the "Coba lagi" button to force the fetch effect below to
  // re-run against the SAME token — a watch token is a stateless HMAC valid
  // for six hours, so re-resolving it (rather than reloading the whole page)
  // is a legitimate, cheap retry, and it re-checks entitlement fresh too.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!token) {
      setPhase({ name: "unavailable" });
      return;
    }

    let cancelled = false;
    setPhase({ name: "loading" });
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
  }, [token, retryCount]);

  useEffect(() => {
    if (phase.name !== "playing") return;
    const video = videoRef.current;
    if (!video || !token) return;

    const handle = attachPlayer({
      video,
      hlsUrl: phase.hlsUrl,
      token,
      onFatalError: () => setPhase({ name: "disconnected" }),
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

  function retry() {
    setRetryCount((c) => c + 1);
  }

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

      {phase.name === "disconnected" ? (
        <>
          <h1 style={styles.heading}>Terputus dari siaran</h1>
          <p>
            Koneksi ke siaran terputus. Siaran mungkin masih berlangsung — coba sambungkan
            kembali, atau kembali ke halaman status keanggotaan Anda untuk tautan yang baru.
          </p>
          <button type="button" onClick={retry} style={styles.retryButton}>
            Coba lagi
          </button>
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
  retryButton: {
    marginTop: 8,
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    backgroundColor: "#16a34a",
    color: "#fff",
    fontWeight: 600,
    fontSize: "1rem",
    cursor: "pointer",
  },
};
