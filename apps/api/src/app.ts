import { Hono } from "hono";
import { healthRoute } from "./routes/health";

export function createApp() {
  const app = new Hono();
  app.route("/health", healthRoute);
  return app;
}
