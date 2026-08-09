import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import {
  activityLogs,
  channelMemberships,
  channels,
  communities,
  creators,
  members,
  membershipTiers,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "../../infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "../../infrastructure/repositories/drizzle-channel.repository";
import { DrizzleMemberRepository } from "../../infrastructure/repositories/drizzle-member.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { TelegramBotAdapter } from "../../infrastructure/messaging/telegram-bot.adapter";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import {
  GrantChannelAccess,
  grantAccessOutboxHandler,
  MANUAL_ADDITION_NOTICE,
} from "./grant-channel-access";

beforeEach(resetDatabase);

let seq = 0;

async function seed(options: { platforms?: string[]; subscriptionStatus?: string } = {}) {
  seq += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${seq}-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Budi", slug: `kelas-${seq}-${Date.now()}` })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Basic",
      priceAmount: 50_000,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${seq}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: options.subscriptionStatus ?? "active",
      startedAt: new Date(),
    })
    .returning();

  const created = [];
  for (const platform of options.platforms ?? ["telegram"]) {
    seq += 1;
    const [channel] = await db
      .insert(channels)
      .values({
        communityId: community.id,
        platform,
        externalGroupId: `-100${seq}${Date.now()}`,
      })
      .returning();
    created.push(channel);
  }

  return { creator, community, tier, member, subscription, channels: created };
}

interface Wiring {
  telegram: FakeMessagingAdapter;
  whatsapp: FakeMessagingAdapter;
  useCase: GrantChannelAccess;
}

function wire(overrides: { gating?: ReadonlyMap<string, MessagingProviderPort> } = {}): Wiring {
  const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
  const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  const useCase = new GrantChannelAccess(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleChannelRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    overrides.gating ??
      new Map<string, MessagingProviderPort>([
        ["telegram", telegram],
        ["whatsapp", whatsapp],
      ]),
    whatsapp
  );
  return { telegram, whatsapp, useCase };
}

describe("GrantChannelAccess", () => {
  it("grants a telegram channel, records the membership, and notifies over WhatsApp", async () => {
    const { member, channels: created } = await seed();
    const { telegram, whatsapp, useCase } = wire();

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    expect(result.granted).toBe(1);
    expect(result.automated).toBe(true);

    expect(telegram.grants).toHaveLength(1);
    expect(telegram.grants[0].externalGroupId).toBe(created[0].externalGroupId!);

    const memberships = await db.select().from(channelMemberships);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].memberId).toBe(member.id);
    expect(memberships[0].channelId).toBe(created[0].id);
    expect(memberships[0].status).toBe("active");
    expect(memberships[0].inviteLink).toBe(telegram.lastInviteLink!);

    // The link reaches the member who bought it — over WhatsApp, which is the
    // only provider that can reach a phone number.
    expect(whatsapp.notifications).toHaveLength(1);
    expect(whatsapp.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
    expect(whatsapp.notifications[0].message).toContain(telegram.lastInviteLink!);

    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("channel_access_granted");
    expect(logs[0].memberId).toBe(member.id);
  });

  it("issues ONE membership and ONE invite link when the same payload is processed twice", async () => {
    await seed();
    const { telegram, whatsapp, useCase } = wire();
    const subscriptionId = (await onlySubscription()).id;

    const first = await useCase.execute({ subscriptionId });
    const second = await useCase.execute({ subscriptionId });

    // Idempotency is arbitrated by channel_membership's unique index, not by a
    // pre-check. A second link is a second BEARER CREDENTIAL that could be
    // forwarded to someone who never paid, so the counts are the assertion.
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
    expect(telegram.grants).toHaveLength(1);
    expect(new Set(telegram.issuedLinks).size).toBe(1);

    expect(first.granted).toBe(1);
    expect(second.granted).toBe(0);
    expect(second.alreadyGranted).toBe(1);

    // The stored link is untouched by the second pass.
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.inviteLink).toBe(telegram.issuedLinks[0]);

    // The member is still told, with the SAME link: the second pass only
    // happens after a failure or a reclaim, and a duplicate message is far
    // better than a member who paid and was never sent anything.
    expect(whatsapp.notifications).toHaveLength(2);
    expect(whatsapp.notifications[1].message).toContain(telegram.issuedLinks[0]);

    // One audit entry per real grant, not per attempt.
    const logs = await db.select().from(activityLogs);
    expect(logs.filter((log) => log.eventType === "channel_access_granted")).toHaveLength(1);
  });

  it("finishes a grant that a previous attempt claimed but never completed", async () => {
    const { member, channels: created } = await seed();
    const { telegram, useCase } = wire();
    // Exactly what a worker killed between the claim and the provider call
    // leaves behind: an active membership with no link.
    await new DrizzleChannelMembershipRepository(db).claim({
      memberId: member.id,
      channelId: created[0].id,
    });

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    // "A row already exists" must NOT be read as "already granted" — the member
    // has no link at all.
    expect(result.granted).toBe(1);
    expect(telegram.grants).toHaveLength(1);
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.inviteLink).toBe(telegram.lastInviteLink!);
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("grants every gating-capable channel the community has", async () => {
    await seed({ platforms: ["telegram", "telegram"] });
    const { telegram, whatsapp, useCase } = wire();

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    expect(result.granted).toBe(2);
    expect(telegram.grants).toHaveLength(2);
    expect(await db.select().from(channelMemberships)).toHaveLength(2);
    // One message carrying both links, not one message per channel.
    expect(whatsapp.notifications).toHaveLength(1);
    for (const link of telegram.issuedLinks) {
      expect(whatsapp.notifications[0].message).toContain(link);
    }
  });

  describe("a notify-only community", () => {
    it("reports honestly instead of looking like a successful grant", async () => {
      const { member } = await seed({ platforms: ["whatsapp"] });
      const { telegram, whatsapp, useCase } = wire();

      const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

      // A WhatsApp-only community is a real configuration (spec §2.1: WhatsApp
      // cannot gate group access). The chosen behaviour: the work SUCCEEDS,
      // the member is told a human will add them, and the audit trail records
      // that no automated gating was possible. What must never happen is a
      // silent success indistinguishable from a real grant.
      expect(result.automated).toBe(false);
      expect(result.granted).toBe(0);
      expect(result.manual).toBe(1);

      // Nothing pretended to gate.
      expect(telegram.grants).toHaveLength(0);
      expect(await db.select().from(channelMemberships)).toHaveLength(0);

      // The member hears about it, in the message that would otherwise have
      // carried a link.
      expect(whatsapp.notifications).toHaveLength(1);
      expect(whatsapp.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
      expect(whatsapp.notifications[0].message).toContain(MANUAL_ADDITION_NOTICE);

      // And the creator's audit trail says why.
      const logs = await db.select().from(activityLogs);
      expect(logs).toHaveLength(1);
      expect(logs[0].eventType).toBe("access_manual_required");
      expect(logs[0].memberId).toBe(member.id);
      expect(JSON.stringify(logs[0].metadata)).toContain("whatsapp");
    });

    it("says so for a community with no channels at all", async () => {
      await seed({ platforms: [] });
      const { whatsapp, useCase } = wire();

      const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

      expect(result.automated).toBe(false);
      expect(result.granted).toBe(0);
      expect(whatsapp.notifications).toHaveLength(1);
      expect(whatsapp.notifications[0].message).toContain(MANUAL_ADDITION_NOTICE);
      const logs = await db.select().from(activityLogs);
      expect(logs).toHaveLength(1);
      expect(logs[0].eventType).toBe("access_manual_required");
      expect(JSON.stringify(logs[0].metadata)).toContain("no_channels_configured");
    });

    it("still grants the telegram channel when a whatsapp channel sits beside it", async () => {
      await seed({ platforms: ["telegram", "whatsapp"] });
      const { telegram, whatsapp, useCase } = wire();

      const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

      expect(result.granted).toBe(1);
      expect(result.manual).toBe(1);
      expect(result.automated).toBe(true);
      expect(await db.select().from(channelMemberships)).toHaveLength(1);
      expect(whatsapp.notifications[0].message).toContain(telegram.lastInviteLink!);
    });
  });

  it("NEVER asks the gating provider to notify — that goes through WhatsApp", async () => {
    // TelegramBotAdapter.notify THROWS by design (it addresses a WhatsApp
    // number it cannot reach). Using the real adapter here means a
    // mis-wiring cannot pass this test quietly.
    await seed();
    const telegram = new TelegramBotAdapter({
      botToken: "test-token",
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: true, result: { invite_link: "https://t.me/+real" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = new GrantChannelAccess(
      new DrizzleSubscriptionRepository(db),
      new DrizzleMemberRepository(db),
      new DrizzleChannelRepository(db),
      new DrizzleChannelMembershipRepository(db),
      new DrizzleActivityLogRepository(db),
      new Map<string, MessagingProviderPort>([["telegram", telegram]]),
      whatsapp
    );

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    expect(result.granted).toBe(1);
    expect(whatsapp.notifications).toHaveLength(1);
    expect(whatsapp.notifications[0].message).toContain("https://t.me/+real");
  });

  it("keeps the invite link out of the activity log", async () => {
    await seed();
    const { telegram, useCase } = wire();

    await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    // activity_log is read by creator-facing dashboards. An invite link there
    // is a bearer credential handed to whoever can see the dashboard.
    const logs = await db.select().from(activityLogs);
    expect(JSON.stringify(logs)).not.toContain(telegram.lastInviteLink!);
    expect(JSON.stringify(logs)).not.toContain("fake-invite");
  });

  it("propagates a provider failure so the outbox row retries", async () => {
    await seed();
    const { telegram, whatsapp, useCase } = wire();
    telegram.failNextGrant = true;

    await expect(
      useCase.execute({ subscriptionId: (await onlySubscription()).id })
    ).rejects.toThrow();

    // Nothing was claimed as granted, and the member was told nothing — the
    // retry will do the whole thing.
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.inviteLink).toBeNull();
    expect(whatsapp.notifications).toHaveLength(0);
  });

  it("refuses to grant access for a subscription that is not active", async () => {
    const { member } = await seed({ subscriptionStatus: "cancelled" });
    const { telegram, whatsapp, useCase } = wire();

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    // An outbox row can sit for a long time (a provider outage, a stopped
    // worker, a reclaim). Granting a cancelled subscription would hand access
    // to someone who is no longer paying, and Phase 5 revokes on churn.
    expect(result.granted).toBe(0);
    expect(result.skippedReason).toBe("subscription_not_active");
    expect(telegram.grants).toHaveLength(0);
    expect(whatsapp.notifications).toHaveLength(0);
    expect(await db.select().from(channelMemberships)).toHaveLength(0);
    const logs = await db.select().from(activityLogs);
    expect(logs[0].eventType).toBe("access_not_granted");
    expect(logs[0].memberId).toBe(member.id);
  });

  it("throws for an unknown subscription id", async () => {
    const { useCase } = wire();
    await expect(
      useCase.execute({ subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666" })
    ).rejects.toThrow(/subscription/i);
  });

  it("throws when a channel's platform has no provider wired at all", async () => {
    await seed({ platforms: ["discord"] });
    const { useCase } = wire();

    // Not a silent skip: nobody granted anything, and a platform with no
    // adapter is a deployment error an operator has to see. The outbox row
    // retries and then fails permanently, which is where it becomes visible.
    await expect(
      useCase.execute({ subscriptionId: (await onlySubscription()).id })
    ).rejects.toThrow(/discord/);
  });
});

describe("grantAccessOutboxHandler", () => {
  it("passes the payload's subscriptionId to the use-case", async () => {
    await seed();
    const { telegram, useCase } = wire();
    const subscription = await onlySubscription();

    await grantAccessOutboxHandler(useCase)({
      subscriptionId: subscription.id,
      memberId: subscription.memberId,
    });

    expect(telegram.grants).toHaveLength(1);
  });

  it("rejects a payload with no usable subscriptionId, without echoing it", async () => {
    const { useCase } = wire();
    const handler = grantAccessOutboxHandler(useCase);

    for (const payload of [null, {}, { subscriptionId: 42 }, { subscriptionId: "" }, "nope"]) {
      await expect(handler(payload)).rejects.toThrow(/subscriptionId/);
    }

    // The payload may contain whatever an older deploy wrote; the error text says
    // what is missing and repeats nothing.
    await expect(handler({ payerEmail: "siti@example.com" })).rejects.toThrow(
      /deliberately not repeated/
    );
  });
});

/** The one subscription `seed()` created — keeps each test's setup to one line. */
async function onlySubscription() {
  const rows = await db.select().from(subscriptions);
  expect(rows).toHaveLength(1);
  return rows[0];
}
