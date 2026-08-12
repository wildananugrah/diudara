import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import {
  activityLogs,
  communities,
  creators,
  events,
  members,
  membershipTiers,
  outbox,
  subscriptions,
} from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { errorHandler } from "../http/error-handler";
import { AuthoriseStream } from "../application/use-cases/authorise-stream";
import { HandleStreamLifecycle } from "../application/use-cases/handle-stream-lifecycle";
import { OUTBOX_NOTIFY_STREAM_LIVE } from "../application/ports/outbox-repository.port";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../domain/watch-token";
import { DrizzleEventRepository } from "../infrastructure/repositories/drizzle-event.repository";
import { DrizzleStreamLifecycleUnitOfWork } from "../infrastructure/repositories/drizzle-stream-lifecycle.unit-of-work";
import { DrizzleSubscriptionRepository } from "../infrastructure/repositories/drizzle-subscription.repository";
import { mediamtxWebhookRoutes } from "./mediamtx-webhooks";

beforeEach(resetDatabase);

const SECRET = "c".repeat(32);
const HEADER = "X-Mediamtx-Secret";

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const authoriseStream = new AuthoriseStream(eventRepository, subscriptionRepository, {
  streamTokenSecret: SECRET,
});
const handleStreamLifecycle = new HandleStreamLifecycle(
  eventRepository,
  new DrizzleStreamLifecycleUnitOfWork(db)
);

/**
 * A REAL `AuthoriseStream`, subclassed only to make `execute` throw. Used
 * exclusively for the "no database read" test below: since `execute` is
 * the ONLY thing in this codebase that reads the database for this
 * decision, a request that reaches 401 without this throwing proves the
 * route never called it — a stronger guarantee than asserting on outcome
 * alone, and one that needs no instrumentation of the database client
 * itself. Extending the real class (rather than a plain object literal)
 * is required for the type to structurally match `AuthoriseStream`, which
 * has private constructor parameters.
 */
class ThrowingAuthoriseStream extends AuthoriseStream {
  constructor() {
    super(eventRepository, subscriptionRepository, { streamTokenSecret: SECRET });
  }
  override async execute(): Promise<{ allowed: boolean }> {
    throw new Error("AuthoriseStream.execute must not run before the secret header is verified");
  }
}

/** Same purpose as `ThrowingAuthoriseStream`, for the `/lifecycle` route's own tests. */
class ThrowingHandleStreamLifecycle extends HandleStreamLifecycle {
  constructor() {
    super(eventRepository, new DrizzleStreamLifecycleUnitOfWork(db));
  }
  override async execute(): Promise<void> {
    throw new Error(
      "HandleStreamLifecycle.execute must not run before the secret header is verified"
    );
  }
}

function app(
  authorise: AuthoriseStream = authoriseStream,
  lifecycle: HandleStreamLifecycle = handleStreamLifecycle
) {
  const a = new Hono();
  a.onError(errorHandler);
  a.route(
    "/webhooks/mediamtx",
    mediamtxWebhookRoutes({
      authoriseStream: authorise,
      mediamtxWebhookSecret: SECRET,
      handleStreamLifecycle: lifecycle,
    })
  );
  return a;
}

/** MediaMTX's own success rule (mediamtx.org docs): a status beginning with "20". */
function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function post(a: Hono<any>, body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers[HEADER] = secret;
  return a.request("/webhooks/mediamtx/auth", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Posts to `/lifecycle`, the way `infra/mediamtx.yml`'s planned `runOnOnline`/
 * `runOnOffline` `curl` commands do — a header, since these ARE shell commands
 * this codebase writes and can freely attach one to (unlike `authHTTPAddress`,
 * which `/auth`'s own tests cover separately).
 */
function postLifecycle(a: Hono<any>, body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers[HEADER] = secret;
  return a.request("/webhooks/mediamtx/lifecycle", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * The mechanism a REAL MediaMTX instance actually has available — a query
 * parameter on `authHTTPAddress`'s own URL, since MediaMTX has no way to
 * attach a custom header to that POST (see `mediamtx-webhooks.ts`'s
 * docstring). `post()` above exercises the header, which only Task 5's
 * shell-command hooks can send.
 */
function postWithQuerySecret(a: Hono<any>, body: unknown, secret: string | null = SECRET) {
  const path =
    secret === null
      ? "/webhooks/mediamtx/auth"
      : `/webhooks/mediamtx/auth?secret=${encodeURIComponent(secret)}`;
  return a.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let seedCounter = 0;

async function seedCommunity(name = "Rina") {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: `Kelas ${name}`,
      slug: `kelas-${name.toLowerCase()}-${seedCounter}`,
    })
    .returning();
  return community;
}

async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const streamKey = `route-key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return { event: event!, streamKey };
}

async function seedActiveSubscription(communityId: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62811${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status: "active" })
    .returning();
  return subscription!;
}

async function cancelSubscription(id: string) {
  await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.id, id));
}

describe("POST /webhooks/mediamtx/auth — secret verification", () => {
  it("401s a missing secret header, and never calls AuthoriseStream at all", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await post(a, { action: "publish", path: "live/anything", query: "" }, null);

    expect(res.status).toBe(401);
  });

  it("401s a wrong secret header, and never calls AuthoriseStream at all", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await post(
      a,
      { action: "publish", path: "live/anything", query: "" },
      "wrong-secret"
    );

    expect(res.status).toBe(401);
  });

  it("401s an empty secret header", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await post(a, { action: "publish", path: "live/anything", query: "" }, "");

    expect(res.status).toBe(401);
  });

  it("checks the secret BEFORE parsing the body — an unauthenticated garbage body is 401, not 400", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await a.request("/webhooks/mediamtx/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(401);
  });

  /**
   * Review round 2, important #1. A real MediaMTX's `authHTTPAddress` has
   * no way to send a custom header (mediamtx.org's docs enumerate its
   * whole config surface and none of it does this) — so accepting the
   * secret ONLY via a header, as an earlier version of this route did,
   * would 401 every genuine publish and every genuine read once wired to
   * a real MediaMTX. The query parameter is what `authHTTPAddress`'s own
   * URL can actually carry.
   */
  it("authorises via a `secret` query parameter — the mechanism a real MediaMTX can actually send", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");
    const a = app();

    const res = await postWithQuerySecret(a, { action: "publish", path: `live/${streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("401s a wrong `secret` query parameter, and never calls AuthoriseStream at all", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await postWithQuerySecret(
      a,
      { action: "publish", path: "live/anything", query: "" },
      "wrong-secret"
    );

    expect(res.status).toBe(401);
  });

  it("401s when neither the header nor the query parameter carries the secret", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await postWithQuerySecret(
      a,
      { action: "publish", path: "live/anything", query: "" },
      null
    );

    expect(res.status).toBe(401);
  });

  it("still authorises via the X-Mediamtx-Secret header when no query parameter is present — Task 5's lifecycle hooks depend on this", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");
    const a = app();

    // post() (header-only) — proves the header path was not removed while
    // adding the query-param path.
    const res = await post(a, { action: "publish", path: `live/${streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });
});

describe("POST /webhooks/mediamtx/auth — publish", () => {
  it("returns 2xx for a scheduled event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");
    const a = app();

    const res = await post(a, { action: "publish", path: `live/${streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("returns 2xx for a live event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");
    const a = app();

    const res = await post(a, { action: "publish", path: `live/${streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("refuses (non-2xx) an ended event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "ended");
    const a = app();

    const res = await post(a, { action: "publish", path: `live/${streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("refuses (non-2xx) an unknown stream key", async () => {
    const a = app();

    const res = await post(a, { action: "publish", path: "live/no-such-key", query: "" });

    expect(isSuccessStatus(res.status)).toBe(false);
  });
});

describe("POST /webhooks/mediamtx/auth — read", () => {
  it("returns 2xx for a valid token against an active, matching subscription", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await post(a, {
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
    });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("refuses once the subscription is cancelled between mint and read", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });

    await cancelSubscription(subscription.id);

    const a = app();
    const res = await post(a, {
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
    });

    expect(isSuccessStatus(res.status)).toBe(false);
  });
});

describe("POST /webhooks/mediamtx/auth — every refusal looks the same", () => {
  it("returns byte-identical bodies for unrelated refusal reasons", async () => {
    const community = await seedCommunity();
    const { streamKey: endedKey } = await seedEvent(community.id, "ended");
    const { event: liveEvent, streamKey: liveKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const validToken = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: liveEvent.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    await cancelSubscription(subscription.id);

    const a = app();

    const responses = await Promise.all([
      // "no such event"
      post(a, { action: "publish", path: "live/no-such-key", query: "" }),
      // "ended event"
      post(a, { action: "publish", path: `live/${endedKey}`, query: "" }),
      // "no token in query"
      post(a, { action: "read", path: `live/${liveKey}`, query: "" }),
      // "not entitled" (subscription cancelled after mint)
      post(a, { action: "read", path: `live/${liveKey}`, query: `token=${validToken}` }),
      // "unrecognised action"
      post(a, { action: "metrics", path: `live/${liveKey}`, query: "" }),
    ]);

    for (const res of responses) {
      expect(isSuccessStatus(res.status)).toBe(false);
    }

    const bodies = await Promise.all(responses.map((r) => r.text()));
    const statuses = responses.map((r) => r.status);

    expect(new Set(bodies).size).toBe(1);
    expect(new Set(statuses).size).toBe(1);
  });
});

describe("POST /webhooks/mediamtx/auth — end-to-end wiring", () => {
  /**
   * The only test here that goes through the REAL `bootstrap()` and
   * `createApp()` rather than a hand-built `deps` object — proving
   * `app.ts` actually mounts this route at the path MediaMTX's
   * `authHTTPAddress` will be configured with, and that `bootstrap()`
   * really does wire `AuthoriseStream` off `MEDIAMTX_WEBHOOK_SECRET` /
   * `STREAM_TOKEN_SECRET` when both are configured.
   */
  it("authorises a publish through the real bootstrap() when streaming is fully configured", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    const originals = {
      MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
      MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WEBHOOK_SECRET = SECRET;
    process.env.STREAM_TOKEN_SECRET = SECRET;

    let a: ReturnType<typeof createApp>;
    try {
      a = createApp(bootstrap());
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const allowed = await post(a, { action: "publish", path: `live/${streamKey}`, query: "" });
    expect(isSuccessStatus(allowed.status)).toBe(true);

    const wrongSecret = await post(
      a,
      { action: "publish", path: `live/${streamKey}`, query: "" },
      "wrong-secret"
    );
    expect(wrongSecret.status).toBe(401);
  });
});

/**
 * `GET /webhooks/mediamtx/auth-request` — the route Task 9 added for
 * nginx's `auth_request` to call on EVERY proxied HLS request, closing the
 * gap where MediaMTX's own `/auth` call only ever fires once per viewer
 * session (see the route's own docstring in `mediamtx-webhooks.ts` for the
 * empirical finding this responds to).
 */
/**
 * `eventId`, NOT `mtxPath` — final whole-branch review fix: nginx's
 * `auth_request` now re-authorises reads by EVENT ID (the public path
 * segment members' browsers actually request), not by stream key. See
 * `mediamtx-webhooks.ts`'s `/auth-request` docstring for the full reasoning.
 */
function getAuthRequest(
  a: Hono<any>,
  params: { eventId?: string; token?: string },
  secret: string | null = SECRET
) {
  const headers: Record<string, string> = {};
  if (secret !== null) headers[HEADER] = secret;
  if (params.eventId !== undefined) headers["X-Mtx-Event-Id"] = params.eventId;
  if (params.token !== undefined) headers["X-Watch-Token"] = params.token;
  return a.request("/webhooks/mediamtx/auth-request", { headers });
}

describe("GET /webhooks/mediamtx/auth-request — secret verification", () => {
  it("401s a missing secret header, and never calls AuthoriseStream at all", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(a, { eventId: "00000000-0000-4000-8000-000000000000" }, null);

    expect(res.status).toBe(401);
  });

  it("401s a wrong secret header, and never calls AuthoriseStream at all", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(
      a,
      { eventId: "00000000-0000-4000-8000-000000000000" },
      "wrong-secret"
    );

    expect(res.status).toBe(401);
  });

  it("does not accept the secret via a query parameter — nginx, unlike authHTTPAddress, can always send a header", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await a.request(`/webhooks/mediamtx/auth-request?secret=${encodeURIComponent(SECRET)}`, {
      headers: { "X-Mtx-Event-Id": "00000000-0000-4000-8000-000000000000" },
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /webhooks/mediamtx/auth-request — read", () => {
  it("returns 2xx for a valid token against an active, matching subscription, and returns the stream key via X-Stream-Key — never in the body", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { eventId: event.id, token });

    expect(isSuccessStatus(res.status)).toBe(true);
    // The whole point of this fix: nginx needs the stream key to rewrite
    // onto MediaMTX's internal path, but it must arrive as a HEADER
    // (`auth_request_set` reads response headers, never the body) and must
    // never appear in anything a browser-facing body could echo.
    expect(res.headers.get("X-Stream-Key")).toBe(streamKey);
    const body = await res.text();
    expect(body).not.toContain(streamKey);
  });

  it("refuses once the subscription is cancelled between mint and read — THE property this route exists for", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });

    await cancelSubscription(subscription.id);

    const a = app();
    const res = await getAuthRequest(a, { eventId: event.id, token });

    expect(isSuccessStatus(res.status)).toBe(false);
    expect(res.headers.get("X-Stream-Key")).toBeNull();
  });

  it("refuses a request naming another community's event", async () => {
    const communityA = await seedCommunity("Rina");
    const communityB = await seedCommunity("Budi");
    const { event: eventB } = await seedEvent(communityB.id, "live");
    // A subscription entitled in community A only.
    const subscription = await seedActiveSubscription(communityA.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: eventB.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { eventId: eventB.id, token });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("refuses a missing token", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const a = app();

    const res = await getAuthRequest(a, { eventId: event.id });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("refuses an unknown event id", async () => {
    const a = app();

    const res = await getAuthRequest(a, {
      eventId: "00000000-0000-4000-8000-000000000000",
      token: "anything",
    });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  /**
   * The property FIX 1 exists to guarantee: presenting a STREAM KEY where
   * this endpoint expects an EVENT ID must not resolve to anything —
   * `X-Mtx-Event-Id` is resolved via `findById`, a different column than
   * `findByStreamKey` uses, so a key is never a valid id here.
   */
  it("refuses when a stream key is presented instead of an event id", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { eventId: streamKey, token });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("refuses an expired token", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = mintWatchToken({
      subscriptionId: subscription.id,
      eventId: event.id,
      now: Date.now() - WATCH_TOKEN_TTL_MS - 1000,
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { eventId: event.id, token });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("streaming not configured (authoriseStream undefined) refuses rather than throwing", async () => {
    const a = new Hono();
    a.onError(errorHandler);
    a.route(
      "/webhooks/mediamtx",
      mediamtxWebhookRoutes({
        authoriseStream: undefined,
        mediamtxWebhookSecret: SECRET,
        handleStreamLifecycle: undefined,
      })
    );

    const res = await getAuthRequest(a, {
      eventId: "00000000-0000-4000-8000-000000000000",
      token: "x",
    });

    expect(isSuccessStatus(res.status)).toBe(false);
  });
});

describe("GET /webhooks/mediamtx/auth-request — end-to-end wiring", () => {
  it("authorises a read through the real bootstrap() when streaming is fully configured", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);

    const originals = {
      MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
      MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WEBHOOK_SECRET = SECRET;
    process.env.STREAM_TOKEN_SECRET = SECRET;

    let a: ReturnType<typeof createApp>;
    let token: string;
    try {
      a = createApp(bootstrap());
      token = mintWatchToken({
        subscriptionId: subscription.id,
        eventId: event.id,
        now: Date.now(),
        ttlMs: WATCH_TOKEN_TTL_MS,
        secret: SECRET,
      });
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const allowed = await getAuthRequest(a, { eventId: event.id, token });
    expect(isSuccessStatus(allowed.status)).toBe(true);
    expect(allowed.headers.get("X-Stream-Key")).toBe(streamKey);

    const wrongSecret = await getAuthRequest(
      a,
      { eventId: event.id, token },
      "wrong-secret"
    );
    expect(wrongSecret.status).toBe(401);
  });
});

describe("POST /webhooks/mediamtx/lifecycle — secret verification", () => {
  it("401s a missing secret header, and never calls HandleStreamLifecycle at all", async () => {
    const a = app(authoriseStream, new ThrowingHandleStreamLifecycle());

    const res = await postLifecycle(a, { hook: "online", streamKey: "live/anything" }, null);

    expect(res.status).toBe(401);
  });

  it("401s a wrong secret header, and never calls HandleStreamLifecycle at all", async () => {
    const a = app(authoriseStream, new ThrowingHandleStreamLifecycle());

    const res = await postLifecycle(
      a,
      { hook: "online", streamKey: "live/anything" },
      "wrong-secret"
    );

    expect(res.status).toBe(401);
  });

  it("checks the secret BEFORE parsing the body — an unauthenticated garbage body is 401, not 200", async () => {
    const a = app(authoriseStream, new ThrowingHandleStreamLifecycle());

    const res = await a.request("/webhooks/mediamtx/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(401);
  });

  it("authorises via a `secret` query parameter too, exactly like /auth", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");
    const a = app();

    const res = await a.request(
      `/webhooks/mediamtx/lifecycle?secret=${encodeURIComponent(SECRET)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook: "online", streamKey: `live/${streamKey}` }),
      }
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /webhooks/mediamtx/lifecycle — online", () => {
  it("moves a scheduled event to live, and answers 200", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    const a = app();

    const res = await postLifecycle(a, { hook: "online", streamKey: `live/${streamKey}` });

    expect(res.status).toBe(200);
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");
  });

  it("enqueues one notify_stream_live row per active member — a second online enqueues no more", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    await seedActiveSubscription(community.id);
    await seedActiveSubscription(community.id);
    const a = app();

    await postLifecycle(a, { hook: "online", streamKey: `live/${streamKey}` });
    const second = await postLifecycle(a, { hook: "online", streamKey: `live/${streamKey}` });

    expect(second.status).toBe(200);
    const rows = await db.select().from(outbox).where(eq(outbox.eventType, OUTBOX_NOTIFY_STREAM_LIVE));
    const forThisEvent = rows.filter(
      (row) => (row.payload as { eventId?: string } | null)?.eventId === event.id
    );
    // Two active members at go-live time, ONE row each — not one row for the
    // whole community — and the repeated `online` enqueues nothing further.
    expect(forThisEvent).toHaveLength(2);
    for (const row of forThisEvent) {
      expect(typeof (row.payload as { subscriptionId?: string }).subscriptionId).toBe("string");
    }
  });

  it("answers 200 for an unknown stream key, and writes nothing — a hook that 500s retries forever", async () => {
    const a = app();

    const res = await postLifecycle(a, { hook: "online", streamKey: "live/no-such-key" });

    expect(res.status).toBe(200);
    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });

  it("answers 200 for a malformed hook value, and writes nothing", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");
    const a = app();

    const res = await postLifecycle(a, { hook: "publishing", streamKey: `live/${streamKey}` });

    expect(res.status).toBe(200);
    const activity = await db.select().from(activityLogs);
    expect(activity).toHaveLength(0);
  });
});

describe("POST /webhooks/mediamtx/lifecycle — offline", () => {
  it("ends an event that was never live, and answers 200", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    const a = app();

    const res = await postLifecycle(a, { hook: "offline", streamKey: `live/${streamKey}` });

    expect(res.status).toBe(200);
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("ended");
  });

  it("offline then a late online leaves the event ended", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const a = app();

    await postLifecycle(a, { hook: "offline", streamKey: `live/${streamKey}` });
    await postLifecycle(a, { hook: "online", streamKey: `live/${streamKey}` });

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("ended");
  });
});

describe("POST /webhooks/mediamtx/lifecycle — end-to-end wiring", () => {
  /**
   * Same purpose as `/auth`'s own end-to-end test: proves `app.ts` mounts this
   * route where `infra/mediamtx.yml`'s planned hooks will reach it, and that
   * `bootstrap()` really does wire `HandleStreamLifecycle` off
   * `MEDIAMTX_WEBHOOK_SECRET`.
   */
  it("marks an event live through the real bootstrap() when streaming is fully configured", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    const originals = {
      MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
      MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WEBHOOK_SECRET = SECRET;
    process.env.STREAM_TOKEN_SECRET = SECRET;

    let a: ReturnType<typeof createApp>;
    try {
      a = createApp(bootstrap());
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const res = await postLifecycle(a, { hook: "online", streamKey: `live/${streamKey}` });
    expect(res.status).toBe(200);

    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("live");

    const wrongSecret = await postLifecycle(
      a,
      { hook: "online", streamKey: `live/${streamKey}` },
      "wrong-secret"
    );
    expect(wrongSecret.status).toBe(401);
  });
});
