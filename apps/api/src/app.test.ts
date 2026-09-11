import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import type { Dependencies } from "./bootstrap";

/**
 * The routing table, pinned as an EXACT SET.
 *
 * Retire-telegram Task 4 deleted the community-scoped API — `/ai`, `/communities`,
 * `/communities/:communityId/tiers` and the two public `/c` routers — and Task 7's
 * fix round deleted the last two OLD-world mounts, `/auth` (creator signup and
 * login) and `/payment-account` (a creator's Xendit onboarding). Task 1 had
 * deleted the dashboard that was their only caller, so both had been
 * unreachable for six tasks while this table still protected them.
 *
 * `/communities` IS BACK, and it is not the router that was deleted. Phase 1
 * (communities-core) mounts a new one — six routes at first, then eight with
 * community-feed's `GET`/`POST /communities/:slug/posts`, now eighteen with
 * Phase 3's `GET /communities/:slug/events`, Phase 4a's four document routes,
 * Phase 5's four checkout routes and Phase 6's `GET /communities/:slug/stats` — for communities
 * owned by an `app_user`; the creator-owned tables the old one read were
 * dropped in that phase's first task. EIGHT MOUNTS NOW, all of them new-world.
 * The exact-set assertions below are what make the distinction checkable: the
 * `/communities` paths are spelled out, so the old router's
 * `/communities/:communityId/tiers` shape cannot quietly return under the same
 * prefix.
 *
 * A `not.toContain("/communities")` check would have passed just as happily with
 * `/ai` still mounted, which is why every assertion in this file compares a whole
 * sorted set against literals rather than probing for absences. That is also
 * what made the two dead mounts visible: they had to be spelled out here to
 * stay green.
 *
 * `createApp` is driven with an EMPTY dependency object on purpose: route
 * registration must not read a single dependency, and after Task 4 it does not.
 * The one router that registered a route conditionally — `public-community.ts`,
 * which mounted `POST /c/:slug/checkout` only when `startCheckout` was defined —
 * went with the community checkout, so this table is now the whole truth for
 * every environment rather than for a fully-configured one. If a future route is
 * registered behind an `if (deps.x)`, this file goes red on the day it lands and
 * the fix is to say so here, not to hand the stub that dependency.
 */
describe("the app's routing table", () => {
  /** Every `(method, path)` Hono has registered, deduplicated and sorted. */
  function registeredRoutes(): string[] {
    const app = createApp({} as Dependencies);
    return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort();
  }

  /**
   * The literal prefixes passed to `app.route(...)` in `app.ts`, deduplicated.
   *
   * Read out of the SOURCE because a mount prefix leaves no distinguishable trace
   * in `app.routes` — Hono flattens `app.route("/users", postRoutes(deps))` into the
   * sub-router's own full paths, so `/users` mounted once and `/users` mounted three
   * times are indistinguishable downstream. The behavioural table above is the
   * positive control that keeps this honest: a router mounted at a prefix that
   * appears here and nowhere in that table would have to register no routes at all.
   */
  function mountedPrefixes(): string[] {
    const source = readFileSync(join(import.meta.dir, "app.ts"), "utf8");
    const prefixes = [...source.matchAll(/app\.route\("([^"]+)"/g)].map((m) => m[1]!);
    // A POSITIVE control: a regex that silently stopped matching would make the
    // set-equality below pass vacuously against an empty list.
    expect(prefixes.length).toBeGreaterThanOrEqual(7);
    return [...new Set(prefixes)].sort();
  }

  it("mounts exactly the surviving routers", () => {
    expect(mountedPrefixes()).toEqual([
      "/communities",
      "/health",
      "/streams",
      "/users",
      "/webhooks",
      "/webhooks/mediamtx",
    ]);
  });

  it("registers exactly these routes and no others", () => {
    expect(registeredRoutes()).toEqual([
      "DELETE /communities/:slug/documents/:id",
      "DELETE /communities/:slug/join",
      "DELETE /communities/:slug/lessons/:id",
      "DELETE /communities/:slug/sections/:id",
      "DELETE /streams/:id",
      "DELETE /users/:handle/follow",
      "DELETE /users/:handle/subscribe",
      "DELETE /users/comments/:id",
      "DELETE /users/posts/:id",
      "GET /communities",
      "GET /communities/:slug",
      "GET /communities/:slug/documents",
      "GET /communities/:slug/documents/:id",
      "GET /communities/:slug/events",
      "GET /communities/:slug/members",
      "GET /communities/:slug/posts",
      "GET /communities/:slug/stats",
      "GET /communities/:slug/syllabus",
      "GET /communities/:slug/tiers",
      "GET /health",
      "GET /streams",
      "GET /users/:handle/followers",
      "GET /users/:handle/following",
      "GET /users/:handle/posts",
      "GET /users/by-handle/:handle",
      "GET /users/explore",
      "GET /users/feed",
      "GET /users/limits",
      "GET /users/me",
      "GET /users/me/conversations",
      "GET /users/me/conversations/:id/messages",
      "GET /users/me/membership-requests",
      "GET /users/me/notifications",
      "GET /users/me/payout",
      "GET /users/me/subscribers",
      "GET /users/me/tiers",
      "GET /users/media/:id",
      "GET /users/media/:id/thumb",
      "GET /users/posts/:id",
      "GET /users/posts/:id/comments",
      "GET /webhooks/mediamtx/auth-request",
      "PATCH /communities/:slug/tiers/:tierId",
      "PATCH /users/me",
      "PATCH /users/me/tiers/:tierId",
      "PATCH /users/posts/:id",
      "POST /communities",
      "POST /communities/:slug/documents",
      "POST /communities/:slug/join",
      "POST /communities/:slug/lessons",
      "POST /communities/:slug/posts",
      "POST /communities/:slug/sections",
      "POST /communities/:slug/subscribe",
      "POST /communities/:slug/tiers",
      "POST /streams",
      "POST /streams/:id/watch-token",
      "POST /users/:handle/follow",
      "POST /users/:handle/subscribe",
      "POST /users/login",
      "POST /users/logout",
      "POST /users/me/conversations",
      "POST /users/me/conversations/:id/messages",
      "POST /users/me/conversations/:id/read",
      "POST /users/me/membership-requests/:id/approve",
      "POST /users/me/membership-requests/:id/reject",
      "POST /users/me/notifications/read",
      "POST /users/me/payout",
      "POST /users/me/subscribers/:handle/revoke",
      "POST /users/me/tiers",
      "POST /users/media",
      "POST /users/password-reset/complete",
      "POST /users/password-reset/request",
      "POST /users/posts",
      "POST /users/posts/:id/comments",
      "POST /users/signup",
      "POST /webhooks/mediamtx/auth",
      "POST /webhooks/mediamtx/lifecycle",
      "POST /webhooks/xendit",
    ]);
  });

  /**
   * The `/c` namespace, named route by route because two of these three were
   * pinned individually elsewhere and would otherwise lose their guard with the
   * file that held it.
   *
   * `GET /c/:slug` is binding: Task 2's review left it answering
   * `acceptingNewMembers: true` for a request-mode community whose join path
   * Task 2 had already deleted, and `get-public-community.test.ts:176` pinned
   * that wrong answer.
   *
   * `GET /c/watch/:token` carries forward the assertion Task 3 wrote in
   * `routes/subscription-status.test.ts` ("GET /c/watch/:token is gone
   * entirely") — that file goes with the status route it tested, and the
   * property it guarded is that no public unauthenticated endpoint mints or
   * redeems a community watch credential.
   */
  it("serves nothing under /c any more", async () => {
    const app = createApp({} as Dependencies);
    expect((await app.request("/c/some-slug")).status).toBe(404);
    expect((await app.request("/c/subscription/some-id/status")).status).toBe(404);
    expect((await app.request("/c/watch/some-token")).status).toBe(404);
  });
});
