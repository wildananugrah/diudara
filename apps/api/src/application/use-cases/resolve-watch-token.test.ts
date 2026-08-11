import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { communities, creators, events, members, membershipTiers, subscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import { ResolveWatchToken } from "./resolve-watch-token";

beforeEach(resetDatabase);

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = Date.parse("2026-08-11T10:00:00.000Z");
const HLS_PATH = "https://fake-mediamtx.local/live/key/index.m3u8";

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const useCase = new ResolveWatchToken(eventRepository, subscriptionRepository, {
  streamTokenSecret: SECRET,
});

let seedCounter = 0;

/** A fresh community, owned by a fresh creator — the minimum an event needs. */
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

/** One event in `communityId`, at the given `status`, with a fresh stream key. */
async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const streamKey = `key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: HLS_PATH,
    })
    .returning();
  return event!;
}

/** An `active` subscription to a fresh tier of `communityId`. */
async function seedActiveSubscription(communityId: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62812${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
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

function tokenFor(subscriptionId: string, eventId: string, secret = SECRET, now = NOW) {
  return mintWatchToken({ subscriptionId, eventId, now, ttlMs: WATCH_TOKEN_TTL_MS, secret });
}

describe("ResolveWatchToken — the happy path", () => {
  it("resolves a valid token for an active subscription to the event's HLS URL", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: true, hlsUrl: HLS_PATH });
  });

  /**
   * THE deliberate difference from `AuthoriseStream`: a stream that has
   * already ended must still resolve, so `hls.js` can reach the point of
   * discovering that for itself (design spec §8) instead of this route
   * making an ended stream indistinguishable from a dead link.
   */
  it("still resolves once the event has ended — the player, not this route, discovers that", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "ended");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: true, hlsUrl: HLS_PATH });
  });

  it("also resolves a merely scheduled event's URL — nothing here gates on lifecycle status", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "scheduled");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result.allowed).toBe(true);
  });
});

describe("ResolveWatchToken — every refusal reason", () => {
  it("refuses a malformed token", async () => {
    const result = await useCase.execute({ token: "not-a-real-token", now: NOW });
    expect(result).toEqual({ allowed: false });
  });

  it("refuses an expired token", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({ token, now: NOW + WATCH_TOKEN_TTL_MS + 1 });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a token signed with the wrong secret", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id, OTHER_SECRET);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a token naming an event that does not exist", async () => {
    const community = await seedCommunity();
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000");

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a token naming a subscription that does not exist", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const token = tokenFor("00000000-0000-4000-8000-000000000000", event.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * THE property this task exists to preserve: a token minted while active
   * must stop working the moment the subscription is cancelled — re-checked
   * live, never trusted from the signature alone.
   */
  it("refuses once the subscription is cancelled after the token was minted", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    await cancelSubscription(subscription.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a subscription that is active, but for a DIFFERENT community than the event's", async () => {
    const streamerCommunity = await seedCommunity("Rina");
    const otherCommunity = await seedCommunity("Budi");
    const event = await seedEvent(streamerCommunity.id, "live");
    const subscription = await seedActiveSubscription(otherCommunity.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({ token, now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * Every refusal reason collapses to the SAME shape — never a distinguishing
   * field — so the route can hand back one generic body regardless of why.
   */
  it("every refusal reason is byte-identical: exactly `{ allowed: false }`, nothing else", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const validToken = tokenFor(subscription.id, event.id);
    await cancelSubscription(subscription.id);

    const results = await Promise.all([
      useCase.execute({ token: "garbage", now: NOW }),
      useCase.execute({ token: validToken, now: NOW }), // cancelled by now
      useCase.execute({ token: tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000"), now: NOW }),
    ]);

    for (const result of results) {
      expect(result).toEqual({ allowed: false });
    }
  });
});
