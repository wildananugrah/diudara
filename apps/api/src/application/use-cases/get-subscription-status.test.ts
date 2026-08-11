import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators, events, members, membershipTiers, subscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { verifyWatchToken } from "../../domain/watch-token";
import { NotFoundError } from "../errors";
import { GetSubscriptionStatus } from "./get-subscription-status";

beforeEach(resetDatabase);

const SECRET = "a".repeat(32);
const NOW = Date.parse("2026-08-11T10:00:00.000Z");

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);

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
  return event!;
}

async function seedSubscription(communityId: string, status: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62813${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status })
    .returning();
  return subscription!;
}

describe("GetSubscriptionStatus — the base contract", () => {
  it("returns just the status when streaming is not configured on this box", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: undefined,
    });
    const community = await seedCommunity();
    await seedEvent(community.id, "live");
    const subscription = await seedSubscription(community.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "active" });
  });

  it("throws NotFoundError for an unknown subscription id", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });

    await expect(
      useCase.execute("00000000-0000-4000-8000-000000000000", NOW)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError rather than 500ing for a value that cannot be a uuid", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });

    await expect(useCase.execute("not-a-uuid", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("GetSubscriptionStatus — watchUrl", () => {
  it("mints a watchUrl when the subscription is active and its community is live", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const subscription = await seedSubscription(community.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result.status).toBe("active");
    expect(typeof result.watchUrl).toBe("string");
    const token = result.watchUrl!.replace(/^\/watch\//, "");
    const claims = verifyWatchToken({ token, now: NOW, secret: SECRET });
    expect(claims).toEqual({ subscriptionId: subscription.id, eventId: event.id });
  });

  it("omits watchUrl when the community has no event at all", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    const subscription = await seedSubscription(community.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "active" });
  });

  it("omits watchUrl when the community's event is only scheduled, not live", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    await seedEvent(community.id, "scheduled");
    const subscription = await seedSubscription(community.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "active" });
  });

  it("omits watchUrl once the event has ended", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    await seedEvent(community.id, "ended");
    const subscription = await seedSubscription(community.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "active" });
  });

  it("omits watchUrl for a pending subscription, even with a live event — never hand out an unusable link", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    await seedEvent(community.id, "live");
    const subscription = await seedSubscription(community.id, "pending");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "pending" });
  });

  it("omits watchUrl for a cancelled subscription, even with a live event", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const community = await seedCommunity();
    await seedEvent(community.id, "live");
    const subscription = await seedSubscription(community.id, "cancelled");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "cancelled" });
  });

  it("never leaks another community's live event into this subscription's watchUrl", async () => {
    const useCase = new GetSubscriptionStatus(subscriptionRepository, eventRepository, {
      streamTokenSecret: SECRET,
    });
    const streamerCommunity = await seedCommunity("Rina");
    const otherCommunity = await seedCommunity("Budi");
    await seedEvent(streamerCommunity.id, "live");
    const subscription = await seedSubscription(otherCommunity.id, "active");

    const result = await useCase.execute(subscription.id, NOW);

    expect(result).toEqual({ status: "active" });
  });
});
