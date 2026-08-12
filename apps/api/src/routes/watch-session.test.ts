import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { communities, creators, events, members, membershipTiers, subscriptions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../domain/watch-token";

beforeEach(resetDatabase);

const STREAM_SECRET = "e".repeat(32);

function app() {
  return createApp(bootstrap());
}

/** Same shape `mediamtx-webhooks.test.ts`'s own end-to-end tests use. */
async function withStreamingConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const originals = {
    MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
    MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
    MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
    STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
  };
  process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
  process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
  process.env.MEDIAMTX_WEBHOOK_SECRET = STREAM_SECRET;
  process.env.STREAM_TOKEN_SECRET = STREAM_SECRET;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

async function seedEvent(communityId: string, status: string, hlsPlaybackPath?: string) {
  seedCounter += 1;
  const streamKey = `watch-key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: hlsPlaybackPath ?? `https://hls.diudara.test/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return event!;
}

async function seedActiveSubscription(communityId: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62814${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status: "active" })
    .returning();
  return subscription!;
}

async function cancelSubscription(id: string) {
  await db.update(subscriptions).set({ status: "cancelled" }).where(eq(subscriptions.id, id));
}

function tokenFor(subscriptionId: string, eventId: string, secret = STREAM_SECRET, now = Date.now()) {
  return mintWatchToken({ subscriptionId, eventId, now, ttlMs: WATCH_TOKEN_TTL_MS, secret });
}

describe("GET /c/watch/:token — streaming disabled on this box", () => {
  it("403s with the generic body, never a 404 or 500", async () => {
    const a = app();

    const res = await a.request("/c/watch/anything-at-all");

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "watch link is no longer valid" });
  });
});

describe("GET /c/watch/:token — the happy path", () => {
  /**
   * FINAL WHOLE-BRANCH REVIEW CRITICAL, PINNED AT THE ROUTE LEVEL: this
   * route used to echo `event.hlsPlaybackPath` (streamKey-shaped) straight
   * to the browser. `hlsUrl` must now be built from the event id, and the
   * persisted `hlsPlaybackPath` column (still streamKey-shaped internally —
   * see `ScheduleLiveSession`/`MediaMtxAdapter`) must never appear in the
   * response body at all.
   */
  it("resolves a valid token to a URL built from the event id — never the stored, streamKey-shaped hlsPlaybackPath", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const community = await seedCommunity();
      const hlsPlaybackPath = "https://hls.diudara.test/live/watch-key-fixed/index.m3u8";
      const event = await seedEvent(community.id, "live", hlsPlaybackPath);
      const subscription = await seedActiveSubscription(community.id);
      const token = tokenFor(subscription.id, event.id);

      const res = await a.request(`/c/watch/${token}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ hlsUrl: `https://hls.diudara.test/live/${event.id}/index.m3u8` });
      expect(body.hlsUrl).not.toBe(hlsPlaybackPath);
      expect(body.hlsUrl).not.toContain("watch-key-fixed");
    });
  });

  it("still resolves once the stream has ended — the player, not this route, discovers that", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const community = await seedCommunity();
      const event = await seedEvent(community.id, "ended");
      const subscription = await seedActiveSubscription(community.id);
      const token = tokenFor(subscription.id, event.id);

      const res = await a.request(`/c/watch/${token}`);

      expect(res.status).toBe(200);
    });
  });
});

describe("GET /c/watch/:token — every refusal renders the same", () => {
  it("403s a malformed token", async () => {
    await withStreamingConfigured(async () => {
      const res = await app().request("/c/watch/not-a-real-token");
      expect(res.status).toBe(403);
    });
  });

  it("403s an expired token", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const community = await seedCommunity();
      const event = await seedEvent(community.id, "live");
      const subscription = await seedActiveSubscription(community.id);
      const past = Date.now() - WATCH_TOKEN_TTL_MS - 1000;
      const token = tokenFor(subscription.id, event.id, STREAM_SECRET, past);

      const res = await a.request(`/c/watch/${token}`);

      expect(res.status).toBe(403);
    });
  });

  it("403s a token whose subscription has since been cancelled", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const community = await seedCommunity();
      const event = await seedEvent(community.id, "live");
      const subscription = await seedActiveSubscription(community.id);
      const token = tokenFor(subscription.id, event.id);

      await cancelSubscription(subscription.id);

      const res = await a.request(`/c/watch/${token}`);

      expect(res.status).toBe(403);
    });
  });

  it("403s a token for a subscription belonging to a DIFFERENT community than the event", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const streamerCommunity = await seedCommunity("Rina");
      const otherCommunity = await seedCommunity("Budi");
      const event = await seedEvent(streamerCommunity.id, "live");
      const subscription = await seedActiveSubscription(otherCommunity.id);
      const token = tokenFor(subscription.id, event.id);

      const res = await a.request(`/c/watch/${token}`);

      expect(res.status).toBe(403);
    });
  });

  it("every refusal reason returns the byte-identical body and status", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const community = await seedCommunity();
      const event = await seedEvent(community.id, "live");
      const subscription = await seedActiveSubscription(community.id);
      const validToken = tokenFor(subscription.id, event.id);
      await cancelSubscription(subscription.id);

      const responses = await Promise.all([
        a.request("/c/watch/garbage"),
        a.request(`/c/watch/${validToken}`), // cancelled by now
        a.request(`/c/watch/${tokenFor("00000000-0000-4000-8000-000000000000", event.id)}`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(403);
      }
      const bodies = await Promise.all(responses.map((r) => r.text()));
      expect(new Set(bodies).size).toBe(1);
    });
  });
});
