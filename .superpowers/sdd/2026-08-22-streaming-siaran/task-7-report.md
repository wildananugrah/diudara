# Task 7 report — Siaran: who is live

BASE `2b8be3d`.

## What was built

- **`apps/web/src/user/SiaranPage.tsx`** — replaced the honest placeholder. Fetches `GET /streams`
  once on mount (`publicGet`, so a signed-out visitor still sees the list with everything gated
  `locked: true`). Renders each row's title and a link to the owner; branches on `stream.locked`
  alone — **never re-derives it** — into either the lock (`data-testid="stream-lock"`, exact copy
  `"Jadi anggota untuk menonton"`, links to `/@handle`) or `<StreamPlayer>`. Empty state
  (`"Belum ada siaran langsung."`) only after the first fetch settles with zero rows and no error;
  a failed fetch renders `describeRequestFailure(err)`, never the raw server string. Accepts
  optional `attachHls`/`mintToken` props, threaded straight to every `StreamPlayer`, purely for
  test injection — production (`App.tsx`) passes neither.

  **Deliberately NOT built:** the creator's own controls (title, *Khusus anggota* checkbox, *Mulai
  siaran*) that design spec §8's second half describes. This task's own brief lists exactly three
  files to touch, none a composer, and no task in this phase's dispatch plan owns a `POST /streams`
  form despite the route existing since Task 3. Recorded in the component's own docstring so a
  future task knows why it's missing rather than assuming an oversight.

- **`apps/web/src/user/StreamPlayer.tsx`** (new) — plays one unlocked row. Two effects, mirroring
  `WatchPage.tsx`'s own shape:
  - Effect 1 mints a token (skipped entirely for a `visibility: "public"` stream — the API refuses
    to mint one for it) and decides `"ready"` vs. `"blocked"`.
  - Effect 2 runs only once `"ready"` has put `<video>` on screen, calls `attachHls` (default:
    real `hls.js`, with a minimal, disclosed-gap native-Safari fallback), and — for a stream that
    needed a token — starts a `setInterval` re-mint on `DEFAULT_REMINT_INTERVAL_MS` (5 minutes,
    comfortably under the API's 10-minute `USER_WATCH_TOKEN_TTL_MS`, which this web package does
    not import — no shared home for it in `@diudara/shared`).
  - A refused re-mint (or a fatal `hls.js` error) calls `block()`: clears the interval **first**,
    destroys the attached player, then shows the lock (`data-testid="stream-player-blocked"`,
    same exact copy as the page-level lock). An ordinary unmount calls the *other* half,
    `teardown()`, which does the same clear-and-destroy but touches no state — unmounting is not a
    membership lapsing and has nothing to show.
  - `getToken()` is a closure over a `useRef`, read fresh on every `xhrSetup` call `hls.js` makes
    (the manifest, and every segment), which is what lets a background re-mint reach a manifest
    the player is already polling without reconstructing anything.

- **`apps/web/src/user/apiClient.ts`** — added `StreamView` (mirrors the API's closed
  `StreamView` projection field-for-field, `hlsPlaybackPath` optional/absent, never `null`),
  `listStreams()` (`publicGet`, so `locked` reflects the actual viewer), and
  `mintStreamWatchToken(streamId)` (`apiFetch`, `POST /streams/:id/watch-token`).

- **`apps/web/vite.config.ts`** — added a `"/streams": "http://localhost:3000"` proxy entry (plain
  string, no SPA route begins with "streams" so no `bypass` needed) — required by
  `vite-proxy-coverage.test.ts`, which now covers the two new fetch call sites.

- **`apps/web/src/App.test.tsx`** — the one pre-existing test outside this task's file list I had
  to touch. `"resolves /siaran inside the shell..."` rendered synchronously against the old
  placeholder; Siaran now loads asynchronously, so I mocked `GET /streams` and awaited
  `findByText`, the identical fix already applied to the `/beranda` and `/jelajah` tests
  immediately above it in the same file.

## Red phase

Stashed the implementation files (`SiaranPage.tsx`, `apiClient.ts`, `vite.config.ts`, plus the
not-yet-existing `StreamPlayer.tsx`) back to `HEAD`, keeping only the new/edited test files, and ran:

```
$ bun test src/user/SiaranPage.test.tsx src/user/StreamPlayer.test.tsx
 0 pass
 12 fail
 1 error   ("Cannot find module './StreamPlayer'")
Ran 12 tests across 2 files.
```

All 11 `SiaranPage.test.tsx` cases failed against the honest placeholder (no fetch, no lock, no
player, no testids); `StreamPlayer.test.tsx` failed to even resolve its import. Popped the stash to
restore the implementation.

## The re-mint loop, and how it's tested

`StreamPlayer.test.tsx` (13 tests) injects a fake `attachHls`/`mintToken` throughout — happy-dom has
no `MediaSource`, so real `hls.js` is never on the critical path of any assertion:

- **mint-before-attach**: a deferred `mintToken` promise proves `attachHls` is not called until it
  resolves; a second test confirms `getToken()` reads the minted token.
- **public skips minting**: `mintToken` is a function that throws if called at all; confirmed never
  called, `getToken()` reads `null`.
- **the interval itself**: `remintIntervalMs={5}` injected; waits for `getToken()` to change from
  its initial value (not pinned to an exact token — real timers make "exactly how many ticks landed
  by now" unknowable, so the test only asserts the property that actually matters: it changes, on
  the SAME attach call, never a second one).
- **the refused re-mint ("at minute eleven")**: `mintToken` succeeds once, then rejects. Verified:
  the attached handle's `destroy()` fires exactly once, the lock's `textContent` is the *literal*
  string `"Jadi anggota untuk menonton"` (not the component's own exported constant — see below),
  no `.m3u8` reaches the DOM once blocked, and — critically — **no further re-mint ever fires**
  (call count checked again after 60ms of real time, several interval periods past the refusal).
- **a fatal `hls.js` error** converges on the identical blocked state via the same `block()` path.
- **unmount cleanup**: the attached handle's `destroy()` fires on `unmount()`, and (same 60ms-later
  check) the interval never fires again afterward.
- **a stale mint from a REPLACED stream** (see below) — the real job of the `cancelled` flag.

## Two things this round's own mutation-testing found wrong with itself

**1. "an in-flight mint that resolves AFTER unmount never attaches" passed even with its own guard
deleted.** Per this phase's rule ("delete the guard your test names, and confirm that test fails"),
I deleted the `if (cancelled) return;` in effect 1's mint-success branch and re-ran that one test —
it stayed green. Reason: React itself already refuses to re-render an unmounted fiber, so
`setPhase` after unmount is a silent no-op regardless of any `cancelled` flag — the test's own
premise (unmount) already guarantees the property it's checking, independent of the code under
test. I kept the (harmless, and still a reasonable regression pin) unmount test, but added the test
that actually exercises what `cancelled` is *for*: **"a stale mint from a REPLACED stream never
overwrites the new stream's token"** — mount on stream A with a deferred mint, `rerender()` onto
stream B (a same-instance prop swap, not an unmount) before A's mint resolves, confirm B attaches
with B's own token, then resolve A's stale mint and confirm `getToken()` is *still* B's token, not
A's. Deleting `if (cancelled) return;` reddens this one for the right reason (see mutant table).

**2. Timing-fragile assertion, found by real failures, not by design review.** An early version of
the "re-mints on the interval" test pinned an exact sequence (`"tok-1"` then `"tok-2"`) against a
5ms real interval; it failed nondeterministically (`"tok-overflow"`, `"tok-3"`, …) because real
timers under `waitFor`'s polling can advance further than one tick before the first assertion runs.
Rewritten to assert only the property that matters — the token changes from its initial value — and
it has been reliably green since.

## Every mutant, and the named test that reddened

Each mutation was applied, its single target test run to confirm the red, then reverted; the full
web suite was green (888/888) and `tsc --noEmit` clean both before the round and after every
revert. All mutations were done working-tree-only (edit → run → revert, verified via
`grep MUTATION` finding nothing left over) rather than as separate commits.

| # | File / mutation | Test that reddened | Result |
|---|---|---|---|
| 1 | `SiaranPage.tsx`: append text onto the lock's copy | `SiaranPage — a gated stream > the lock's copy is EXACT` | Expected `"Jadi anggota untuk menonton"`, got `"...menonton sekarang"` |
| 2 | `SiaranPage.tsx`: render a hidden `<span>` with a derived `/u/:id/index.m3u8` inside the lock | `SiaranPage — a gated stream > no playback path for a gated stream reaches the DOM` | `innerHTML` contained `.m3u8` |
| 3 | `StreamPlayer.tsx`: call `setPhase("ready")` immediately, before `await mintToken(...)` | `StreamPlayer > does not attach until the token has been minted` | `calls.length` was `1`, expected `0` |
| 4 | `StreamPlayer.tsx`: `needsToken = true` unconditionally (mint even for a public stream) | `StreamPlayer > never calls mintToken, and getToken() reads null` (public-stream `mintToken` throws by design) | attach never happened; `stream-player-blocked` rendered instead |
| 5 | `StreamPlayer.tsx`: drop `clearInterval(intervalId)` from `teardown()` | `StreamPlayer > never re-mints again after the refusal` **and** `StreamPlayer > cleanup on unmount > destroys...` | mint count kept climbing (2→4, 8→19) after the point it should have stopped |
| 6 | `StreamPlayer.tsx`: drop `handle?.destroy()` from `teardown()` | `StreamPlayer > destroys the attached player and shows the lock` **and** the unmount-cleanup test | `destroyCount()` was `0`, expected `1` |
| 7 | `StreamPlayer.tsx`: drop `if (cancelled) return;` in effect 1's success branch | `StreamPlayer > a stale mint from a REPLACED stream never overwrites the new stream's token` | `getToken()` read `"tok-a-late"`, expected `"tok-b"` |
| 8 | `StreamPlayer.tsx`: drop `setPhase({name:"unsupported"})` when `attachHls` returns `null` | `StreamPlayer > shows the unsupported message` | the (non-functional) `<video>` stayed on screen instead of the message |
| 9 | `SiaranPage.tsx`: `stream.locked ?` → `false ?` (never lock) | `SiaranPage > never renders StreamPlayer for a locked row` **and** `the lock's copy is EXACT` | the locked row rendered `StreamPlayer` (which itself showed its own `stream-player-blocked` lock, since it has no `hlsPlaybackPath` to attach to — a nice belt-and-suspenders finding: even a mis-wired locked row cannot leak a player) |
| 10 | `SiaranPage.tsx`: drop `!loading` from the empty-state condition | `SiaranPage > never shows the empty-state copy while the first fetch is still in flight` | empty-state text appeared before the fetch resolved |
| 11 | `SiaranPage.tsx`: `setError(describeRequestFailure(err))` → a hardcoded string | `SiaranPage > shows a Bahasa sentence, not the raw error, on a 500` | wrong literal shown |

Mutant #9 is worth calling out on its own: it did not just redden the intended tests, it also showed
that even a completely mis-wired "never lock" bug cannot make a real playback URL reach the DOM,
because `StreamPlayer` itself refuses to attach anything when `hlsPlaybackPath` is `undefined`. That
is not a substitute for gating on `locked` correctly (mutant #9 is still a real, caught defect), but
it is a second independent line of defense against the exact hazard the brief names as most
dangerous.

## Test counts

| | pass | files |
|---|---|---|
| Baseline (`2b8be3d`, before this task) | 867 | 48 |
| After this task | 888 | 49 |
| Net | **+21** | +1 (`StreamPlayer.test.tsx`) |

`SiaranPage.test.tsx`: 2 → 11 tests. `StreamPlayer.test.tsx`: 0 → 13 (new file). One pre-existing
test (`App.test.tsx`'s `/siaran` routing case) was fixed in place, not counted as new.

`bun test src/test` (the three OOM guard files): **12 pass / 0 fail**, unchanged.

`tsc --noEmit`: clean, before commit and after every mutation revert.

## Judgement calls

1. **Creator controls (Mulai siaran form) are out of scope for this task**, despite design spec §8
   describing them as part of Siaran. My own top-level brief scopes the page to "who is live, and a
   lock where a stranger cannot watch," and the task-7 brief's file list has no composer. `progress.md`'s
   pre-dispatch scan note ("6 ↔ 7 both modify SiaranPage.tsx") turned out to be stale — Task 6's
   actual brief (`end-user-stream.ts`, the lifecycle route, the worker sweep) never touches
   `apps/web` at all. Documented in `SiaranPage.tsx`'s own docstring so this isn't silently missing.

2. **`withToken` is imported from `pages/WatchPage.tsx`, not re-implemented.** The brief says "read
   it, do not copy it wholesale" — I read that as "don't paste the 250-line component," not "don't
   reuse one pure, already-hardened, already-tested utility function via `import`." `WatchPage.tsx`
   itself is unmodified (verified: not in `git status`).

3. **`DEFAULT_REMINT_INTERVAL_MS = 5 minutes`**, not imported from the API (no shared home for
   `USER_WATCH_TOKEN_TTL_MS` in `@diudara/shared`, same situation `MAX_STREAM_TITLE_LENGTH` and
   other route-local limits are already in on the API side) — a round number, "well under ten
   minutes" being the only hard requirement, asserted as the literal `5`/`300000` in tests per this
   project's own convention rather than importing the constant this file itself exports.

4. **`StreamPlayer`'s `hls.js` recovery is deliberately simpler than `WatchPage`'s** — no bounded
   network/media-error retry loop. That loop exists in `WatchPage` to keep a six-hour forwarded link
   alive through mobile blips; here the re-mint already runs every five minutes regardless, and the
   property that actually matters (a fatal error ends cleanly, never a broken `<video>`) needs
   nothing more than calling `onFatalError` on the first fatal `hls.js` error. Disclosed as a
   possible future improvement, not silently dropped.

5. **The native-Safari fallback carries the identical disclosed gap `WatchPage.tsx` already
   records**: no `xhrSetup`-equivalent hook on a bare `<video src>`, so a re-mint cannot reach a
   request already in flight there. Left as a one-time attach with no re-mint wiring, untested (no
   iOS Safari available), rather than a half-correct reload loop that would only mask the gap.

6. **A refused mid-broadcast re-mint reuses the exact same lock copy** ("Jadi anggota untuk
   menonton") as never having been entitled in the first place, rather than a distinct "your
   membership just lapsed" sentence — the two situations offer the person no different action, so
   inventing a second sentence would be a distinction without a remedy (mirrors the reasoning
   `errorCopy.ts`'s `describeSubscribeFailure` already uses elsewhere in this codebase).

7. **`SiaranPage` and `StreamPlayer` both accept optional `attachHls`/`mintToken` injection props**
   purely for test doubles — production call sites (`App.tsx`) pass neither. This is the same DI
   shape `WatchPage`'s `attachPlayer` prop already established in this codebase.

## Self-review answers

- **What happens at minute eleven?** The 5-minute re-mint interval will have already fired at least
  once (minute ~5) well before the 10-minute token would expire. If that re-mint succeeds, playback
  continues with a fresh token. If it's refused (membership lapsed), `block()` fires immediately —
  interval cleared, player destroyed, lock shown — long before the original token could ever
  actually expire mid-request. There is no path from "the token silently stops working" to a broken
  `<video>` element; the earliest refusal always preempts expiry.
- **Can a locked stream's playback path reach the DOM by any path?** No, checked from two
  directions and both are pinned by mutation-tested guards: `SiaranPage` never renders `StreamPlayer`
  for a locked row (mutant #9), and even in a hypothetical mis-wiring, `StreamPlayer` itself refuses
  to attach anything when `stream.hlsPlaybackPath` is `undefined` — it goes straight to `"blocked"`
  without ever calling `attachHls`.

## Verification

```
$ cd apps/web && bun run test        # 888 pass / 0 fail, 49 files
$ cd apps/web && bun run typecheck   # clean
$ git status --porcelain             # clean at time of commit
```

`git status` is clean; commit follows this report.
