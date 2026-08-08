import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { communityRoutes } from "./routes/communities";
import { tierRoutes } from "./routes/tiers";
import { channelRoutes } from "./routes/channels";
import { errorHandler } from "./http/error-handler";
import type { AuthVariables } from "./http/auth.middleware";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.route("/health", healthRoute(deps));
  app.route("/auth", authRoutes(deps));
  // Nested routes for tiers/channels (Tasks 10, 11) mount at
  // /communities/:communityId/tiers and /communities/:communityId/channels.
  // They must be registered BEFORE this line so the more specific path
  // matches first — keep this route the last one mounted under /communities.
  app.route("/communities/:communityId/tiers", tierRoutes(deps));
  app.route("/communities/:communityId/channels", channelRoutes(deps));
  app.route("/communities", communityRoutes(deps));
  return app;
}
