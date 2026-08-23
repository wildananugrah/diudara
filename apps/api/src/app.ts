import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { postRoutes } from "./routes/posts";
import { mediaRoutes } from "./routes/media";
import { paymentAccountRoutes } from "./routes/payment-account";
import { webhookRoutes } from "./routes/webhooks";
import { mediamtxWebhookRoutes } from "./routes/mediamtx-webhooks";
import { streamRoutes } from "./routes/streams";
import { errorHandler } from "./http/error-handler";
import type { AuthVariables } from "./http/auth.middleware";
import type { Dependencies } from "./bootstrap";

export function createApp(deps: Dependencies) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.route("/health", healthRoute(deps));
  app.route("/auth", authRoutes(deps));
  // Phase 9's personal accounts — distinct from creator auth above. A
  // separate top-level path, so mount order relative to /auth does not matter.
  //
  // TWO routers share this one prefix, deliberately (Task 2 of
  // posts-and-feed): mounting `postRoutes` here rather than growing
  // `routes/users.ts` again keeps that file from becoming a catch-all.
  //
  // ORDER IS LOAD-BEARING HERE, unlike every other pair of routers mounted at
  // a shared prefix in this file — and `userRoutes` MUST be mounted first.
  // Task 2 review round 1 had this the other way round, on the claim that no
  // route in either file shares a literal shape with a route in the other;
  // that claim was false. Nothing reserves a handle (`domain/handle.ts`'s
  // pattern is `/^[a-z0-9_]{3,30}$/`, no denylist — the same gap `/c` below
  // already records for slugs), so a real user can register the handle
  // "posts". With `postRoutes` mounted first, Hono matches its own routes
  // against an incoming path BEFORE falling through to `userRoutes`, so
  // `GET /users/by-handle/posts` was captured by this router's
  // `GET /:handle/posts` (a 404, since "by-handle" is not a real handle) and
  // `POST /users/posts/follow` was captured by `POST /posts/:id` (measured:
  // a 200 that should have been a 404, and the matching `DELETE` a 500 from
  // an id that is not a uuid — see I3's fix below for why that path is now a
  // 400 instead). Mounting `userRoutes` first means ITS routes — including
  // `/by-handle/:handle` and `/:handle/follow` — get first refusal, and a
  // handle equal to `postRoutes`' own literal segments (`posts`, `feed`)
  // stops being able to shadow them. `routes/posts.test.ts`'s
  // "two routers on one prefix" block drives requests through THIS file's
  // own exported `createApp`, not a locally reconstructed stand-in, and goes
  // red if these two lines are swapped back — see that test for why a
  // second, hand-built Hono instance would not have caught this the first
  // time.
  app.route("/users", userRoutes(deps));
  app.route("/users", postRoutes(deps));
  // Task 4 (images): `POST /users/media`. Same rule as `postRoutes` above —
  // must come after `userRoutes` so a handle equal to this router's own
  // literal segment ("media", reserved in `domain/handle.ts`) can never
  // shadow it. Mount order relative to `postRoutes` does not matter: neither
  // router declares a literal segment the other one does.
  app.route("/users", mediaRoutes(deps));
  app.route("/payment-account", paymentAccountRoutes(deps));
  // Public by design and authenticated by X-CALLBACK-TOKEN instead of a bearer
  // token — see routes/webhooks.ts. Never put this behind requireAuth.
  app.route("/webhooks", webhookRoutes(deps));
  // Task 4's MediaMTX authorisation webhook (`/auth`) and Task 5's lifecycle
  // webhook (`/lifecycle`). Public by design and authenticated the same way
  // as the routes above — a shared secret (a `secret` query parameter or
  // X-Mediamtx-Secret header) rather than a bearer token — so never put
  // either behind requireAuth. A distinct path prefix from /webhooks/xendit,
  // so mount order relative to webhookRoutes above does not matter.
  app.route("/webhooks/mediamtx", mediamtxWebhookRoutes(deps));
  // Phase 7's Siaran (Task 3): GET /streams (public), POST /streams and
  // DELETE /streams/:id (a person's own broadcast). A distinct top-level path,
  // and since retire-telegram Task 3 deleted /streaming (the dashboard's "is
  // live streaming configured" flag for the OLD, community world) it is no
  // longer one careless read away from a near-identical sibling.
  //
  // Retire-telegram Task 4 removed every remaining mount that used to sit
  // between this one and /webhooks/mediamtx above — /c (twice, for the public
  // community page and the public checkout/status pair), /communities,
  // /communities/:communityId/tiers and /ai — along with the ordering rules
  // that governed them: the /c pair's slug-shadowing note, and the rule that
  // kept the nested tier mount ahead of the catch-all /communities one. Every
  // prefix left in this file is distinct at its first segment except /users,
  // whose three routers keep the ordering rule documented above them, so no
  // mount order below /users is load-bearing any more. `app.test.ts` pins the
  // whole set.
  app.route("/streams", streamRoutes(deps));
  return app;
}
