import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import {
  activityLogs,
  appUsers,
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
import { EndUserStream } from "../application/use-cases/end-user-stream";
import { OUTBOX_NOTIFY_STREAM_LIVE } from "../application/ports/outbox-repository.port";
import { SystemClock } from "../infrastructure/clock/system.clock";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../domain/watch-token";
import { DrizzleEventRepository } from "../infrastructure/repositories/drizzle-event.repository";
import { DrizzleSubscriptionRepository } from "../infrastructure/repositories/drizzle-subscription.repository";
import { DrizzleUserStreamRepository } from "../infrastructure/repositories/drizzle-user-stream.repository";
import {
  mintUserWatchToken,
  USER_WATCH_TOKEN_TTL_MS,
} from "../domain/user-watch-token";
import { mediamtxWebhookRoutes } from "./mediamtx-webhooks";

beforeEach(resetDatabase);

const SECRET = "c".repeat(32);
const HEADER = "X-Mediamtx-Secret";

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const userStreamRepository = new DrizzleUserStreamRepository(db);
const authoriseStream = new AuthoriseStream(
  eventRepository,
  subscriptionRepository,
  userStreamRepository,
  { streamTokenSecret: SECRET }
);
const endUserStream = new EndUserStream(userStreamRepository, new SystemClock());

/**
 * A REAL `AuthoriseStream`, subclassed only to make its decision methods
 * throw. Used exclusively for the "no database read" tests below: these
 * three methods are the ONLY things in this codebase that read the database
 * for this decision, so a request that reaches 401 without any of them
 * throwing proves the route never called them — a stronger guarantee than
 * asserting on outcome alone, and one that needs no instrumentation of the
 * database client itself. Extending the real class (rather than a plain
 * object literal) is required for the type to structurally match
 * `AuthoriseStream`, which has private constructor parameters.
 *
 * FIX ROUND 1 (Task 4 review, Major 1 and Minor 2): only `execute` used to
 * throw here, which meant the `/auth-request` route's own "never calls
 * AuthoriseStream at all" tests proved nothing — that route never calls
 * `execute`. Both by-id entry points now throw too, so those tests mean what
 * their names say, and so the both-or-neither guard can be pinned by the one
 * property that actually distinguishes it: it must refuse BEFORE either
 * resolution is attempted.
 */
class ThrowingAuthoriseStream extends AuthoriseStream {
  constructor() {
    super(eventRepository, subscriptionRepository, userStreamRepository, {
      streamTokenSecret: SECRET,
    });
  }
  override async execute(): Promise<{ allowed: boolean }> {
    throw new Error("AuthoriseStream.execute must not run before the secret header is verified");
  }
  override async authoriseReadByEventId(): Promise<{ allowed: false }> {
    throw new Error(
      "AuthoriseStream.authoriseReadByEventId must not run before the secret header is verified, nor for a request carrying no event id"
    );
  }
  override async authoriseUserReadByStreamId(): Promise<{ allowed: false }> {
    throw new Error(
      "AuthoriseStream.authoriseUserReadByStreamId must not run before the secret header is verified, nor for a request carrying no stream id"
    );
  }
}

/**
 * Same purpose as `ThrowingAuthoriseStream` above, and used the same way — but for
 * `EndUserStream`, the `u/<key>` world's lifecycle handler and, since
 * retire-telegram Task 3 deleted `HandleStreamLifecycle`, the ONLY one `/lifecycle`
 * has left. Its `execute` throwing PROVES the route never reaches it — whether
 * because the secret check refused first, or because `parseStreamPath` found a
 * namespace this API no longer serves and the route 404'd before getting here.
 *
 * That second case is what makes this double worth more after the deletion than
 * before it. A `live/<key>` hook used to be sent to a DIFFERENT class, so "never
 * reaches EndUserStream" was a statement about dispatch. Now there is nowhere else
 * to send it, and the only two possibilities are "refused" and "treated as a user
 * stream" — so this double is what rules out the second.
 */
class ThrowingEndUserStream extends EndUserStream {
  constructor() {
    super(userStreamRepository, new SystemClock());
  }
  override async execute(): Promise<void> {
    throw new Error("EndUserStream.execute must not run for a path it does not own");
  }
}

function app(
  authorise: AuthoriseStream = authoriseStream,
  userLifecycle: EndUserStream = endUserStream
) {
  const a = new Hono();
  a.onError(errorHandler);
  a.route(
    "/webhooks/mediamtx",
    mediamtxWebhookRoutes({
      authoriseStream: authorise,
      mediamtxWebhookSecret: SECRET,
      endUserStream: userLifecycle,
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

/**
 * TASK 5 — the user world at the wire, through the endpoint a real MediaMTX
 * actually calls. This is the hole Task 4's review found: the namespace, the
 * nginx locations and the by-id read entry point all shipped, and a `u/`
 * PUBLISH was still refused, so nobody could go live at all. Every test here
 * would have failed before this task.
 */
describe("POST /webhooks/mediamtx/auth — the user world", () => {
  it("returns 2xx for a publish to a LIVE user stream", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await post(a, { action: "publish", path: `u/${stream.streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("refuses (non-2xx) a publish to an ENDED user stream", async () => {
    const stream = await seedUserStream("public");
    await userStreamRepository.endById(stream.id, new Date());
    const a = app();

    const res = await post(a, { action: "publish", path: `u/${stream.streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("returns 2xx for a read of a PUBLIC user stream with no token", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await post(a, { action: "read", path: `u/${stream.streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
  });

  it("refuses (non-2xx) a read of a GATED user stream with no token", async () => {
    const stream = await seedUserStream("members");
    const a = app();

    const res = await post(a, { action: "read", path: `u/${stream.streamKey}`, query: "" });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  it("returns 2xx for a read of a GATED user stream with a token naming it", async () => {
    const stream = await seedUserStream("members");
    const token = mintUserWatchToken({
      viewerId: "55555555-5555-4555-8555-555555555555",
      streamId: stream.id,
      now: Date.now(),
      ttlMs: USER_WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await post(a, {
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
    });

    expect(isSuccessStatus(res.status)).toBe(true);
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
      MEDIAMTX_WHIP_BASE_URL: process.env.MEDIAMTX_WHIP_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WHIP_BASE_URL = "https://whip.diudara.test";
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
  params: { eventId?: string; streamId?: string; token?: string },
  secret: string | null = SECRET
) {
  const headers: Record<string, string> = {};
  if (secret !== null) headers[HEADER] = secret;
  if (params.eventId !== undefined) headers["X-Mtx-Event-Id"] = params.eventId;
  // Task 4: the user world's header. Exactly ONE of the two ids may be
  // present on a request — see the route's own docstring.
  if (params.streamId !== undefined) headers["X-Mtx-Stream-Id"] = params.streamId;
  if (params.token !== undefined) headers["X-Watch-Token"] = params.token;
  return a.request("/webhooks/mediamtx/auth-request", { headers });
}

let userSeedCounter = 0;

/** One person, and one `live` user stream of theirs — Task 4's user world. */
async function seedUserStream(visibility: string) {
  userSeedCounter += 1;
  const [owner] = await db
    .insert(appUsers)
    .values({
      handle: `rina${userSeedCounter}`,
      email: `rina${userSeedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: "Rina",
      bio: null,
    })
    .returning();
  // 32 lowercase hex, exactly as `newStreamKey` mints — see
  // `authorise-stream.test.ts`'s own seed for why the shape matters.
  const streamKey = userSeedCounter.toString(16).padStart(32, "c");
  return userStreamRepository.startLive({
    ownerId: owner!.id,
    title: "Bedah karya",
    visibility,
    streamKey,
  });
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

  /**
   * FIX ROUND 1 — Task 4 review, MAJOR 1. Both 401 tests above name an
   * EVENT id, so a mutant that skipped `verifyCallbackToken` whenever
   * `X-Mtx-Stream-Id` was present ran this entire file green.
   *
   * The shared secret is the ONE control that makes `X-Mtx-Stream-Id`
   * non-forgeable, and the by-id user path trusts that header completely:
   * whatever it names is resolved, and its stream key comes back in a
   * response header. `location ^~ /webhooks/mediamtx/ { deny all; }` is the
   * second layer, but it lives in a config fragment the real server block
   * must remember to include — which is exactly why that block exists at
   * all. So the secret gets pinned for the surface it now guards, not only
   * for the one it guarded before.
   */
  it("401s a missing secret header on the USER-world path too, and never resolves the stream id", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(a, { streamId: "00000000-0000-4000-8000-000000000000" }, null);

    expect(res.status).toBe(401);
  });

  it("401s a wrong secret header on the USER-world path too, and never resolves the stream id", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(
      a,
      { streamId: "00000000-0000-4000-8000-000000000000" },
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
        endUserStream: undefined,
      })
    );

    const res = await getAuthRequest(a, {
      eventId: "00000000-0000-4000-8000-000000000000",
      token: "x",
    });

    expect(isSuccessStatus(res.status)).toBe(false);
  });
});

/**
 * Task 4 — the USER world's half of this same route. nginx's `^~ /u/`
 * location sends `X-Mtx-Stream-Id` (the id it captured from the public
 * `/u/<streamId>/...` URL) where `^~ /live/` sends `X-Mtx-Event-Id`, and
 * gets the same `X-Stream-Key` header back so it can rewrite onto
 * MediaMTX's unchanged `u/<streamKey>` internal path.
 */
describe("GET /webhooks/mediamtx/auth-request — the user world", () => {
  it("authorises a PUBLIC user stream by its stream id and returns the key via X-Stream-Key — never in the body", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.id });

    expect(isSuccessStatus(res.status)).toBe(true);
    expect(res.headers.get("X-Stream-Key")).toBe(stream.streamKey);
    const body = await res.text();
    expect(body).not.toContain(stream.streamKey);
  });

  it("refuses a user stream named by its publish KEY instead of its id", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.streamKey });

    expect(isSuccessStatus(res.status)).toBe(false);
    expect(res.headers.get("X-Stream-Key")).toBeNull();
  });

  /**
   * TASK 5 REPLACED THE NAME, NOT THE ASSERTION. This test used to read "the
   * gate itself arrives in Task 5" and pinned a blanket refusal of every
   * gated stream. The gate has arrived, and a gated stream with no token
   * still refuses — but now because `authoriseUserStreamRead` found no token,
   * not because the method refused everything. Its counterpart immediately
   * below is what proves that difference at THIS layer: a valid token, sent
   * the way nginx sends one, opens it.
   */
  it("refuses a MEMBERS-only user stream carrying no watch token", async () => {
    const stream = await seedUserStream("members");
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.id });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  /**
   * THE ROUTE'S OWN HALF OF THE PAYWALL, and nothing pinned it for the user
   * world before: `/auth-request` reads `X-Watch-Token` and rebuilds it into
   * the `token=...` query string `AuthoriseStream` parses. The use-case tests
   * pass that query string in directly and would go on passing if this route
   * dropped the header on the user path — the community world's tests do not
   * cover it either, since they exercise a different branch of the same
   * handler.
   */
  it("authorises a MEMBERS-only user stream with a valid watch token, and returns the key", async () => {
    const stream = await seedUserStream("members");
    const token = mintUserWatchToken({
      viewerId: "55555555-5555-4555-8555-555555555555",
      streamId: stream.id,
      now: Date.now(),
      ttlMs: USER_WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.id, token });

    expect(isSuccessStatus(res.status)).toBe(true);
    expect(res.headers.get("X-Stream-Key")).toBe(stream.streamKey);
    expect(await res.text()).not.toContain(stream.streamKey);
  });

  it("refuses a MEMBERS-only user stream with a token minted for ANOTHER stream", async () => {
    const target = await seedUserStream("members");
    const other = await seedUserStream("members");
    const token = mintUserWatchToken({
      viewerId: "55555555-5555-4555-8555-555555555555",
      streamId: other.id,
      now: Date.now(),
      ttlMs: USER_WATCH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    const a = app();

    const res = await getAuthRequest(a, { streamId: target.id, token });

    expect(isSuccessStatus(res.status)).toBe(false);
    expect(res.headers.get("X-Stream-Key")).toBeNull();
  });

  /**
   * Ambiguity is refused rather than resolved by precedence. nginx sends
   * exactly one of these two headers per location; a request carrying both
   * did not come from a location in this repository's template, and picking
   * a winner would make which world authorises the request depend on a rule
   * nobody deploying nginx can see.
   */
  it("refuses a request carrying BOTH ids — nginx sends exactly one", async () => {
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
    const stream = await seedUserStream("public");
    const a = app();

    const res = await getAuthRequest(a, { eventId: event.id, streamId: stream.id, token });

    expect(isSuccessStatus(res.status)).toBe(false);
  });

  /**
   * FIX ROUND 1 — Task 4 review, MINOR 2. This test used to pass whether or
   * not the both-or-neither guard existed: without it, `eventId!` is
   * `undefined`, `findById(undefined)` stringifies to `"undefined"`, and the
   * uuid guard turns that into a miss and a 403 anyway. The named test did
   * not test the line it was written against.
   *
   * `ThrowingAuthoriseStream` is what makes it bite. The property that
   * actually distinguishes the guard is not the status code — it is that the
   * route refuses BEFORE attempting either resolution. Delete the guard and
   * `authoriseReadByEventId` throws, which the error handler turns into a
   * 500, not a 403.
   */
  it("refuses a request carrying NEITHER id, without attempting either resolution", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(a, { token: "anything" });

    expect(res.status).toBe(403);
  });

  /**
   * FIX ROUND 2 — the four tests below remove a bet, they do not add a
   * feature.
   *
   * The two internal `auth_request` locations each CLEAR the other world's
   * id header (`proxy_set_header X-Mtx-... "";`), and nginx's documented
   * response to an empty value is to drop the field. Fix round 1 rested the
   * whole exactly-one-id rule on that: if some nginx version forwarded the
   * field present-and-empty instead, EVERY request would carry both ids and
   * BOTH worlds' HLS would go dark at once — a total outage resting on a
   * behaviour nobody in this project has run.
   *
   * `presentId` (mediamtx-webhooks.ts) now treats an empty — or
   * whitespace-only — id header as ABSENT, which is the only sane reading:
   * an empty string is not an id and nothing can ever legitimately send one.
   * These tests pin that from BOTH sides, so the nginx directives are
   * belt-and-braces rather than the thing the system depends on.
   */
  it("an EMPTY X-Mtx-Stream-Id alongside a real event id resolves the COMMUNITY world, not a 403", async () => {
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

    const res = await getAuthRequest(a, { eventId: event.id, streamId: "", token });

    expect(isSuccessStatus(res.status)).toBe(true);
    expect(res.headers.get("X-Stream-Key")).toBe(streamKey);
  });

  it("an EMPTY X-Mtx-Event-Id alongside a real stream id resolves the USER world, not a 403", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.id, eventId: "" });

    expect(isSuccessStatus(res.status)).toBe(true);
    expect(res.headers.get("X-Stream-Key")).toBe(stream.streamKey);
  });

  /**
   * A whitespace-only field is the SAME case as an empty one by the time it
   * reaches here — HTTP strips optional whitespace around a field value, so
   * `"   "` arrives as `""` (measured, see `presentId`'s docstring). Kept as
   * its own test because it is the shape a hand-written nginx variable
   * expansion would most plausibly produce, and a reader should not have to
   * know the transport rule to be sure it is handled.
   */
  it("a WHITESPACE-ONLY id header is absent too — the user world still resolves", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await getAuthRequest(a, { streamId: stream.id, eventId: "   " });

    expect(isSuccessStatus(res.status)).toBe(true);
    expect(res.headers.get("X-Stream-Key")).toBe(stream.streamKey);
  });

  it("BOTH ids empty is still the NEITHER case — refused, without attempting either resolution", async () => {
    const a = app(new ThrowingAuthoriseStream());

    const res = await getAuthRequest(a, { eventId: "", streamId: "" });

    expect(res.status).toBe(403);
  });

  it("refuses a malformed stream id rather than answering 500", async () => {
    const a = app();

    const res = await getAuthRequest(a, { streamId: "../../etc/passwd" });

    expect(res.status).toBe(403);
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
      MEDIAMTX_WHIP_BASE_URL: process.env.MEDIAMTX_WHIP_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WHIP_BASE_URL = "https://whip.diudara.test";
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
  it("401s a missing secret header, and never calls EndUserStream at all", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "online", streamKey: "u/anything" }, null);

    expect(res.status).toBe(401);
  });

  it("401s a wrong secret header, and never calls EndUserStream at all", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(
      a,
      { hook: "online", streamKey: "u/anything" },
      "wrong-secret"
    );

    expect(res.status).toBe(401);
  });

  /**
   * 401 AND NOT 404, for a `live/<key>` an unauthenticated caller sent — the
   * ordering the route's docstring promises, now that a retired namespace has a
   * status code of its own to be confused with. The secret check must still run
   * FIRST, so nothing an unauthenticated caller sends can tell it which
   * namespaces this API serves.
   */
  it("401s a retired live/<key> hook without a secret — the secret check still comes first", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "online", streamKey: "live/anything" }, null);

    expect(res.status).toBe(401);
  });

  it("checks the secret BEFORE parsing the body — an unauthenticated garbage body is 401, not 200", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await a.request("/webhooks/mediamtx/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(401);
  });

  it("authorises via a `secret` query parameter too, exactly like /auth", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await a.request(
      `/webhooks/mediamtx/lifecycle?secret=${encodeURIComponent(SECRET)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook: "offline", streamKey: `u/${stream.streamKey}` }),
      }
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /webhooks/mediamtx/lifecycle — end-to-end wiring", () => {
  /**
   * Same purpose as `/auth`'s own end-to-end test: proves `app.ts` mounts this route
   * where `infra/mediamtx.yml`'s hooks will reach it, that `bootstrap()` really does
   * wire `EndUserStream` off `MEDIAMTX_WEBHOOK_SECRET`, and that the REAL route —
   * not the locally assembled one every other test in this file uses — sends a
   * `u/<key>` hook to it.
   *
   * The community twin of this test went with `HandleStreamLifecycle` in
   * retire-telegram Task 3. What replaced it is the 404 case below, driven through
   * this same real `createApp(bootstrap())`.
   */
  it("ends a user stream through the real bootstrap() when streaming is fully configured", async () => {
    const stream = await seedUserStream("public");

    const originals = {
      MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
      MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
      MEDIAMTX_WHIP_BASE_URL: process.env.MEDIAMTX_WHIP_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WHIP_BASE_URL = "https://whip.diudara.test";
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

    const res = await postLifecycle(a, {
      hook: "offline",
      streamKey: `u/${stream.streamKey}`,
    });
    expect(res.status).toBe(200);

    const reloaded = await userStreamRepository.findById(stream.id);
    expect(reloaded!.status).toBe("ended");
  });
});

/**
 * Phase 8, Task 3 — what `/lifecycle` does now that the community world's handler
 * is gone.
 *
 * The route used to send BOTH `live/<key>` and an unparseable key to
 * `HandleStreamLifecycle`, which logged an "ignoring" line and no-op'd, and the
 * route answered 200 either way. With that class deleted there is nothing left to
 * hand either one to — so the choice was between acknowledging a path nothing can
 * serve and refusing it.
 *
 * IT REFUSES, with a 404. This route is reached by MediaMTX and by
 * `infra/mediamtx.yml`'s `curl` hooks, never by a person, so a wrong `$MTX_PATH`
 * or a stale `mediamtx.yml` has exactly one way to become visible: the hook has to
 * fail. A 200 for a namespace that no longer exists is byte-for-byte the answer a
 * healthy broadcast gets, so the deployment would look fine while every lifecycle
 * event went nowhere.
 *
 * 404 AND NEVER 5xx — the reason the route's docstring gives for not failing
 * survives intact, and it was always about RETRIES: a 5xx invites one, and no
 * amount of retrying turns `live/abc` back into a path this API serves. A 404 is
 * permanent and says so.
 *
 * THE THROWING DOUBLE IS THE OTHER HALF of each refusal test. 404 alone would
 * still pass if the route had handed the path to `EndUserStream` first and only
 * then failed to find a row — which would mean a `live/<key>` reaching the user
 * world's writer. `ThrowingEndUserStream` is what rules that out.
 */
describe("POST /webhooks/mediamtx/lifecycle — the community world is gone", () => {
  it("a community lifecycle hook is now refused, not silently handled", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "offline", streamKey: `live/${streamKey}` });

    expect(res.status).toBe(404);
    // And the community event is exactly as it was — nothing was handled.
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("scheduled");
  });

  it("an unparseable streamKey is refused too, not acknowledged", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "online", streamKey: "not-a-namespaced-path" });

    expect(res.status).toBe(404);
  });

  /**
   * The literal sentence, not the constant that holds it. It reaches a `curl`
   * command's stderr and an operator's logs, and it is the only thing telling
   * them what `$MTX_PATH` should have looked like — so it is worth pinning that
   * it says so, and that it is ENGLISH (`NotFoundError` messages are, throughout).
   */
  it("says what shape it wanted, in English", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "online", streamKey: "live/abc" });
    const body = (await res.json()) as { error: string };

    expect(body.error).toBe(
      "lifecycle streamKey does not name a stream this server handles: expected a u/<key> path"
    );
  });

  it("a user lifecycle hook still ends the stream", async () => {
    const stream = await seedUserStream("public");
    const a = app();

    const res = await postLifecycle(a, { hook: "offline", streamKey: `u/${stream.streamKey}` });

    expect(res.status).toBe(200);
    const reloaded = await userStreamRepository.findById(stream.id);
    expect(reloaded!.status).toBe("ended");
  });

  /**
   * The line the 404 must NOT cross. An `u/<key>` naming no live row is an
   * ordinary, expected no-op — an `offline` can legitimately arrive twice, and
   * `EndUserStream` documents exactly that — so it stays a 200. If this ever
   * became a 404 too, every second `offline` MediaMTX sends would start looking
   * like a misconfiguration.
   */
  it("an unknown u/<key> is still acknowledged with a 200, not refused", async () => {
    const a = app();

    const res = await postLifecycle(a, { hook: "offline", streamKey: "u/no-such-key" });

    expect(res.status).toBe(200);
  });

  /**
   * The other line the 404 must not cross, and the ordering that makes it hold:
   * `isLifecycleRequestBody` runs BEFORE the namespace guard, so a body this route
   * cannot read is acknowledged even when its `streamKey` names the retired world.
   * A hook value outside `LIFECYCLE_HOOKS` says something about one garbled
   * request, not about the deployment's path configuration.
   */
  it("a malformed hook value is still acknowledged with a 200, even on a retired live/<key>", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await postLifecycle(a, { hook: "publishing", streamKey: `live/${streamKey}` });

    expect(res.status).toBe(200);
  });

  it("a malformed body is still acknowledged with a 200", async () => {
    const a = app(authoriseStream, new ThrowingEndUserStream());

    const res = await a.request("/webhooks/mediamtx/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json", [HEADER]: SECRET },
      body: "{not json",
    });

    expect(res.status).toBe(200);
  });

  /**
   * Streaming not configured on this box. Unchanged: a 200, because there is
   * nothing wrong with the PATH — this box simply has no user-stream machinery
   * wired at all.
   *
   * ORDERING, pinned deliberately: the namespace guard runs BEFORE this check, so
   * the `live/<key>` case immediately below is a 404 even here. Were it the other
   * way round, an unconfigured box would answer 200 to a retired namespace and
   * hide the exact misconfiguration the 404 exists to surface.
   */
  it("a u/<key> hook acks 200 without throwing when streaming is not configured (endUserStream undefined)", async () => {
    const stream = await seedUserStream("public");
    const a = new Hono();
    a.onError(errorHandler);
    a.route(
      "/webhooks/mediamtx",
      mediamtxWebhookRoutes({
        authoriseStream,
        mediamtxWebhookSecret: SECRET,
        endUserStream: undefined,
      })
    );

    const res = await postLifecycle(a, { hook: "offline", streamKey: `u/${stream.streamKey}` });

    expect(res.status).toBe(200);
    // Nothing ran — the row is untouched.
    const reloaded = await userStreamRepository.findById(stream.id);
    expect(reloaded!.status).toBe("live");
  });

  it("a live/<key> hook is 404 even when streaming is not configured — the namespace guard comes first", async () => {
    const a = new Hono();
    a.onError(errorHandler);
    a.route(
      "/webhooks/mediamtx",
      mediamtxWebhookRoutes({
        authoriseStream,
        mediamtxWebhookSecret: SECRET,
        endUserStream: undefined,
      })
    );

    const res = await postLifecycle(a, { hook: "offline", streamKey: "live/anything" });

    expect(res.status).toBe(404);
  });
});

/**
 * The REAL app, through `createApp(bootstrap())` — the community twin of the
 * end-to-end test above, replaced rather than deleted. It proves the 404 is what
 * the actually-wired route does, not only what a locally assembled one does.
 */
describe("POST /webhooks/mediamtx/lifecycle — the 404 through the real bootstrap()", () => {
  it("refuses a community lifecycle hook through the real bootstrap()", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "scheduled");

    const originals = {
      MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
      MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
      MEDIAMTX_WHIP_BASE_URL: process.env.MEDIAMTX_WHIP_BASE_URL,
      MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
      STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
    };
    process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
    process.env.MEDIAMTX_WHIP_BASE_URL = "https://whip.diudara.test";
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

    expect(res.status).toBe(404);
    const [reloaded] = await db.select().from(events).where(eq(events.id, event.id));
    expect(reloaded!.status).toBe("scheduled");
  });
});
