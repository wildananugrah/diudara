import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :3000 (see apps/api). Proxying its paths means every
// `fetch("/communities/...")` in this app works unmodified against the same
// origin in dev, matching how they'll be served together in production.
//
// The React app's own client route is ALSO "/c/:slug" (see App.tsx), which
// collides with this exact proxy path: without `bypass`, a browser
// navigating to /c/some-slug never reaches the SPA at all — Vite forwards
// the top-level HTML request straight to the API and the address bar shows
// raw JSON. `bypass` tells Vite to serve index.html itself instead for
// requests that look like a page navigation (Accept: text/html), and only
// hand fetch()/XHR calls (which don't send that header) to the API.
const bypassPageNavigation: ProxyOptions["bypass"] = (req) => {
  if (req.headers.accept?.includes("text/html")) {
    return "/index.html";
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // `^/c/`, A REGEX, NOT the string `/c` it used to be — and the difference is
      // a real bug found by running this, not a tidy-up.
      //
      // Vite matches a STRING proxy context with `url.startsWith(context)`, with no
      // notion of path segments, and takes the FIRST entry that matches. So `/c`
      // also matched `/communities`, `/communities/:id/members.csv` and anything
      // else beginning with those two characters — including every dashboard API
      // path added below, which never reached their own entries at all. They still
      // worked, because the `/c` entry happens to point at the same target, but
      // they inherited `bypass`: measured here, `GET /communities` with
      // `Accept: text/html` answered 200 index.html instead of the API's 401 JSON.
      //
      // Harmless for fetch() (which sends `Accept: * /*`), and NOT harmless for
      // anything a browser NAVIGATES to — open `…/members.csv` in a new tab and the
      // download silently becomes the SPA's HTML. `^/c/` matches only real public
      // checkout paths (`/c/:slug`, `/c/:slug/checkout`,
      // `/c/subscription/:id/status`) and leaves the dashboard's paths to their own
      // entries, unbypassed.
      "^/c/": { target: "http://localhost:3000", bypass: bypassPageNavigation },
      "/webhooks": "http://localhost:3000",
      // ---------------------------------------------------------------
      // The dashboard's API paths (Phase 6, plus later additions). Every one
      // of these is reached only by fetch() from /dashboard/* screens, never
      // by a browser navigation.
      //
      // NO `bypass` ON ANY OF THESE, and the asymmetry with /c above is the
      // point rather than an oversight. `bypass` exists solely because a SPA
      // ROUTE and an API PATH share a prefix; the dashboard lives at
      // /dashboard/*, which no API route uses, so there is no collision to
      // resolve. Adding `bypass` anyway would be actively harmful: it would
      // make any request that happens to send `Accept: text/html` — a link
      // opened in a new tab, a curl typed with -H "Accept: text/html" while
      // debugging — silently answer with index.html instead of the API's JSON
      // or 401, which is exactly the confusing failure /c's comment describes,
      // just pointed the other way.
      //
      // Verified in real Chrome rather than inferred from this config: see
      // .superpowers/sdd/2026-08-10-phase6-dashboard/tasks-5-7-report.md.
      // Vite's SPA fallback serves index.html for /dashboard/* because no proxy
      // entry matches it, so a deep dashboard URL renders the app.
      // ---------------------------------------------------------------
      "/auth": "http://localhost:3000",
      "/communities": "http://localhost:3000",
      "/payment-account": "http://localhost:3000",
      "/ai": "http://localhost:3000",
      // Missing here left `GET /streaming/status` unproxied — the dev server
      // fell through to its SPA history fallback and answered 200 with
      // index.html instead of the API's JSON. `LiveStreamingNavLink` and
      // `EventsPage` (Task 7, then Task 3's browser-publishing UI) both call
      // this on mount; unproxied, `res.json()` throws on the HTML body and
      // both fail toward HIDING (see those components' own docstrings on why
      // that direction is deliberate for this one flag), so "Siaran
      // langsung" simply never appeared while running `vite dev` — found
      // while driving Task 3's UI in a real browser, not from reading this
      // file. Production is unaffected: nginx there proxies every API path
      // to apps/api regardless of this list.
      "/streaming": "http://localhost:3000",
      // THE THIRD INSTANCE OF THE SAME BUG CLASS (Task 6). Every `/users/...`
      // call (signup, login, by-handle, /users/me, both password-reset
      // endpoints — apps/web/src/user/apiClient.ts) had no entry here at
      // all, so the dev server fell through to its SPA fallback for every
      // one of them: `GET /users/by-handle/wildan` answered `200
      // text/html` with `index.html`'s body, not the API's JSON, and
      // `POST /users/signup` answered a bodiless 404 from Vite itself, never
      // reaching apps/api. All six Task 6 pages were dead under `vite dev`
      // until this was added — found by actually starting the dev server
      // and loading `/@wildan`, `/signup` and `/masuk`, exactly as `/c/`'s
      // and `/streaming`'s own history above says to. `^/users/` (a regex,
      // segment-precise with the trailing slash) rather than the string
      // `/users`, for the same reason `/c` was rewritten to `^/c/` above:
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
    },
  },
});
