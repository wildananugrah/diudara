import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { withToken } from "../pages/WatchPage";
import { mintStreamWatchToken, type StreamView, type WatchTokenResult } from "./apiClient";

/**
 * `withToken` is IMPORTED from `pages/WatchPage.tsx`, not re-implemented
 * here — it is a pure, already-hardened function (see its own docstring for
 * the MediaMTX query-propagation history behind it) and reusing it is not
 * the "copy WatchPage wholesale" this task's brief warns against. Nothing
 * else from that file is reused: `WatchPage` solves a different problem
 * (resolving a `/watch/:token` link, six-hour tokens, native-Safari
 * recovery loops) and `/dashboard/*` stays untouched — this file, and
 * `WatchPage.tsx` itself, are not under that path.
 */

/**
 * Comfortably under `USER_WATCH_TOKEN_TTL_MS` (ten minutes —
 * `apps/api/src/domain/user-watch-token.ts`) WITHOUT importing that
 * constant: it lives in `apps/api`, and there is no shared home for it in
 * `@diudara/shared` (unlike `MAX_UPLOAD_BYTES`, which this file's sibling
 * DOES import — that one has a shared home and this one does not). Five
 * minutes leaves a full five-minute margin before the token this player is
 * CURRENTLY using would stop authorising reads, so one missed tick — a
 * backgrounded tab throttling timers, a slow re-mint request — still leaves
 * a comfortable window for the next tick to land before expiry. A round
 * number, not tuned against real traffic; the only hard requirement is
 * "well under ten minutes," and this project's own convention is to assert
 * a timing constant like this as the LITERAL `300000` in tests, never by
 * importing it — see `StreamPlayer.test.tsx`.
 */
export const DEFAULT_REMINT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Bahasa copy for a stream this player could not (or could no longer) play
 * for lack of entitlement — EXPORTED so `StreamPlayer.test.tsx` can assert
 * the exact string rather than re-typing it, the same "assert literals, not
 * the constant that produced them" rule the brief states applies to
 * `SiaranPage`'s own lock copy, which this string deliberately matches
 * verbatim: a refused re-mint mid-broadcast is the same conversion moment
 * as never having been entitled at all — "become a member to watch" is
 * equally true both times, and inventing a second sentence for "your
 * membership just lapsed" would be a distinction this screen has no way to
 * act on differently.
 */
export const STREAM_BLOCKED_MESSAGE = "Jadi anggota untuk menonton";

/** Bahasa copy for a browser that can play neither `hls.js` nor native HLS. */
const STREAM_UNSUPPORTED_MESSAGE = "Peramban ini tidak mendukung pemutaran siaran langsung.";

export interface StreamPlayerHandle {
  destroy(): void;
}

export interface AttachHlsInput {
  video: HTMLVideoElement;
  /** The playback URL — `stream.hlsPlaybackPath`, never token-attached by the caller. Attaching the token is `attachHls`'s own job, via `getToken`, so a re-mint can reach requests already in flight. */
  hlsUrl: string;
  /**
   * Read at THE MOMENT OF EACH REQUEST — never captured once at attach
   * time. This is the whole mechanism that lets a background re-mint reach
   * a manifest hls.js is already polling: `null` means "no token", the
   * shape a PUBLIC stream's playback takes, since `authoriseUserStreamRead`
   * on the API side allows a public read with none at all.
   */
  getToken: () => string | null;
  /** Fired on a fatal, unrecoverable playback error. Does NOT mean "the stream ended" — see `defaultAttachHls`'s own docstring. */
  onFatalError: () => void;
}

export type AttachHls = (input: AttachHlsInput) => StreamPlayerHandle | null;

/**
 * The real player wiring — `hls.js` wherever it can run, a minimal native
 * fallback where it genuinely cannot (iOS Safari), `null` when neither is
 * available. Exported so `StreamPlayer` never has to mock the `hls.js`
 * module in a test — every `StreamPlayer.test.tsx` case injects its own
 * fake `AttachHls` instead, the identical shape `WatchPage.test.tsx` uses
 * for `attachPlayer`.
 *
 * DELIBERATELY SIMPLER THAN `WatchPage`'s `defaultAttachPlayer`: no bounded
 * network/media-error recovery loop. That loop exists there to keep a
 * six-hour forwarded link alive through a mobile network's normal blips;
 * this player already re-mints every five minutes regardless; and the one
 * behaviour that actually matters here — a fatal error ending the session
 * cleanly rather than leaving a broken `<video>` — needs nothing more than
 * calling `onFatalError` on the first fatal error hls.js reports. Recovery
 * can be added later without changing this function's contract if a real
 * mobile network makes the gap visible in practice.
 *
 * `getToken` is read on EVERY `xhrSetup` call, which fires for every
 * request hls.js's default loader makes — the manifest, and every segment —
 * so a re-mint that lands mid-broadcast is picked up by the very next
 * request, with no need to reconstruct the `Hls` instance or reload the
 * source.
 *
 * The NATIVE branch has a disclosed, unfixed gap, the same one
 * `WatchPage.tsx`'s own docstring records for its native path: there is no
 * hook equivalent to `xhrSetup` on a bare `<video src>`, so a re-mint
 * cannot reach a request already using the token baked into `src` at attach
 * time. Left as a one-time attach with no re-mint wiring at all, rather
 * than a half-correct reload loop that would only mask the gap. Untested,
 * for the same reason `WatchPage.tsx`'s native branch is: no iOS Safari
 * available to verify against.
 */
export function defaultAttachHls({
  video,
  hlsUrl,
  getToken,
  onFatalError,
}: AttachHlsInput): StreamPlayerHandle | null {
  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup(xhr, url) {
        const token = getToken();
        xhr.open("GET", token !== null ? withToken(url, token) : url, true);
      },
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatalError();
    });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    void video.play().catch(() => {
      // Autoplay can be refused by the browser; visible controls let the
      // viewer press play themselves. Not a fatal error.
    });
    return {
      destroy() {
        hls.destroy();
      },
    };
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    const token = getToken();
    video.src = token !== null ? withToken(hlsUrl, token) : hlsUrl;
    video.addEventListener("error", onFatalError);
    void video.play().catch(() => {});
    return {
      destroy() {
        video.removeEventListener("error", onFatalError);
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  return null;
}

type Phase =
  | { name: "loading" }
  | { name: "ready" }
  | { name: "blocked" }
  | { name: "unsupported" };

export interface StreamPlayerProps {
  /** MUST be an UNLOCKED row — `stream.locked === false`, `hlsPlaybackPath` present. `SiaranPage` never renders this component for a locked one; see its own docstring. */
  stream: StreamView;
  /** Injected for testing. Defaults to the real `hls.js`/native wiring. */
  attachHls?: AttachHls;
  /** Injected for testing. Defaults to the real `POST /streams/:id/watch-token` call. */
  mintToken?: (streamId: string) => Promise<WatchTokenResult>;
  /** Injected for testing — see `DEFAULT_REMINT_INTERVAL_MS`'s own docstring for why the default is what it is. */
  remintIntervalMs?: number;
}

/**
 * Plays ONE live stream — `SiaranPage`'s row for a stream the viewer is
 * entitled to watch (task brief: "the player owns the re-mint, and this is
 * the part most likely to ship broken").
 *
 * **THE RE-MINT LOOP, THE WHOLE REASON THIS COMPONENT EXISTS SEPARATELY
 * FROM A BARE `<video>`.** `USER_WATCH_TOKEN_TTL_MS` is ten minutes; a
 * player that mints once and never again plays for ten minutes and then
 * fails SILENTLY, which reads as a random playback bug rather than an
 * expiring credential. So for a GATED stream (`stream.visibility !==
 * "public"`) this component:
 *
 *   1. mints a token BEFORE ever calling `attachHls` — never hands the
 *      attach function a "ready" state it has not actually earned;
 *   2. re-mints on `remintIntervalMs` (well under the ten-minute TTL)
 *      for as long as playback runs;
 *   3. on a REFUSED re-mint — a lapsed membership is now the same as never
 *      having been entitled — stops the interval FIRST (a refused re-mint
 *      is never retried on the next tick), destroys the attached player,
 *      and shows the lock. A broken `<video>` element is never what a
 *      lapsed membership looks like here.
 *
 * A PUBLIC stream (`stream.visibility === "public"`) skips minting
 * entirely — `POST /streams/:id/watch-token` REFUSES to issue one for such
 * a stream (`MintUserWatchToken`'s own docstring: "there is nothing to
 * gate"), and `authoriseUserStreamRead` on the API side allows a public
 * read with no token at all. Calling the mint endpoint here would be a
 * request that can only ever fail.
 *
 * **TWO EFFECTS, deliberately mirroring `WatchPage`'s own shape** (that
 * component solves the identical "async setup must complete before a DOM
 * node the setup itself needs even exists" ordering problem): the first
 * mints (or, for public, immediately clears) and decides `"ready"` vs.
 * `"blocked"`; only once `"ready"` causes `<video>` to actually render does
 * the second effect run, find a real `videoRef.current`, and call
 * `attachHls`. Collapsing these into one effect would mean calling
 * `attachHls` with a `video` ref that has not been through a render yet.
 *
 * `tokenRef` is a REF, not `useState` — the re-mint interval writes to it
 * every few minutes and nothing about that write should force a re-render;
 * `attachHls`'s `getToken` closure reads it fresh on every request instead.
 */
export default function StreamPlayer({
  stream,
  attachHls = defaultAttachHls,
  mintToken = mintStreamWatchToken,
  remintIntervalMs = DEFAULT_REMINT_INTERVAL_MS,
}: StreamPlayerProps) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tokenRef = useRef<string | null>(null);
  const needsToken = stream.visibility !== "public";
  const hlsUrl = stream.hlsPlaybackPath;

  // Effect 1 — mint (or skip minting, for a public stream) and decide
  // whether there is anything to attach at all.
  useEffect(() => {
    if (hlsUrl === undefined) {
      // Defensive only: `SiaranPage` never mounts this component for a row
      // with no playback path — that is the locked branch's own job, never
      // this one's — but a phase must still exist for that case rather
      // than silently rendering nothing forever.
      setPhase({ name: "blocked" });
      return;
    }

    let cancelled = false;
    setPhase({ name: "loading" });

    if (!needsToken) {
      // Nothing to mint — see this component's own docstring.
      setPhase({ name: "ready" });
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const minted = await mintToken(stream.id);
        if (cancelled) return;
        tokenRef.current = minted.token;
        setPhase({ name: "ready" });
      } catch {
        // Any refusal — a 403 (no longer a member), a 401 (dead session), a
        // network drop — is the identical outcome from here: no token, no
        // playback, the lock. See `mintStreamWatchToken`'s own docstring.
        if (cancelled) return;
        setPhase({ name: "blocked" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stream.id, hlsUrl, needsToken, mintToken]);

  // Effect 2 — runs only once phase 1 put "ready" on screen and `<video>`
  // has therefore actually mounted. Owns the attach, the re-mint interval,
  // and BOTH of their cleanups.
  useEffect(() => {
    if (phase.name !== "ready" || hlsUrl === undefined) return;
    const video = videoRef.current;
    if (!video) return;

    let handle: StreamPlayerHandle | null = null;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let tornDown = false;

    /** Clears the interval and destroys the attached player. Touches no state — used for BOTH an ordinary unmount and the first half of a real refusal, and an ordinary unmount has no reason to change what's on screen. */
    function teardown() {
      if (tornDown) return;
      // Cleared FIRST: a refused re-mint (or a fatal playback error) must
      // never let a queued tick fire again against a player already torn
      // down.
      tornDown = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      handle?.destroy();
      handle = null;
    }

    /** A refused re-mint or a fatal playback error — tear down AND show the lock, unlike a plain unmount. */
    function block() {
      teardown();
      setPhase({ name: "blocked" });
    }

    handle = attachHls({
      video,
      hlsUrl,
      getToken: () => tokenRef.current,
      onFatalError: block,
    });

    if (handle === null) {
      setPhase({ name: "unsupported" });
      return;
    }

    if (needsToken) {
      intervalId = setInterval(() => {
        void (async () => {
          try {
            const minted = await mintToken(stream.id);
            if (tornDown) return;
            tokenRef.current = minted.token;
          } catch {
            // Any refusal — a lapsed membership, a dead session, a network
            // drop — is the identical outcome: stop playback and show the
            // lock, the same collapse `mintStreamWatchToken`'s own
            // docstring describes for the FIRST mint.
            block();
          }
        })();
      }, remintIntervalMs);
    }

    // Unmount (or any dependency change) tears the WHOLE thing down: the
    // interval is cleared and the attached player destroyed, so neither can
    // outlive this component. A timer that outlives the component is a leak
    // that fires forever. Plain teardown, not `block()` — an ordinary
    // unmount is not a membership lapsing, and has nothing to show.
    return teardown;
  }, [phase, hlsUrl, needsToken, attachHls, mintToken, remintIntervalMs, stream.id]);

  return (
    <div className="stream-player" data-testid="stream-player">
      {phase.name === "blocked" ? (
        <p className="stream-player-blocked" data-testid="stream-player-blocked">
          {STREAM_BLOCKED_MESSAGE}
        </p>
      ) : null}
      {phase.name === "unsupported" ? (
        <p className="stream-player-unsupported">{STREAM_UNSUPPORTED_MESSAGE}</p>
      ) : null}
      {phase.name === "ready" ? <video ref={videoRef} controls playsInline /> : null}
    </div>
  );
}
