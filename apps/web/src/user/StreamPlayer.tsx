import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { mintStreamWatchToken, UserApiError, type StreamView, type WatchTokenResult } from "./apiClient";

/**
 * Retire-telegram Task 1: `withToken` used to be IMPORTED from
 * `pages/WatchPage.tsx` (see that file's own history for the MediaMTX
 * query-propagation reasoning behind it — Phase 8 deleted `WatchPage.tsx`
 * along with the rest of the old checkout/status/watch surface, so the
 * function is reproduced here verbatim rather than left dangling. It is
 * still pure — no DOM, no hls.js — and still not exported: nothing outside
 * this file needs it now that `WatchPage.tsx` is gone.
 *
 * Re-attaches `?token=<token>` to `url`, overwriting any query string
 * already there. MediaMTX re-authenticates EVERY playlist request AND every
 * segment/part request, and rewrites `?token=...` into every sub-manifest
 * URI it emits — so the one cookie-less first request (the master playlist
 * load, before MediaMTX has anything to propagate from yet) and the
 * native-HLS branch (which sets `video.src` directly, with no `xhrSetup`
 * hook) both still need this re-attachment done explicitly.
 */
function withToken(url: string, token: string): string {
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
 * **Fix round 3 (review). Shrunk from 5 minutes to 1 — the interval turned
 * out to be the actual lever, not a fixed cost.** Two things move together
 * whenever `I` (this constant) shrinks, and the review judged the second
 * more important than the first:
 *
 *   1. Fewer native reloads. `NATIVE_RELOAD_MARGIN_MS`'s own docstring
 *      derives WHY: the achievable reload period, with margin chosen at the
 *      smallest safe value, approaches `TTL` as `I` shrinks — ~6 minutes at
 *      `I = 2`, ~8 at `I = 1` — rather than capping out near 6 as fix round
 *      2 wrongly assumed (that round stopped exactly at the feasibility
 *      threshold, `I < TTL/3`, instead of pushing past it).
 *   2. **A refused re-mint reaches `block()` within `I`, on BOTH paths,
 *      because minting itself — never gated by any margin — runs every
 *      tick regardless of platform.** At `I = 5` (fix rounds 1–2), a member
 *      whose subscription lapses mid-broadcast keeps watching for up to
 *      five minutes before the lock appears. At `I = 1`, up to one. This is
 *      the paywall itself reacting five times faster, for the cost of one
 *      constant — the review's own framing, and the deciding factor here:
 *      it is a security/business property, not a polish one, and it
 *      dominates the hitch-frequency question in every case that matters.
 *
 * **The cost: background traffic.** Each tick is one authenticated
 * `POST /streams/:id/watch-token` plus one indexed `isMemberOf` lookup, per
 * ACTIVE VIEWER of a currently-gated live stream — not a mass endpoint, and
 * bounded to exactly the audience this feature exists for. Going from `I =
 * 5` to `I = 1` is 12/hour to 60/hour per such viewer. `I = 2` (30/hour)
 * would have been the more conservative choice, and is a legitimate one —
 * the review explicitly said so. `I = 1` is chosen here because it does not
 * actually trade anything away among the feasible values: it maximises the
 * refusal-latency win (the one judged to matter more) AND it happens to
 * ALSO minimise reload frequency (an 8-minute period beats `I = 2`'s
 * 6-minute one) — the only real cost is the 2× traffic increase over `I =
 * 2`, weighed against a live-membership platform where the audience of a
 * single gated broadcast is the relevant scale, not the whole user base,
 * and an indexed lookup is cheap at that scale. A round number, per this
 * project's own convention for a value that is not tuned against real
 * traffic — see this constant's OWN docstring for why timing constants like
 * this are asserted as literals in tests, never imported.
 */
export const DEFAULT_REMINT_INTERVAL_MS = 1 * 60 * 1000;

/**
 * **How close to its OWN expiry the token currently applied to the native
 * `<video>` must be before a re-mint is actually APPLIED there.** Minting
 * still happens every `remintIntervalMs` tick, unconditionally — nothing
 * about that changes (fix round 1's promptness property, "a refused
 * re-mint reaches `block()` promptly," depends on minting never skipping a
 * tick, and does not depend on this margin at all — see the `catch` branch
 * in `StreamPlayer` below, which never reads this constant). This constant
 * only gates the SEPARATE decision of whether the freshly-minted token is
 * worth a `video.load()` reload right now.
 *
 * **FIX ROUND 3 CORRECTS A WRONG BOUND FIX ROUND 2 SHIPPED.** That round's
 * docstring claimed `margin ≥ I` was the safety requirement — sufficient
 * for the NORMAL case where every tick actually fires, but insufficient
 * for the case the requirement exists to cover: a tick that is skipped
 * entirely (thrown by a backgrounded tab's throttled timer, say). Surviving
 * ONE fully-missed tick needs the reload point to still have a WHOLE
 * SECOND interval of life left after it, not zero — which means the
 * correct bound is:
 *
 *     margin > 2 × I
 *
 * Proof sketch: the reload naturally triggers at the smallest tick `k`
 * where `TTL - kI ≤ margin`. If THAT tick is skipped, the next chance is
 * tick `k+1`, and the token is still valid there iff `TTL - (k+1)I > 0`.
 * Since `k` is smallest, tick `k-1` did NOT trigger: `TTL - (k-1)I >
 * margin`. Substituting `margin > 2I` into that inequality gives
 * `TTL > 2I + (k-1)I = (k+1)I` — exactly the survival condition. `margin ≥
 * I` (fix round 2's bound) does not carry this through; it only guarantees
 * ONE interval of remaining life at the trigger tick itself, none of which
 * is left over for a missed tick to still land inside.
 *
 * **The other bound, unchanged from fix round 2 and still required for a
 * tick to be skippable AT ALL:** `margin < TTL - I` (otherwise the very
 * first tick after ANY apply already satisfies the condition). Combining
 * both bounds: `2I < margin < TTL - I`, which has a solution only when
 * `I < TTL / 3` — this is the feasibility threshold fix round 2 found and
 * then, incorrectly, treated as also being the BEST available period. It
 * is only where skipping starts becoming possible at all; as `I` shrinks
 * further below that threshold, the achievable period (choosing margin at
 * its safe minimum, just above `2I`) approaches `TTL` — `~6 minutes` at `I
 * = 2`, `~8 minutes` at `I = 1` — not the ~6-minute ceiling fix round 2
 * assumed.
 *
 * **The value chosen: `margin = 2.5 minutes` (150 000 ms), at `I = 1
 * minute`.** `2 × I = 2 minutes`, so `2.5` clears the corrected bound with
 * a genuine 25% of headroom above it — not shaved to the boundary, which
 * would satisfy the inequality on paper while leaving no real slack against
 * jitter in exactly how long a tick's own round trip takes. It also sits
 * inside the window that yields the shortest achievable period at `I = 1`
 * (any margin in `[2, 3)` minutes gives the same 8-tick, 8-minute period;
 * `2.5` is the middle of that window, not its edge).
 *
 * **This is also the OPPOSITE of the intuitive direction reviewing this
 * fix out loud might suggest.** For a "reload once remaining life ≤
 * margin" rule, a LARGER margin reloads EARLIER within each cycle, which
 * SHORTENS the cycle — bigger margin means MORE frequent reloads, not
 * fewer; `margin = 0` is the LEAST frequent (and least safe) setting,
 * reloading only once the previous token has already run out. Verified
 * empirically in fix round 2 by mutating this constant's use to a literal
 * `0`: the "not near expiry, no reload" test stayed GREEN, not red — the
 * mutation that actually reproduces "quietly becomes every tick again" is
 * forcing the reload decision to `true` unconditionally, not zeroing the
 * margin. See `StreamPlayer.test.tsx`'s own comments on both mutations.
 *
 * Never imported elsewhere — see `DEFAULT_REMINT_INTERVAL_MS`'s own note on
 * why a timing constant like this is asserted as a literal in tests
 * instead.
 */
export const NATIVE_RELOAD_MARGIN_MS = 2.5 * 60 * 1000;

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

/**
 * **Bahasa copy for a broadcast the creator ENDED — FIX WAVE 2, and the
 * sentence I3 made necessary.**
 *
 * Before I3, a viewer whose stream ended reached the lock BY ACCIDENT:
 * MediaMTX no longer had the path, segments 404'd, `hls.js` reported a fatal
 * error, and `block()` showed `STREAM_BLOCKED_MESSAGE`. Merely imprecise.
 * I3 changed the state's character — the mint endpoint now issues a
 * DELIBERATE 409 within a minute of the creator pressing *Akhiri siaran* —
 * and a sentence that was vague about an accident becomes WRONG about a
 * decision, in the one direction that matters: it tells somebody who is
 * already paying to go and pay.
 *
 * Exported for the same reason `STREAM_BLOCKED_MESSAGE` is: the tests assert
 * the literal, never this constant, and exporting it is what lets a reader
 * find both halves of the pair in one place.
 */
export const STREAM_ENDED_MESSAGE = "Siaran ini sudah berakhir.";

/**
 * **Bahasa copy for "playback stopped and this component cannot say why" —
 * FIX WAVE 2.**
 *
 * The terminal state a FATAL PLAYBACK ERROR reaches. `hls.js` and the native
 * element report one for a manifest that 404'd, a network drop, a decode
 * failure — none of which says anything about entitlement, and two of which
 * happen to viewers who are fully paid up. This used to be
 * `STREAM_BLOCKED_MESSAGE`, i.e. a membership pitch inferred from no evidence
 * at all, and on a PUBLIC stream it was a pitch for a membership that does
 * not exist.
 *
 * Deliberately does NOT claim the stream ended. It might have; it might be
 * this phone's connection. Vague is honest where confidently wrong is not —
 * `describeUploadFailure`'s own rewrite recorded that ruling and this follows
 * it. The one case that CAN be named precisely is named precisely, above.
 */
export const STREAM_UNAVAILABLE_MESSAGE = "Siaran ini tidak dapat diputar sekarang.";

/** Bahasa copy for a browser that can play neither `hls.js` nor native HLS. */
const STREAM_UNSUPPORTED_MESSAGE = "Peramban ini tidak mendukung pemutaran siaran langsung.";

/**
 * Why this player stopped, chosen from the SHAPE of what stopped it and never
 * from any text — see `STREAM_ENDED_MESSAGE` above and
 * `src/test/no-raw-server-errors.test.ts`.
 *
 *  - `not-entitled` — the mint refused for a reason about this VIEWER (a 403
 *    for somebody no longer a member, a 401 for a dead session) or for a
 *    reason this component cannot resolve at all (a network drop). The
 *    membership pitch is the actionable sentence and this is the default.
 *  - `ended` — the mint refused with a 409, which `MintUserWatchToken` sends
 *    for one reason only: the row is not `live`.
 *  - `unavailable` — a fatal playback error, which carries no information
 *    about entitlement whatsoever.
 */
type BlockReason = "not-entitled" | "ended" | "unavailable";

/**
 * Maps a REJECTED MINT to a reason. Reads `err.status` and nothing else: the
 * API's own Bahasa sentence on the wire is never shown, never compared
 * against, and never even bound to a name here.
 *
 * **409 IS A SINGLE-MEANING STATUS ON THIS ROUTE.** `POST /streams/:id/watch-token`
 * has exactly one `ConflictError` (`MintUserWatchToken`'s status check), so
 * there is no second 409 for this branch to be wrong about — unlike, say,
 * `POST /users/:handle/subscribe`, whose seven distinct 409s are precisely why
 * `describeSubscribeFailure` refuses to guess between them.
 *
 * Everything else — 403, 401, a 400, a `TypeError` from a dropped connection —
 * falls to `not-entitled`, which is what this component did for every refusal
 * before fix wave 2. Nothing regresses by being unrecognised.
 */
function blockReasonForMintFailure(err: unknown): BlockReason {
  if (err instanceof UserApiError && err.status === 409) return "ended";
  return "not-entitled";
}

/** The one place a `BlockReason` becomes something a person reads. */
function blockedMessage(reason: BlockReason): string {
  if (reason === "ended") return STREAM_ENDED_MESSAGE;
  if (reason === "unavailable") return STREAM_UNAVAILABLE_MESSAGE;
  return STREAM_BLOCKED_MESSAGE;
}

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
   * the applied token's life (M7: this used to say "five-minute life" —
   * `DEFAULT_REMINT_INTERVAL_MS` is one minute since fix round 3, and the
   * token's own TTL is ten) — every re-mint minted a token, and the
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
 * this player already re-mints every `remintIntervalMs` regardless (one
 * minute by default since fix round 3 — M7: this sentence used to say "five
 * minutes", the pre-round-3 value); and the one
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
  | { name: "blocked"; reason: BlockReason }
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
      // than silently rendering nothing forever. `unavailable`, not
      // `not-entitled`: this component has learned nothing about this
      // viewer's entitlement, and the locked branch is where the pitch
      // belongs.
      setPhase({ name: "blocked", reason: "unavailable" });
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
      } catch (err: unknown) {
        // Any refusal is the same OUTCOME from here — no token, no playback,
        // the terminal state — but no longer the same SENTENCE. Fix wave 2:
        // a 409 means the creator ended the broadcast (I3), and `catch {`
        // with no binding was what made that indistinguishable from a 403.
        // The status is read; the wire's text never is.
        if (cancelled) return;
        setPhase({ name: "blocked", reason: blockReasonForMintFailure(err) });
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

    /**
     * A refused re-mint or a fatal playback error — tear down AND show the
     * terminal state, unlike a plain unmount. `reason` is what the caller
     * learned; see `BlockReason`.
     */
    function block(reason: BlockReason) {
      teardown();
      setPhase({ name: "blocked", reason });
    }

    handle = attachHls({
      video,
      hlsUrl,
      getToken: () => tokenRef.current,
      // Fix wave 2: `unavailable`, NOT the membership pitch. A fatal
      // playback error says nothing about entitlement — and on a public
      // stream there is no membership to sell in the first place.
      onFatalError: () => block("unavailable"),
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
          } catch (err: unknown) {
            // Any refusal — a lapsed membership, a dead session, a network
            // drop, or (fix wave 2) a 409 for a stream the creator ended —
            // is the identical outcome: stop playback and show the terminal
            // state, the same collapse `mintStreamWatchToken`'s own
            // docstring describes for the FIRST mint. Only the SENTENCE
            // differs now, and it is chosen by the same function the first
            // mint uses, so the two call sites cannot drift apart.
            // UNCONDITIONAL, exactly as before fix round 2 — this branch does
            // not consult `nativeReloadMarginMs` at all, so "apply later" can
            // never become "notice a refusal later." A refusal always reaches
            // `block()` on the SAME tick it happens, on both paths.
            block(blockReasonForMintFailure(err));
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
          {blockedMessage(phase.reason)}
        </p>
      ) : null}
      {phase.name === "unsupported" ? (
        <p className="stream-player-unsupported">{STREAM_UNSUPPORTED_MESSAGE}</p>
      ) : null}
      {phase.name === "ready" ? <video ref={videoRef} controls playsInline /> : null}
    </div>
  );
}
