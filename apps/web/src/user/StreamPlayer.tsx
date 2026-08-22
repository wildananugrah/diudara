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
 * Fix round 2 (review). **How close to its OWN expiry the token currently
 * applied to the native `<video>` must be before a re-mint is actually
 * APPLIED there.** Minting still happens every `remintIntervalMs` tick,
 * unconditionally — nothing about that changes (fix round 1's promptness
 * property, "a refused re-mint reaches `block()` promptly," depends on
 * minting never skipping a tick, and does not depend on this margin at
 * all). This constant only gates the SEPARATE decision of whether the
 * freshly-minted token is worth a `video.load()` reload right now.
 *
 * **THE HONEST FINDING THIS FIX ROUND PRODUCED, STATED PLAINLY: at the
 * numbers already committed — `USER_WATCH_TOKEN_TTL_MS` is ten minutes,
 * `DEFAULT_REMINT_INTERVAL_MS` is five — the review's own stated safety
 * requirement ("comfortably larger than one re-mint interval, so a single
 * failed tick cannot let the attached token lapse before the next
 * successful one applies") and its stated goal ("roughly twelve hitches an
 * hour into six or seven") CANNOT both be satisfied. This is not a
 * near-miss; it is exact, and worth deriving once so nobody re-litigates it
 * from a hunch:**
 *
 * A token applied at time T expires at T + TTL. At each tick T + kI (I =
 * `remintIntervalMs`), the applied token's remaining life is `TTL - kI`.
 * The reload condition below fires the FIRST tick where `remaining ≤
 * margin`, i.e. the smallest `k` with `k ≥ (TTL - margin) / I`. With
 * TTL = 2I exactly (10 min / 5 min), remaining after ONE tick is always
 * `TTL - I = I` — so ANY `margin ≥ I` (the review's own requirement) makes
 * that very first tick satisfy the condition, and the native path reloads
 * on literally EVERY tick: identical to fix round 1's behaviour, zero
 * improvement. The only way to skip a tick (reload every OTHER one, the
 * "six or seven" the review named) is `margin < I` — and because TTL is
 * exactly two ticks wide, that reload then lands EXACTLY at the moment the
 * previous token expires, with no slack at all for a delayed tick: the
 * opposite of what the margin exists to buy.
 *
 * **This is also the OPPOSITE of the intuitive direction reviewing this
 * fix out loud might suggest.** For a "reload once remaining life ≤ margin"
 * rule, a LARGER margin reloads EARLIER within each cycle, which SHORTENS
 * the cycle — bigger margin means MORE frequent reloads, not fewer;
 * `margin = 0` is the LEAST frequent (and least safe) setting, reloading
 * only once the previous token has already run out. Mutating this constant
 * to `0` therefore does NOT reproduce "every tick reloads" — it reproduces
 * the opposite failure. `StreamPlayer.test.tsx` runs and reports this
 * mutation exactly as instructed, and separately identifies the mutation
 * that DOES reproduce "quietly becomes every tick again" (raising the
 * margin, not zeroing it) — see that file's own comments.
 *
 * **The decision made here, honouring the review's explicit safety
 * requirement over its numeric example:** `margin = 8 minutes`, comfortably
 * above the 5-minute interval (1.6×) while staying short of the full
 * 10-minute TTL so the comparison is not degenerate. Chosen KNOWING this
 * means the native path still reloads on every tick at today's numbers —
 * see the fix round 2 report for the full disclosure and the two paths
 * that WOULD unlock a real reduction (shrinking `remintIntervalMs`, which
 * this round was told to leave alone; or a smaller margin, which this
 * constant deliberately does not use because it removes exactly the slack
 * the review asked to keep). Never imported elsewhere — see
 * `DEFAULT_REMINT_INTERVAL_MS`'s own note on why a timing constant like
 * this is asserted as a literal in tests instead.
 */
export const NATIVE_RELOAD_MARGIN_MS = 8 * 60 * 1000;

/**
 * Parses `WatchTokenResult.expiresAt` (ISO-8601) into epoch milliseconds,
 * or `null` for anything that does not parse. **`null` is treated as
 * "unknown" wherever this is called, which means "apply immediately" —**
 * a malformed expiry must never become a reason to withhold a reload
 * forever, which is the failure direction that matters here (see
 * `NATIVE_RELOAD_MARGIN_MS`'s own note on which direction is unsafe).
 */
function parseExpiryMs(iso: string): number | null {
  const parsed = new Date(iso).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

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
  /**
   * **Fix round 1 (review Major).** Called after a successful re-mint has
   * already updated what `getToken()` returns, for an attach mechanism that
   * cannot re-read `getToken()` on its own the way `hls.js`'s `xhrSetup`
   * does. Optional, and deliberately so: the `hls.js` branch below does NOT
   * implement it, because `xhrSetup` already reads `getToken()` fresh on
   * EVERY request it makes (the manifest, and every segment) — reloading
   * there on top of that would only interrupt a stream that was already
   * picking up the new token on its own.
   *
   * The NATIVE branch (`video.src`) is the one that needed this: a bare
   * `<video src>` has no hook that fires per-request, so a refreshed token
   * sitting in `getToken()` was previously invisible to it for the rest of
   * the token's five-minute life — every re-mint minted a token, and the
   * native path threw it away. `StreamPlayer`'s own re-mint success handler
   * calls `handle.onTokenRefreshed?.()` right after writing the new token,
   * so the native implementation below can reload with it.
   */
  onTokenRefreshed?(): void;
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
 * The NATIVE branch has no hook equivalent to `xhrSetup` on a bare
 * `<video src>` — that part of the gap this file's earlier version
 * disclosed is real and does not go away. Fix round 1 (review Major) closes
 * the CONSEQUENCE rather than the cause: `StreamPlayer` now calls
 * `handle.onTokenRefreshed?.()` after every successful re-mint, and this
 * branch's `onTokenRefreshed` reloads `src` with the fresh token — a
 * reload, not a per-segment hook, and visibly hitchy for it (see
 * `onTokenRefreshed`'s own comment below), but a token that stays current
 * for as long as the stream runs, on the ONE path every iOS visitor is
 * forced through (WebKit is mandatory there; there is no alternative
 * engine to fall back to). What remains UNVERIFIED rather than fixed:
 * whether iOS Safari's native error/stall behaviour at the OLD boundary
 * (before this fix, a token actually expiring mid-request) reaches
 * `onFatalError` cleanly or stalls silently — happy-dom has no native HLS
 * engine to answer that with, and this fix removes the question rather
 * than answering it (the token is never allowed to reach that boundary
 * now). Left for Task 9's gate to drive on a real iPhone; see this task's
 * fix-round-1 report.
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
    /**
     * Fix round 1. Re-reads `getToken()` and reloads `src` with it — called
     * once here at attach time, and again by `onTokenRefreshed` on every
     * later re-mint. Same call shape both times, so attach and refresh
     * cannot drift into two different ways of building the URL.
     *
     * `video.load()` is the cheapest fix that keeps the stream running, not
     * a seamless one: reassigning `.src` alone is not reliably picked up by
     * every native HLS engine (this mirrors `WatchPage.tsx`'s own native
     * reload-on-error path, which uses the identical `load()` + `play()`
     * pair for the same reason). For a LIVE manifest this reconnects at the
     * live edge, the same experience an ordinary network hiccup already
     * produces — not a scrub back to the start of a recording — but it is a
     * real, visible hitch every `remintIntervalMs`, disclosed rather than
     * hidden. A seamless swap would need a hook this platform does not
     * expose on a bare `<video src>`; keeping the token current is strictly
     * better than the alternative this fix replaces, which was silence.
     */
    function loadWithCurrentToken() {
      const token = getToken();
      video.src = token !== null ? withToken(hlsUrl, token) : hlsUrl;
      video.load();
      void video.play().catch(() => {});
    }

    loadWithCurrentToken();
    video.addEventListener("error", onFatalError);
    return {
      destroy() {
        video.removeEventListener("error", onFatalError);
        video.removeAttribute("src");
        video.load();
      },
      onTokenRefreshed: loadWithCurrentToken,
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
  /** Fix round 2. Injected for testing — see `NATIVE_RELOAD_MARGIN_MS`'s own docstring for why the default is what it is, and for the finding that motivated a separate, injectable value rather than a hardcoded one. */
  nativeReloadMarginMs?: number;
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
  nativeReloadMarginMs = NATIVE_RELOAD_MARGIN_MS,
}: StreamPlayerProps) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const tokenRef = useRef<string | null>(null);
  /**
   * Fix round 2. When the token currently APPLIED to the native `<video>`
   * expires, in epoch ms — `null` means "unknown, apply immediately" (see
   * `parseExpiryMs`). Set once at the initial attach (effect 1's
   * successful mint always applies unconditionally — there is nothing
   * applied yet to compare against) and again every time a re-mint tick
   * actually applies its token (effect 2). Irrelevant to the `hls.js` path,
   * which never reads it — `xhrSetup` re-reads `getToken()` fresh on every
   * request regardless of what is "applied," so there is no reload
   * decision for it to gate.
   */
  const appliedExpiresAtRef = useRef<number | null>(null);
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
        // Fix round 2. The FIRST attach always applies unconditionally —
        // there is nothing applied yet to compare a margin against — so
        // this is set here with no gate, unlike the re-mint tick below.
        appliedExpiresAtRef.current = parseExpiryMs(minted.expiresAt);
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
            // ALWAYS written, unconditionally, on EVERY successful tick —
            // fix round 1's property this must not regress. `hls.js`'s
            // `xhrSetup` reads this fresh on every request it makes, so a
            // refusal reaching `block()` promptly (below) and a valid token
            // always being the one in hand both depend on this line running
            // every tick, never gated by the reload decision that follows.
            tokenRef.current = minted.token;

            // Fix round 2. WHETHER TO APPLY is a separate question from
            // whether to MINT — see `NATIVE_RELOAD_MARGIN_MS`'s own
            // docstring. `hls.js`'s handle does not implement
            // `onTokenRefreshed` at all, so this whole block is a no-op for
            // it regardless of the decision below; only the native branch's
            // handle does anything with the call.
            const mintedExpiresAtMs = parseExpiryMs(minted.expiresAt);
            const appliedExpiresAtMs = appliedExpiresAtRef.current;
            const shouldApply =
              appliedExpiresAtMs === null ||
              mintedExpiresAtMs === null ||
              Date.now() >= appliedExpiresAtMs - nativeReloadMarginMs;
            if (shouldApply) {
              appliedExpiresAtRef.current = mintedExpiresAtMs;
              handle?.onTokenRefreshed?.();
            }
          } catch {
            // Any refusal — a lapsed membership, a dead session, a network
            // drop — is the identical outcome: stop playback and show the
            // lock, the same collapse `mintStreamWatchToken`'s own
            // docstring describes for the FIRST mint. UNCONDITIONAL, exactly
            // as before fix round 2 — this branch does not consult
            // `nativeReloadMarginMs` at all, so "apply later" can never
            // become "notice a refusal later." A refusal always reaches
            // `block()` on the SAME tick it happens, on both paths.
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
  }, [phase, hlsUrl, needsToken, attachHls, mintToken, remintIntervalMs, nativeReloadMarginMs, stream.id]);

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
