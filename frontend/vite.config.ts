import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in dev too, so VITE_API_URL can stay unset and the app uses
    // the production default of "/api" in both environments.
    proxy: {
      "/api": { target: "http://127.0.0.1:3004", changeOrigin: true },

      /**
       * HLS playback. MediaMTX binds :8888 to loopback only — nginx is the public
       * front door in production (see deploy/nginx/diudara2.mhamzah.id, which
       * must keep the same `/hls` prefix), and this is its dev equivalent.
       *
       * The Location rewrite is load-bearing. MediaMTX answers the first request
       * of a playback with `302 Location: /c/<key>/index.m3u8?cookieCheck=1…` —
       * an absolute path WITHOUT our prefix, so the browser would follow it to
       * `/c/…` on this origin, miss every route and land on the SPA's index.html.
       * Captured from a real playback, not guessed.
       */
      "/hls": {
        target: "http://127.0.0.1:8888",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hls/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const location = proxyRes.headers.location;
            if (typeof location === "string" && location.startsWith("/")) {
              proxyRes.headers.location = `/hls${location}`;
            }
          });
        },
      },
    },
  },
});
