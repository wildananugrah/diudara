import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { activityLogs, communities, creators, events, members, membershipTiers, subscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { verifyWatchToken } from "../../domain/watch-token";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleMemberRepository } from "../../infrastructure/repositories/drizzle-member.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { NotFoundError } from "../errors";
import {
  NotifyStreamLive,
  notifyStreamLiveOutboxHandler,
  STREAM_LIVE_NOTIFIED_EVENT,
  STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
} from "./notify-stream-live";

beforeEach(resetDatabase);

const SECRET = "d".repeat(32);
const APP_BASE_URL = "https://diudara.test";

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const memberRepository = new DrizzleMemberRepository(db);
const activityLogRepository = new DrizzleActivityLogRepository(db);

function buildUseCase(notifier: FakeMessagingAdapter) {
  return new NotifyStreamLive(
    eventRepository,
    subscriptionRepository,
    memberRepository,
    activityLogRepository,
    notifier,
    { appBaseUrl: APP_BASE_URL, streamTokenSecret: SECRET }
  );
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
  const key = `key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey: key,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${key}/index.m3u8`,
    })
    .returning();
  return event!;
}

/** A subscription of `status` to a fresh tier of `communityId`, with its own member. */
async function seedSubscription(communityId: string, status: string) {
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
    .values({ memberId: member!.id, tierId: tier!.id, status })
    .returning();
  return { subscription: subscription!, member: member! };
}

async function activityRowsFor(eventId: string) {
  const rows = await db.select().from(activityLogs);
  return rows.filter((row) => (row.metadata as { eventId?: string } | null)?.eventId === eventId);
}

describe("NotifyStreamLive", () => {
  it("sends every active member a watch link, minted for their own subscription", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const { subscription, member } = await seedSubscription(community.id, "active");
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ eventId: event.id });

    expect(result).toEqual({ notified: 1 });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe(member.whatsappNumber);
    expect(notifier.notifications[0]!.message).toContain(event.title);

    const url = new URL(notifier.notifications[0]!.message.match(/https:\/\/\S+/)![0]);
    const token = url.pathname.split("/watch/")[1]!;
    const claims = verifyWatchToken({ token, now: Date.now(), secret: SECRET });
    expect(claims).toEqual({ subscriptionId: subscription.id, eventId: event.id });

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(STREAM_LIVE_NOTIFIED_EVENT);
  });

  it("a member who churned between enqueue and delivery is not messaged", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const { subscription } = await seedSubscription(community.id, "active");
    // The churn: this subscription was active when `HandleStreamLifecycle` enqueued
    // the row, and is not any more by the time this consumer runs.
    await db
      .update(subscriptions)
      .set({ status: "churned", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ eventId: event.id });

    expect(result).toEqual({ notified: 0 });
    expect(notifier.notifications).toHaveLength(0);
  });

  it("an event that ended before delivery sends nothing, and records the skip", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    await seedSubscription(community.id, "active");
    // The stream ended between go-live and this row being handled.
    await db.update(events).set({ status: "ended" }).where(eq(events.id, event.id));
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ eventId: event.id });

    expect(result).toEqual({ notified: 0, skippedReason: "event_not_live" });
    expect(notifier.notifications).toHaveLength(0);

    const activity = await activityRowsFor(event.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(STREAM_LIVE_NOTIFY_SKIPPED_EVENT);
  });

  it("does not message a past_due member — the watch entitlement re-check is `active` only", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    await seedSubscription(community.id, "past_due");
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ eventId: event.id });

    expect(result).toEqual({ notified: 0 });
    expect(notifier.notifications).toHaveLength(0);
  });

  it("throws for an event id that does not exist", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    await expect(
      useCase.execute({ eventId: "00000000-0000-4000-8000-000000000000" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps notifying the rest of the community when one member's send fails, then throws", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    await seedSubscription(community.id, "active");
    await seedSubscription(community.id, "active");
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    notifier.failNextNotify = true;
    const useCase = buildUseCase(notifier);

    await expect(useCase.execute({ eventId: event.id })).rejects.toThrow();

    // One member's send failed; the other still got a message.
    expect(notifier.notifications).toHaveLength(1);
  });
});

describe("notifyStreamLiveOutboxHandler", () => {
  it("rejects a payload with no usable eventId", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const handler = notifyStreamLiveOutboxHandler(buildUseCase(notifier));

    await expect(handler({})).rejects.toThrow();
    await expect(handler({ eventId: "" })).rejects.toThrow();
    await expect(handler(null)).rejects.toThrow();
  });

  it("calls through to the use-case for a well-formed payload", async () => {
    const community = await seedCommunity();
    const event = await seedEvent(community.id, "live");
    const { member } = await seedSubscription(community.id, "active");
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const handler = notifyStreamLiveOutboxHandler(buildUseCase(notifier));

    await handler({ eventId: event.id });

    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe(member.whatsappNumber);
  });
});
