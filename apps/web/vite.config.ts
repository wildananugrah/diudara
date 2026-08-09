import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :3000 (see apps/api). Proxying /c and /webhooks means the
// checkout page's `fetch("/c/...")` calls work unmodified against the same
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
      "/c": { target: "http://localhost:3000", bypass: bypassPageNavigation },
      "/webhooks": "http://localhost:3000",
    },
  },
});
