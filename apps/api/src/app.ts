import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { communityRoutes } from "./routes/communities";
import { tierRoutes } from "./routes/tiers";
import { channelRoutes } from "./routes/channels";
import { membershipRoutes } from "./routes/memberships";
import { analyticsRoutes } from "./routes/analytics";
import { paymentAccountRoutes } from "./routes/payment-account";
import { publicCommunityRoutes } from "./routes/public-community";
import { publicSubscriptionRoutes } from "./routes/public-subscription";
import { webhookRoutes } from "./routes/webhooks";
import { mediamtxWebhookRoutes } from "./routes/mediamtx-webhooks";
import { aiRoutes } from "./routes/ai";
import { eventRoutes } from "./routes/events";
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
  // Task 4's MediaMTX authorisation webhook. Public by design and
  // authenticated the same way as the routes above — X-Mediamtx-Secret
  // rather than a bearer token — so never put it behind requireAuth either.
  // A distinct path prefix from /webhooks/xendit and /webhooks/telegram, so
  // mount order relative to webhookRoutes above does not matter.
  app.route("/webhooks/mediamtx", mediamtxWebhookRoutes(deps));
  // Nested routes for tiers/channels (Tasks 10, 11) mount at
  // /communities/:communityId/tiers and /communities/:communityId/channels.
  // They must be registered BEFORE this line so the more specific path
  // matches first — keep this route the last one mounted under /communities.
  app.route("/communities/:communityId/tiers", tierRoutes(deps));
  app.route("/communities/:communityId/channels", channelRoutes(deps));
  app.route("/communities/:communityId/members", membershipRoutes(deps));
  // Task 3's scheduling endpoint. Same reason as tiers/channels above: it must
  // be registered before the catch-all /communities mount so this more
  // specific path matches first.
  app.route("/communities/:communityId/events", eventRoutes(deps));
  // Phase 6's dashboard reads: /communities/:communityId/metrics, /activity,
  // /members and /members.csv. Mounted at /communities rather than at
  // /communities/:communityId because `members.csv` is a SIBLING path segment of
  // `members`, so it falls outside the membershipRoutes mount above.
  //
  // Its middleware is per-route, never `use("*")` — a `*` under /communities also
  // matches /communities itself, so a communityId check there would 400 the
  // community list and create endpoints. See routes/analytics.ts.
  app.route("/communities", analyticsRoutes(deps));
  app.route("/communities", communityRoutes(deps));
  // Phase 7's AI co-builder chat. A distinct top-level path, so mount order
  // relative to /communities does not matter.
  app.route("/ai", aiRoutes(deps));
  return app;
}
