import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :3000 (see apps/api). Proxying its paths means every
// `fetch("/users/...")` in this app works unmodified against the same
// origin in dev, matching how they'll be served together in production.
//
// Retire-telegram Task 4 removed the `^/c/` entry and, with it, the
// `bypassPageNavigation` helper this file used to open with. That helper
// existed for ONE collision: the SPA's own `/c/:slug` route and the API's
// public community path shared a prefix, so a browser NAVIGATION to
// `/c/some-slug` was forwarded to the API and the address bar showed raw
// JSON. Task 1 deleted the SPA route and Task 4 deleted the API path, so
// there is no collision left to resolve.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/webhooks": "http://localhost:3000",
      // ---------------------------------------------------------------
      // Retire-telegram Task 4 removed the entries that used to head this
      // block — `/communities`, `/ai` and `^/c/` — with the API routes they
      // forwarded to, and `/streaming`, which retire-telegram Task 3 had
      // already orphaned. Every key left is one the API still serves.
      //
      // The lesson those entries were written to record survives them, and
      // is why this comment does: a MISSING entry does not fail loudly.
      // Vite's SPA history fallback answers `200 text/html` with
      // `index.html`'s body, so `res.json()` throws on a call that looks like
      // it reached the API — that is how `GET /streaming/status`, and then the
      // whole of Task 6's `/users/*` surface, were dead under `vite dev` while
      // every test passed. `vite-proxy-coverage.test.ts` is the guard against
      // it happening a fourth time. Production is unaffected either way:
      // nginx there proxies every API path to apps/api regardless of this list.
      //
      // NO ENTRY HERE CARRIES A `bypass`, and that is deliberate rather than
      // an oversight. `bypass` existed solely to resolve the `/c` collision
      // described at the top of this file; adding it anywhere else would make
      // a request that happens to send `Accept: text/html` — a link opened in
      // a new tab, a curl typed with -H "Accept: text/html" while debugging —
      // silently answer with index.html instead of the API's JSON or 401.
      // ---------------------------------------------------------------
      // Retire-telegram Task 7's fix round removed `/auth` and
      // `/payment-account` from here, with the apps/api mounts they forwarded
      // to: the OLD creator login and the creator's Xendit onboarding, whose
      // only caller was the dashboard Task 1 deleted. They are the two entries
      // `vite-proxy-coverage.test.ts`'s reverse check caught as forwarding
      // nothing this app fetches.
      // THE THIRD INSTANCE OF THE SAME BUG CLASS (Task 6). Every `/users/...`
      // call (signup, login, by-handle, /users/me, both password-reset
      // endpoints — apps/web/src/user/apiClient.ts) had no entry here at
      // all, so the dev server fell through to its SPA fallback for every
      // one of them: `GET /users/by-handle/wildan` answered `200
      // text/html` with `index.html`'s body, not the API's JSON, and
      // `POST /users/signup` answered a bodiless 404 from Vite itself, never
      // reaching apps/api. All six Task 6 pages were dead under `vite dev`
      // until this was added — found by actually starting the dev server
      // and loading `/@wildan`, `/signup` and `/masuk`, exactly as the
      // `/c/` and `/streaming` history above says to. `^/users/` (a regex,
      // segment-precise with the trailing slash) rather than the string
      // `/users`, for the same reason `/c` was once rewritten to `^/c/`:
      // this app's own SPA routes are single path segments
      // (`/signup`, `/masuk`, `/pengaturan`, `/:handleParam`, …), none of
      // which begin with `users`, so there is no real collision to guard
      // against — but a bare string prefix would still be one character
      // away from accidentally matching a future `/users-something` SPA
      // route, and the regex costs nothing to make it precise now. No
      // `bypass`, and note that "these are only ever `fetch()`ed" stopped being
      // true in Phase 4: `GET /users/media/:id/thumb` arrives as an `<img
      // src>`, which is a browser navigation-ish subresource load, not a
      // `fetch`. Harmless — this entry declares no `bypass` for that rule to
      // interact with — but the reasoning below it is what a future `bypass`
      // would be written against, so it says what is actually true.
      "^/users/": "http://localhost:3000",
      // Task 7 (Phase 7's Siaran): `GET /streams` and
      // `POST /streams/:id/watch-token` (`apps/web/src/user/apiClient.ts`).
      // A plain string, not a regex like `^/users/` above — no SPA route in
      // this app begins with "streams", so there is no page navigation to
      // protect with `bypass`, matching `/auth` and `/payment-account` above
      // rather than the regex entry.
      "/streams": "http://localhost:3000",
      // NOT PROXIED, DELIBERATELY: `/u/` (M5, final whole-branch review).
      // `/u/<streamId>/index.m3u8` is HLS playback, and in production nginx
      // serves it from MediaMTX after an `auth_request` — apps/api on :3000
      // has no bytes to give it, so a proxy entry here would forward every
      // segment request to a 404 instead of the SPA fallback it hits today.
      // There is nothing to point it AT on a dev box, which is why the
      // community world's `/live/` has never been proxied either. Live
      // playback under `vite dev` needs a real MediaMTX and a real nginx;
      // that is what `gate-checklist.md` is for. Recorded here so nobody
      // spends an afternoon "fixing" it.
    },
  },
});
