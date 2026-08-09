import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { communityRoutes } from "./routes/communities";
import { tierRoutes } from "./routes/tiers";
import { channelRoutes } from "./routes/channels";
import { paymentAccountRoutes } from "./routes/payment-account";
import { publicCommunityRoutes } from "./routes/public-community";
import { publicSubscriptionRoutes } from "./routes/public-subscription";
import { webhookRoutes } from "./routes/webhooks";
import { errorHandler } from "./http/error-handler";
import type { AuthVariables } from "./http/auth.middleware";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.route("/health", healthRoute(deps));
  app.route("/auth", authRoutes(deps));
  app.route("/payment-account", paymentAccountRoutes(deps));
  // Mounted before publicCommunityRoutes: /c/:slug is a single path segment,
  // while this route's literal "subscription" prefix and its 3-segment shape
  // never collide with it — but ordering it first makes that reasoning
  // visible instead of relying on segment-count math staying true forever.
  app.route("/c", publicSubscriptionRoutes(deps));
  app.route("/c", publicCommunityRoutes(deps));
  // Public by design and authenticated by X-CALLBACK-TOKEN instead of a bearer
  // token — see routes/webhooks.ts. Never put this behind requireAuth.
  app.route("/webhooks", webhookRoutes(deps));
  // Nested routes for tiers/channels (Tasks 10, 11) mount at
  // /communities/:communityId/tiers and /communities/:communityId/channels.
  // They must be registered BEFORE this line so the more specific path
  // matches first — keep this route the last one mounted under /communities.
  app.route("/communities/:communityId/tiers", tierRoutes(deps));
  app.route("/communities/:communityId/channels", channelRoutes(deps));
  app.route("/communities", communityRoutes(deps));
  return app;
}
