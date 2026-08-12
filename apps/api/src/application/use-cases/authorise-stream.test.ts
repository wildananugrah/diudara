import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { communities, creators, events, members, membershipTiers, subscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import { AuthoriseStream } from "./authorise-stream";

beforeEach(resetDatabase);

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = Date.parse("2026-08-11T10:00:00.000Z");

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const useCase = new AuthoriseStream(eventRepository, subscriptionRepository, {
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
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return { event: event!, streamKey };
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
    .values({ whatsappNumber: `+62810${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
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

describe("AuthoriseStream — publish", () => {
  it("allows a publish to a scheduled event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("allows a publish to a live event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("refuses a publish to an ended event — a finished session must not be republishable", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "ended");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a publish against an unknown stream key", async () => {
    const result = await useCase.execute({
      action: "publish",
      path: "live/no-such-key",
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  /**
   * Review round 2, minor #2: `streamKeyFromPath` used to take the LAST
   * path segment regardless of what came before it, so `foo/bar/<key>`
   * authorised a publish exactly as `live/<key>` did — even though
   * `MediaMtxAdapter.createSession` never constructs anything but
   * `live/<key>`. Not itself an access-control hole (the key still has to
   * be real), but Task 5's `runOnOnline` would then fire with
   * `MTX_PATH=foo/bar/<key>`, marking the event `live` while every
   * member's HLS URL (built from `live/<key>`) points at nothing.
   */
  it("refuses a publish whose path is not under the live/ prefix, even with a real key", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    const result = await useCase.execute({
      action: "publish",
      path: `foo/bar/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });
});

describe("AuthoriseStream — read", () => {
  it("allows a read with a valid token for an active subscription in the event's community", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  /**
   * THE test this task exists to get right. The token is minted while the
   * subscription is genuinely active — proving it would have worked — and
   * the cancellation is driven BETWEEN the mint and the read, through a real
   * database write, rather than minting a token that was already invalid.
   */
  it("refuses a read once the subscription is cancelled after the token was minted", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    await cancelSubscription(subscription.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a token minted for event A when used against event B's path", async () => {
    const community = await seedCommunity();
    const { streamKey: pathA } = await seedEvent(community.id, "live");
    const { event: eventB } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    // Minted for B...
    const token = tokenFor(subscription.id, eventB.id);

    // ...presented against A's path.
    const result = await useCase.execute({
      action: "read",
      path: `live/${pathA}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses when the subscription's community differs from the event's community", async () => {
    const subscriberCommunity = await seedCommunity("Rina");
    const eventCommunity = await seedCommunity("Budi");
    const { event, streamKey } = await seedEvent(eventCommunity.id, "live");
    const subscription = await seedActiveSubscription(subscriberCommunity.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a read against an unknown stream key even with an otherwise-valid token", async () => {
    const community = await seedCommunity();
    const subscription = await seedActiveSubscription(community.id);
    // eventId does not matter — the path never resolves to any event.
    const token = tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000");

    const result = await useCase.execute({
      action: "read",
      path: "live/no-such-key",
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a read with no token in the query at all", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id, OTHER_SECRET);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a subscription id that no longer exists at all", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const token = tokenFor("00000000-0000-4000-8000-000000000000", event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });
});

/**
 * `authoriseReadByEventId` — the entry point nginx's `auth_request` calls
 * (Task 9, `mediamtx-webhooks.ts`'s `/auth-request` route), added by the
 * final whole-branch review's Critical fix: the public HLS path a member's
 * browser ever requests is now `/live/<eventId>/...`, so the re-auth check
 * on every segment has to resolve by event id, not by stream key — the
 * whole point being that the stream key never has to appear anywhere a
 * member's browser can see it. Mirrors "AuthoriseStream — read" above
 * property-for-property (same token/entitlement checks, same
 * `authoriseReadForEvent` helper under the hood), plus the NEW behaviour:
 * only this entry point ever hands the stream key back out, and only to a
 * caller that already proved entitlement.
 */
describe("AuthoriseStream — read by event id (nginx auth_request)", () => {
  it("allows a read with a valid token, and returns the event's own stream key", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: true, streamKey });
  });

  it("refuses once the subscription is cancelled after the token was minted", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    await cancelSubscription(subscription.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a token minted for event A when presented against event B's id", async () => {
    const community = await seedCommunity();
    const { event: eventA } = await seedEvent(community.id, "live");
    const { event: eventB } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, eventA.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: eventB.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses when the subscription's community differs from the event's community", async () => {
    const subscriberCommunity = await seedCommunity("Rina");
    const eventCommunity = await seedCommunity("Budi");
    const { event } = await seedEvent(eventCommunity.id, "live");
    const subscription = await seedActiveSubscription(subscriberCommunity.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses an unknown event id even with an otherwise well-formed token", async () => {
    const community = await seedCommunity();
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000");

    const result = await useCase.authoriseReadByEventId({
      eventId: "00000000-0000-4000-8000-000000000000",
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a read with no token in the query at all", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");

    const result = await useCase.authoriseReadByEventId({ eventId: event.id, query: "", now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * The property this task exists to close: presenting a STREAM KEY where
   * this method expects an event id must not accidentally resolve to
   * anything — `findById` and `findByStreamKey` are different lookups
   * against different columns, so a key is simply never a valid id.
   */
  it("refuses when the caller passes a stream key instead of an event id", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: streamKey,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });
});

describe("AuthoriseStream — unrecognised actions", () => {
  it("refuses an action that is neither publish nor read", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    for (const action of ["playback", "api", "metrics", "pprof", "", "PUBLISH"]) {
      const result = await useCase.execute({ action, path: `live/${streamKey}`, query: "", now: NOW });
      expect(result.allowed).toBe(false);
    }
  });
});
