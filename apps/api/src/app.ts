import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono();
  app.route("/health", healthRoute(deps));
  return app;
}
