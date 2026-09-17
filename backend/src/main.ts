import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env.ts";
import { createContainer } from "./container.ts";
import { buildRoutes } from "./presentation/routes.ts";
import { authenticate, errorHandler, type AppEnv } from "./presentation/middleware.ts";

const container = createContainer();
const app = new Hono<AppEnv>();

app.use("*", logger());
app.use("*", cors({
  origin: env.CORS_ORIGINS,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));
app.use("*", authenticate(container.tokens));
app.onError(errorHandler);

app.get("/health", (c) => c.json({ ok: true, service: "diudara-api" }));

// Everything under one prefix. nginx then needs a single `location /api` block,
// which is what prevents the "route falls through to the SPA and returns
// index.html instead of JSON" failure the existing nginx config documents.
app.route("/api", buildRoutes(container));

app.notFound((c) => c.json({ error: { code: "not_found", message: "Endpoint tidak ditemukan" } }, 404));

// Bun.serve() explicitly, NOT `export default { port, fetch }`. The default-export
// form only starts a server when Bun runs this file as the entrypoint. pm2's fork
// mode imports it through its own wrapper (ProcessContainerForkBun.js), where the
// default export is just an object nobody hands to Bun — the process sat "online"
// in pm2 with nothing listening on the port. Bun.serve() works under both.
// Bound to loopback: nginx is the only client, so there is no reason for :3004 to
// be reachable from outside this host.
const server = Bun.serve({ hostname: "127.0.0.1", port: env.PORT, fetch: app.fetch, idleTimeout: 60 });

console.log(`[diudara-api] listening on http://${server.hostname}:${server.port}`);
