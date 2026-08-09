import { describe, expect, it, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  channelMemberships,
  channels,
  communities,
  creators,
  members,
  membershipTiers,
  outbox,
  renewalReminders,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { TelegramBotAdapter } from "../../infrastructure/messaging/telegram-bot.adapter";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleMemberRepository } from "../../infrastructure/repositories/drizzle-member.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { REMINDER_STAGES } from "../../domain/renewal-schedule";
import { OUTBOX_SEND_RENEWAL_REMINDER } from "../ports/outbox-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import { ProcessOutbox } from "./process-outbox";
import {
  RENEWAL_REMINDER_NOT_SENT,
  RENEWAL_REMINDER_SENT,
  SendRenewalReminder,
  sendRenewalReminderOutboxHandler,
} from "./send-renewal-reminder";

beforeEach(resetDatabase);

/**
 * Deliberately not localhost and deliberately not the default: every assertion about
 * the checkout link is an assertion that it came from CONFIGURATION. Phase 3 resolves
 * exactly this value for `success_redirect_url`, and a hardcoded host here would send
 * every reminder's link to the wrong deployment.
 */
const APP_BASE_URL = "https://app.diudara.test";

let seedCounter = 0;

async function seed(
  options: {
    status?: string;
    priceAmount?: number;
    billingCycle?: string;
    nextBillingDate?: string | null;
    memberName?: string | null;
    slug?: string;
    withTelegramChannel?: boolean;
    withInviteLink?: string;
  } = {}
) {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Bimbel Rina",
      slug: options.slug ?? `kelas-rina-${seedCounter}`,
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Paket Lengkap",
      priceAmount: options.priceAmount ?? 50_000,
      billingCycle: options.billingCycle ?? "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+62813000${String(seedCounter).padStart(4, "0")}`,
      name: options.memberName === undefined ? "Siti" : options.memberName,
    })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: options.status ?? "past_due",
      nextBillingDate: options.nextBillingDate === undefined ? "2026-03-10" : options.nextBillingDate,
    })
    .returning();
  // The stage the reminder pass would have claimed. Present in every seed because the
  // survival of THIS row across a failed send is one of the properties under test.
  await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });

  let channel: { id: string } | undefined;
  if (options.withTelegramChannel === true || options.withInviteLink !== undefined) {
    [channel] = await db
      .insert(channels)
      .values({
        communityId: community.id,
        platform: "telegram",
        externalGroupId: `-100${seedCounter}${Date.now()}`,
      })
      .returning();
  }
  if (options.withInviteLink !== undefined && channel !== undefined) {
    await db.insert(channelMemberships).values({
      memberId: member.id,
      channelId: channel.id,
      inviteLink: options.withInviteLink,
      status: "active",
    });
  }

  return { creator, community, tier, member, subscription };
}

interface Wiring {
  useCase: SendRenewalReminder;
  whatsapp: FakeMessagingAdapter;
  telegram: FakeMessagingAdapter;
}

function wire(options: { notifier?: MessagingProviderPort } = {}): Wiring {
  const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
  const useCase = new SendRenewalReminder(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleActivityLogRepository(db),
    options.notifier ?? whatsapp,
    { appBaseUrl: APP_BASE_URL }
  );
  return { useCase, whatsapp, telegram };
}

async function activityRows() {
  return db.select().from(activityLogs).orderBy(asc(activityLogs.createdAt));
}

describe("SendRenewalReminder", () => {
  it("sends ONE WhatsApp message naming the community, the tier and the amount", async () => {
    const { member } = await seed();
    const { useCase, whatsapp } = wire();

    const result = await useCase.execute({ subscriptionId: (await onlySubscriptionId()), stage: "due" });

    expect(result.sent).toBe(true);
    expect(whatsapp.notifications).toHaveLength(1);
    const [notification] = whatsapp.notifications;
    expect(notification.toWhatsappNumber).toBe(member.whatsappNumber);
    expect(notification.message).toContain("Kelas Bimbel Rina");
    expect(notification.message).toContain("Paket Lengkap");
    // Indonesian thousands separators, and the currency the member actually pays in.
    expect(notification.message).toContain("Rp50.000");
  });

  it("carries a checkout link built from the CONFIGURED base url", async () => {
    const { community } = await seed({ slug: "kelas-bimbel-rina" });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    // Exactly the public checkout page, on the origin `resolveAppBaseUrl` produced —
    // the same value Phase 3 builds `success_redirect_url` from. A hardcoded host here
    // would point every member at somebody else's deployment.
    expect(whatsapp.notifications[0].message).toContain(`${APP_BASE_URL}/c/${community.slug}`);
    expect(whatsapp.notifications[0].message).not.toContain("localhost");
  });

  it("percent-encodes the slug it puts in the link", async () => {
    // The slug generator would not produce one, but this string is handed to a member
    // who taps it, which is not the place to rely on an invariant held elsewhere.
    await seed({ slug: "kelas rina" });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    expect(whatsapp.notifications[0].message).toContain(`${APP_BASE_URL}/c/kelas%20rina`);
  });

  it("writes every member-facing word in Indonesian, and words each stage differently", async () => {
    const messages: string[] = [];
    for (const stage of REMINDER_STAGES) {
      await resetDatabase();
      await seed();
      const { useCase, whatsapp } = wire();
      await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage });
      messages.push(whatsapp.notifications[0].message);
    }

    // Five stages, five distinct messages: a member who gets the same sentence four
    // times has no idea their access is about to go.
    expect(new Set(messages).size).toBe(REMINDER_STAGES.length);
    for (const message of messages) {
      expect(message).toContain("Kelas Bimbel Rina");
      // Indonesian, not English. Asserted on words that only appear in the Indonesian
      // copy, because "every member-facing string is Indonesian" is a product rule.
      expect(message).toMatch(/perpanjang/i);
      expect(message).not.toMatch(/\b(renew|payment|membership|expires)\b/i);
    }
    // The final notice has to say what is about to happen.
    expect(messages[REMINDER_STAGES.indexOf("overdue_7d")]).toMatch(/dicabut/i);
    // And the pre-due one must NOT: nothing has been lost yet.
    expect(messages[REMINDER_STAGES.indexOf("pre_3d")]).not.toMatch(/dicabut/i);
  });

  it("names the due date in Indonesian", async () => {
    await seed({ nextBillingDate: "2026-03-10" });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    expect(whatsapp.notifications[0].message).toContain("10 Maret 2026");
  });

  it("formats a large amount with Indonesian separators", async () => {
    await seed({ priceAmount: 1_500_000 });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    expect(whatsapp.notifications[0].message).toContain("Rp1.500.000");
  });

  it("says the billing period in Indonesian", async () => {
    for (const [cycle, expected] of [
      ["monthly", "per bulan"],
      ["quarterly", "per 3 bulan"],
      ["yearly", "per tahun"],
    ] as const) {
      await resetDatabase();
      await seed({ billingCycle: cycle });
      const { useCase, whatsapp } = wire();
      await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });
      expect(whatsapp.notifications[0].message).toContain(expected);
    }
  });

  it("STILL SENDS when the tier's billing cycle is unrecognised", async () => {
    // Spec §8: a tier edited or broken mid-cycle must not cost the member their
    // reminder. `computeNextBillingDate` throws on an unknown cycle — correctly, it is
    // about to write a date — but a reminder has nothing to write and every reason to
    // go out with the amount we recorded.
    await seed({ billingCycle: "weekly" });
    const { useCase, whatsapp } = wire();

    const result = await useCase.execute({
      subscriptionId: await onlySubscriptionId(),
      stage: "due",
    });

    expect(result.sent).toBe(true);
    expect(whatsapp.notifications[0].message).toContain("Rp50.000");
  });

  it("goes through the WHATSAPP provider even for a Telegram-only community", async () => {
    // The community's only channel is a Telegram group, so the temptation is to notify
    // through the provider that gates it. `TelegramBotAdapter.notify` THROWS — it
    // addresses a WhatsApp number it cannot reach — so that would mean a member who is
    // about to lose access is never told.
    const { member } = await seed({ withTelegramChannel: true });
    const { useCase, whatsapp, telegram } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "overdue_3d" });

    expect(whatsapp.notifications).toHaveLength(1);
    expect(whatsapp.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
    expect(telegram.notifications).toHaveLength(0);
  });

  it("is a LOUD failure if it is ever wired to the Telegram adapter", async () => {
    // Not a hypothetical: `MessagingProviders` has two fields precisely because a
    // composition root passing `gating.get("telegram")` here would compile. Phase 4
    // made the adapter throw so the mistake cannot be silent, and this pins it for the
    // reminder path too.
    await seed();
    const { useCase } = wire({ notifier: new TelegramBotAdapter({ botToken: "test-token" }) });

    await expect(
      useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" })
    ).rejects.toThrow(/telegram cannot send a WhatsApp notification/i);
  });

  it("puts NO invite link in the message", async () => {
    // Invite links are bearer credentials, and the member already has theirs — a
    // reminder that repeated it would spread a live key through a channel it was never
    // meant to travel, and one that is quoted in more places is one a member is more
    // likely to forward.
    const inviteLink = "https://t.me/+SuperSecretInviteToken";
    await seed({ withInviteLink: inviteLink });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "overdue_1d" });

    const { message } = whatsapp.notifications[0];
    expect(message).not.toContain(inviteLink);
    expect(message).not.toContain("SuperSecretInviteToken");
    expect(message).not.toContain("t.me");
  });

  it("records the send in activity_log, with ids and a stage only", async () => {
    const { member, community } = await seed();
    const { useCase } = wire();

    const subscriptionId = await onlySubscriptionId();
    await useCase.execute({ subscriptionId, stage: "due" });

    const audit = await activityRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].eventType).toBe(RENEWAL_REMINDER_SENT);
    expect(audit[0].memberId).toBe(member.id);
    expect(audit[0].communityId).toBe(community.id);
    expect(audit[0].metadata).toEqual({ stage: "due", subscriptionId });
    // No WhatsApp number, no message body, no link: activity_log is read by
    // creator-facing dashboards.
    expect(JSON.stringify(audit[0].metadata)).not.toContain("+62");
    expect(JSON.stringify(audit[0].metadata)).not.toContain(APP_BASE_URL);
  });

  it("sends NOTHING for a subscription that is no longer renewable, and records why", async () => {
    // An outbox row can sit through a provider outage or a stopped worker. By the time
    // it is handled the member may have cancelled — dunning somebody who has left is
    // worse than saying nothing. Recorded rather than thrown: no retry can fix it.
    const { member, community } = await seed({ status: "cancelled" });
    const { useCase, whatsapp } = wire();

    const result = await useCase.execute({
      subscriptionId: await onlySubscriptionId(),
      stage: "due",
    });

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("subscription_not_renewable");
    expect(whatsapp.notifications).toHaveLength(0);

    const audit = await activityRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].eventType).toBe(RENEWAL_REMINDER_NOT_SENT);
    expect(audit[0].memberId).toBe(member.id);
    expect(audit[0].communityId).toBe(community.id);
    expect(audit[0].metadata).toMatchObject({
      reason: "subscription_not_renewable",
      subscriptionStatus: "cancelled",
    });
  });

  it("sends NOTHING when the community was archived while the row waited", async () => {
    // The queue is where time passes. `ProcessRenewals` refuses to enqueue for an
    // archived community, and this is the same allowlist applied at the other end —
    // otherwise a creator who archives a community still duns its members for as long
    // as the outbox has rows for them.
    const { community } = await seed();
    await db
      .update(communities)
      .set({ status: "archived" })
      .where(eq(communities.id, community.id));
    const { useCase, whatsapp } = wire();

    const result = await useCase.execute({
      subscriptionId: await onlySubscriptionId(),
      stage: "due",
    });

    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("community_not_accepting_renewals");
    expect(whatsapp.notifications).toHaveLength(0);
    expect((await activityRows())[0].eventType).toBe(RENEWAL_REMINDER_NOT_SENT);
  });

  it("still sends for a PAUSED community", async () => {
    // Pausing stops new purchases, not the members who already paid.
    const { community } = await seed();
    await db.update(communities).set({ status: "paused" }).where(eq(communities.id, community.id));
    const { useCase, whatsapp } = wire();

    expect(
      (await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" })).sent
    ).toBe(true);
    expect(whatsapp.notifications).toHaveLength(1);
  });

  it("omits the due date rather than inventing one when there is none", async () => {
    await seed({ nextBillingDate: null });
    const { useCase, whatsapp } = wire();

    await useCase.execute({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    const { message } = whatsapp.notifications[0];
    expect(message).not.toContain("Jatuh tempo");
    expect(message).not.toContain("Invalid");
    expect(message).toContain("Rp50.000");
  });

  it("throws for a subscription that does not exist, so the row retries", async () => {
    const { useCase } = wire();

    await expect(
      useCase.execute({
        subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666",
        stage: "due",
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("sendRenewalReminderOutboxHandler", () => {
  it("dispatches a well-formed payload", async () => {
    await seed();
    const { useCase, whatsapp } = wire();
    const handler = sendRenewalReminderOutboxHandler(useCase);

    await handler({ subscriptionId: await onlySubscriptionId(), stage: "due" });

    expect(whatsapp.notifications).toHaveLength(1);
  });

  it("rejects a payload with no usable subscriptionId, without echoing it", async () => {
    const { useCase } = wire();
    const handler = sendRenewalReminderOutboxHandler(useCase);

    for (const payload of [null, {}, { subscriptionId: "" }, { subscriptionId: 7 }, "nope"]) {
      const error = await handler(payload).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
      expect(error).not.toBeNull();
      // The payload is deliberately not repeated: the worker logs this, and Phase 3
      // found payer PII in provider payloads.
      expect(error).not.toContain("nope");
    }
  });

  it("rejects a stage that is not one of the schedule's", async () => {
    // The stage decides the wording, and a row can outlive a deploy that changed the
    // schedule. A bogus value must fail loudly rather than produce a message with a
    // blank sentence in it.
    await seed();
    const { useCase } = wire();
    const handler = sendRenewalReminderOutboxHandler(useCase);

    await expect(
      handler({ subscriptionId: await onlySubscriptionId(), stage: "overdue_99d" })
    ).rejects.toThrow(/stage/i);
  });
});

describe("a failed send retries through the outbox", () => {
  it("RETRIES and KEEPS the renewal_reminder row, so no later pass re-sends the stage", async () => {
    // The row means "this stage is CLAIMED", not "this message was delivered". Deleting
    // it on a failure would let the next reminder pass claim the same stage again and
    // send it a second time, which is the exact double-send the constraint exists to
    // prevent. Re-sending on a retry is the acceptable direction; re-CLAIMING is not.
    await seed();
    const { useCase, whatsapp } = wire();
    const subscriptionId = await onlySubscriptionId();
    const outboxRepository = new DrizzleOutboxRepository(db);
    const { id } = await outboxRepository.enqueue({
      eventType: OUTBOX_SEND_RENEWAL_REMINDER,
      payload: { subscriptionId, stage: "due" },
    });
    const processOutbox = new ProcessOutbox(
      outboxRepository,
      new Map([[OUTBOX_SEND_RENEWAL_REMINDER, sendRenewalReminderOutboxHandler(useCase)]]),
      // baseBackoffMs 0 so the retry is immediately due.
      { maxAttempts: 5, baseBackoffMs: 0 }
    );

    whatsapp.failNextNotify = true;
    const failed = await processOutbox.execute();

    expect(failed.retried).toBe(1);
    expect(whatsapp.notifications).toHaveLength(0);
    // THE CLAIM SURVIVES.
    expect(await db.select().from(renewalReminders)).toHaveLength(1);
    const [pending] = await db.select().from(outbox).where(eq(outbox.id, id));
    expect(pending.status).toBe("pending");
    expect(pending.lastError).toContain("notify");

    // And the retry delivers, exactly once.
    for (let pass = 0; pass < 20; pass += 1) {
      const [current] = await db.select().from(outbox).where(eq(outbox.id, id));
      if (current.status !== "pending") break;
      await processOutbox.execute();
    }

    const [settled] = await db.select().from(outbox).where(eq(outbox.id, id));
    expect(settled.status).toBe("sent");
    expect(whatsapp.notifications).toHaveLength(1);
    expect(await db.select().from(renewalReminders)).toHaveLength(1);
  });
});

/** The one subscription the seed created. */
async function onlySubscriptionId(): Promise<string> {
  const rows = await db.select({ id: subscriptions.id }).from(subscriptions);
  if (rows.length !== 1) {
    throw new Error(`expected exactly one subscription, found ${rows.length}`);
  }
  return rows[0].id;
}
