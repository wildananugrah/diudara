import { describe, expect, it, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  channelMemberships,
  channels,
  communities,
  creators,
  membershipTiers,
  outbox,
  renewalReminders,
  subscriptions,
  transactions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { computeNextBillingDate } from "../../domain/billing-cycle";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { TelegramBotAdapter } from "../../infrastructure/messaging/telegram-bot.adapter";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "../../infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "../../infrastructure/repositories/drizzle-channel.repository";
import { DrizzleCommunityRepository } from "../../infrastructure/repositories/drizzle-community.repository";
import { DrizzleCreatorRepository } from "../../infrastructure/repositories/drizzle-creator.repository";
import { DrizzleMemberRepository } from "../../infrastructure/repositories/drizzle-member.repository";
import { DrizzleMembershipTierRepository } from "../../infrastructure/repositories/drizzle-membership-tier.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzlePaymentActivationUnitOfWork } from "../../infrastructure/repositories/drizzle-payment-activation.unit-of-work";
import { DrizzleRenewalReminderRepository } from "../../infrastructure/repositories/drizzle-renewal-reminder.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import { OUTBOX_SEND_RENEWAL_REMINDER } from "../ports/outbox-repository.port";
import { GrantChannelAccess } from "./grant-channel-access";
import { HandlePaymentWebhook, RENEWED } from "./handle-payment-webhook";
import { ProcessChurn } from "./process-churn";
import { ProcessRenewals } from "./process-renewals";
import { RevokeChannelAccessForSystem } from "./revoke-channel-access";
import { StartCheckout } from "./start-checkout";

beforeEach(resetDatabase);

const PAYER = { payerName: "Siti", payerWhatsappNumber: "+6281234567890" };
const PRICE = 50_000;
const APP_BASE_URL = "https://app.diudara.test";
const GROUP_ID = "-1001234567890";
/** The Telegram user id the join webhook records, and the one an unban addresses. */
const TELEGRAM_USER_ID = "987654321";

/** 09:00 WIB on 2026-02-10 — the day the member first pays. */
const FIRST_PAID_AT = new Date("2026-02-10T02:00:00.000Z");
/** What `computeNextBillingDate` writes for that payment on a monthly tier. */
const FIRST_DUE_DATE = "2026-03-10";
/** 2026-03-10 00:00 Asia/Jakarta === 2026-03-09T17:00:00Z. */
const DUE_MIDNIGHT_WIB = new Date("2026-03-09T17:00:00.000Z");

/** `days` whole WIB days after the first due date, at 09:00 WIB. */
function at(days: number, hoursIntoWibDay = 9): Date {
  return new Date(
    DUE_MIDNIGHT_WIB.getTime() + days * 86_400_000 + hoursIntoWibDay * 3_600_000
  );
}

/** The same, relative to an arbitrary `YYYY-MM-DD` due date. */
function atDue(dueDate: string, days: number, hoursIntoWibDay = 9): Date {
  const midnightWib = new Date(new Date(`${dueDate}T00:00:00.000Z`).getTime() - 7 * 3_600_000);
  return new Date(midnightWib.getTime() + days * 86_400_000 + hoursIntoWibDay * 3_600_000);
}

let seq = 0;

/**
 * A whole DIUDARA community, wired from the real repositories, with the clock the tests
 * drive by hand. `gating` is a parameter because one test needs the REAL Telegram
 * adapter (to assert the unban precedes the invite at the HTTP boundary) while the rest
 * want the fake's link counters.
 */
function harness(options: { gating?: MessagingProviderPort; now?: Date } = {}) {
  const clock = new FixedClock(options.now ?? FIRST_PAID_AT);
  const telegram =
    options.gating ?? new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
  const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  const gating = new Map<string, MessagingProviderPort>([
    ["telegram", telegram],
    ["whatsapp", whatsapp],
  ]);

  const communityRepository = new DrizzleCommunityRepository(db);
  const tierRepository = new DrizzleMembershipTierRepository(db);
  const memberRepository = new DrizzleMemberRepository(db);
  const subscriptionRepository = new DrizzleSubscriptionRepository(db);
  const membershipRepository = new DrizzleChannelMembershipRepository(db);
  const payments = new FakePaymentAdapter();

  const startCheckout = new StartCheckout(
    communityRepository,
    tierRepository,
    memberRepository,
    subscriptionRepository,
    new DrizzleCreatorRepository(db),
    payments,
    clock,
    { appBaseUrl: APP_BASE_URL }
  );
  const handleWebhook = new HandlePaymentWebhook(
    subscriptionRepository,
    new DrizzlePaymentActivationUnitOfWork(db),
    clock
  );
  const grant = new GrantChannelAccess(
    subscriptionRepository,
    memberRepository,
    new DrizzleChannelRepository(db),
    membershipRepository,
    new DrizzleActivityLogRepository(db),
    gating,
    whatsapp
  );
  const renewals = new ProcessRenewals(
    subscriptionRepository,
    new DrizzleRenewalReminderRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );
  const churn = new ProcessChurn(
    subscriptionRepository,
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );
  const systemRevoke = new RevokeChannelAccessForSystem(
    subscriptionRepository,
    membershipRepository,
    new DrizzleActivityLogRepository(db),
    gating,
    new DrizzleOutboxRepository(db)
  );

  return {
    clock,
    telegram,
    whatsapp,
    payments,
    membershipRepository,
    startCheckout,
    handleWebhook,
    grant,
    renewals,
    churn,
    systemRevoke,
  };
}

async function seedCommunity() {
  seq += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", xenditAccountId: `acct-real-${seq}` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-renewal-${seq}-${Date.now()}`,
      status: "active",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Basic",
      priceAmount: PRICE,
      billingCycle: "monthly",
    })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({ communityId: community.id, platform: "telegram", externalGroupId: GROUP_ID })
    .returning();
  return { creator, community, tier, channel };
}

/** Pays for the transaction the last checkout created, exactly as Xendit's callback does. */
async function pay(
  h: ReturnType<typeof harness>,
  transactionId: string
): Promise<{ activated: boolean; duplicate: boolean }> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  seq += 1;
  return h.handleWebhook.execute({
    providerEventId: `evt-${seq}-${Date.now()}`,
    invoiceId: tx.gatewayReferenceId!,
    externalId: tx.id,
    status: "PAID",
    amount: PRICE,
    eventType: "invoice.paid",
    paymentMethod: "qris",
    payload: {},
  });
}

/**
 * The FIRST purchase, through the real flow: checkout, callback, grant. Nothing is
 * hand-written, so the invite link counted later is one the provider genuinely minted.
 */
async function firstPurchase(h: ReturnType<typeof harness>, slug: string, tierId: string) {
  const checkout = await h.startCheckout.execute({ slug, tierId, ...PAYER });
  const result = await pay(h, checkout.transactionId);
  if (!result.activated) throw new Error(`first payment did not activate: ${JSON.stringify(result)}`);
  await h.grant.execute({ subscriptionId: checkout.subscriptionId });
  const [membership] = await db.select().from(channelMemberships);
  return { subscriptionId: checkout.subscriptionId, membership };
}

async function reloadSubscription(id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row;
}

async function subscriptionRows() {
  return db.select().from(subscriptions).orderBy(asc(subscriptions.createdAt));
}

async function reminderStages() {
  const rows = await db.select().from(renewalReminders).orderBy(asc(renewalReminders.sentAt));
  return rows.map((row) => row.stage);
}

async function outboxRows() {
  return db.select().from(outbox).orderBy(asc(outbox.createdAt));
}

/** The fake gating adapter, narrowed so its link counters can be read. */
function fake(provider: MessagingProviderPort): FakeMessagingAdapter {
  if (!(provider instanceof FakeMessagingAdapter)) {
    throw new Error("this test needs the fake messaging adapter");
  }
  return provider;
}

describe("renewal payment — paying while past_due", () => {
  it("returns the member to active, advances the billing date, clears the deadline", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);
    expect((await reloadSubscription(subscriptionId)).nextBillingDate).toBe(FIRST_DUE_DATE);

    // The member misses the due date, through the real renewal pass.
    h.clock.set(at(0));
    await h.renewals.execute();
    expect((await reloadSubscription(subscriptionId)).status).toBe("past_due");
    expect((await reloadSubscription(subscriptionId)).graceEndsAt).toBeInstanceOf(Date);

    // They pay on day 5, still inside grace.
    const paidAt = at(5);
    h.clock.set(paidAt);
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    // THE SAME SUBSCRIPTION ROW. A renewal updates the row it renews (see the
    // `subscription_member_tier_active_unique` comment in db/schema.ts); a second row
    // would leave the first one `past_due` for the churn pass to revoke.
    expect(renewal.subscriptionId).toBe(subscriptionId);

    const result = await pay(h, renewal.transactionId);
    expect(result.activated).toBe(true);

    const row = await reloadSubscription(subscriptionId);
    expect(row.status).toBe("active");
    expect(row.nextBillingDate).toBe(computeNextBillingDate(paidAt, "monthly"));
    expect(row.graceEndsAt).toBeNull();
    // `started_at` is when the MEMBERSHIP began; a renewal must not move it.
    expect(row.startedAt?.toISOString()).toBe(FIRST_PAID_AT.toISOString());
    // One subscription for this (member, tier), not two.
    expect(await subscriptionRows()).toHaveLength(1);
  });

  it("MINTS NO SECOND INVITE LINK, counted at the provider", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId, membership } = await firstPurchase(h, community.slug, tier.id);
    const telegram = fake(h.telegram);
    expect(telegram.issuedLinks).toHaveLength(1);

    h.clock.set(at(0));
    await h.renewals.execute();
    h.clock.set(at(5));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);
    // The grant the renewal enqueued, handled exactly as the worker would.
    await h.grant.execute({ subscriptionId });

    // THE ASSERTION, at the provider rather than in the database. Phase 4 shipped a
    // five-credential leak past a test that counted membership rows: the invariant is
    // "at most one LIVE link per (member, channel) AT THE PROVIDER", so the count has
    // to come from the provider's side of the boundary.
    expect(telegram.issuedLinks).toHaveLength(1);
    expect(telegram.liveInviteLinks).toHaveLength(1);
    expect(telegram.grants).toHaveLength(1);

    // And the member never left the group: the same row, the same link.
    const [after] = await db
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.id, membership.id));
    expect(after.status).toBe("active");
    expect(after.inviteLink).toBe(membership.inviteLink);
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("DELETES the completed period's reminder rows, in the same transaction", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    // Three stages elapse: the member is warned, then goes past due, then is chased.
    h.clock.set(at(-3));
    await h.renewals.execute();
    h.clock.set(at(0));
    await h.renewals.execute();
    h.clock.set(at(1));
    await h.renewals.execute();
    expect(await reminderStages()).toEqual(["pre_3d", "due", "overdue_1d"]);

    h.clock.set(at(5));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);

    // `renewal_reminder`'s unique index is TOTAL, not partial (Task 2's deliberate
    // choice), so a row that survives a renewal suppresses the NEXT period's reminder
    // for that stage — silently, for a whole billing cycle.
    expect(await reminderStages()).toEqual([]);
    expect(await reloadSubscription(subscriptionId)).toBeDefined();
  });

  it("audits a renewal as `renewed`, not as another `joined`", async () => {
    // Phase 6 counts `joined` rows as new members. A renewal recorded as a join would
    // inflate acquisition for ever and make retention invisible — and it is the same
    // member paying again, which is the one thing the row has to say.
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    h.clock.set(at(0));
    await h.renewals.execute();
    h.clock.set(at(5));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);

    const paymentEvents = (await db.select().from(activityLogs).orderBy(asc(activityLogs.createdAt)))
      .filter((row) => row.eventType === "joined" || row.eventType === RENEWED)
      .map((row) => row.eventType);
    expect(paymentEvents).toEqual(["joined", RENEWED]);
    expect((await reloadSubscription(subscriptionId)).status).toBe("active");
  });

  it("reminds the member all over again when they lapse a SECOND time", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    h.clock.set(at(-3));
    await h.renewals.execute();
    h.clock.set(at(0));
    await h.renewals.execute();

    h.clock.set(at(5));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);

    const secondDueDate = (await reloadSubscription(subscriptionId)).nextBillingDate!;
    expect(secondDueDate).toBe(computeNextBillingDate(at(5), "monthly"));

    // THE FULL SEQUENCE, a second time. Without the delete above, `pre_3d` and `due`
    // conflict with the spent rows and are silently read as already claimed.
    for (const days of [-3, 0, 1, 3, 7]) {
      h.clock.set(atDue(secondDueDate, days));
      await h.renewals.execute();
    }

    // ASSERTED ON THE OUTBOX, not on `renewal_reminder`. The stage strings repeat every
    // period, so a surviving row from period one is indistinguishable from a fresh claim
    // in period two by name alone — a `renewal_reminder` assertion passes either way,
    // which is exactly how "the member is never reminded again" stays invisible. An
    // outbox row is a MESSAGE, and there is one only when a claim was actually won.
    const queued = (await outboxRows())
      .filter((row) => row.eventType === OUTBOX_SEND_RENEWAL_REMINDER)
      .map((row) => (row.payload as { stage: string }).stage);
    expect(queued).toEqual([
      // Period one, before the renewal.
      "pre_3d",
      "due",
      // Period two, all five stages.
      "pre_3d",
      "due",
      "overdue_1d",
      "overdue_3d",
      "overdue_7d",
    ]);
    expect(await reminderStages()).toEqual([
      "pre_3d",
      "due",
      "overdue_1d",
      "overdue_3d",
      "overdue_7d",
    ]);
    expect((await reloadSubscription(subscriptionId)).status).toBe("past_due");
  });
});

describe("renewal payment — paying while still active, inside the reminder window", () => {
  it("does not shorten the period: the billing date advances from the DUE date", async () => {
    // The `pre_3d` reminder's whole purpose is "renew without ever losing access", so
    // acting on it three days early must not cost the member three days. Anchoring on
    // `paidAt` alone would move the billing day earlier every cycle — a month a year.
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    h.clock.set(at(-3));
    await h.renewals.execute();
    expect(await reminderStages()).toEqual(["pre_3d"]);
    expect((await reloadSubscription(subscriptionId)).status).toBe("active");

    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    expect(renewal.subscriptionId).toBe(subscriptionId);
    await pay(h, renewal.transactionId);

    const row = await reloadSubscription(subscriptionId);
    expect(row.status).toBe("active");
    expect(row.nextBillingDate).toBe("2026-04-10");
    expect(row.graceEndsAt).toBeNull();
    expect(await reminderStages()).toEqual([]);
  });

  it("mints no second invite link either", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);
    const telegram = fake(h.telegram);

    h.clock.set(at(-3));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);
    await h.grant.execute({ subscriptionId });

    expect(telegram.issuedLinks).toHaveLength(1);
    expect(telegram.liveInviteLinks).toHaveLength(1);
  });
});

describe("payment AFTER revocation — a genuinely new grant", () => {
  it("unbans BEFORE issuing the invite, at the provider boundary", async () => {
    // Phase 4 built this path and nothing had used it: `banChatMember` also blocks the
    // user from joining via ANY link, so a churned member who re-pays gets a fresh link
    // that silently admits nobody until they are unbanned.
    const { community, tier } = await seedCommunity();

    // Phase one: a normal purchase and grant, with the FAKE adapter, so the first link
    // is one the provider minted and the join can be recorded against it.
    const first = harness();
    const { subscriptionId, membership } = await firstPurchase(first, community.slug, tier.id);
    const firstTelegram = fake(first.telegram);
    expect(firstTelegram.issuedLinks).toHaveLength(1);
    // The join webhook's write, through the real repository — this is the only place a
    // Telegram user id ever comes from.
    const recorded = await first.membershipRepository.recordPlatformMemberIdByInviteLink({
      inviteLink: membership.inviteLink!,
      externalGroupId: GROUP_ID,
      externalMemberId: TELEGRAM_USER_ID,
    });
    expect(recorded.outcome).toBe("recorded");

    // Phase two: they never renew, and the churn pass evicts them.
    first.clock.set(at(0));
    await first.renewals.execute();
    first.clock.set(at(8));
    const churned = await first.churn.execute();
    expect(churned.churned).toBe(1);
    await first.systemRevoke.execute({ subscriptionId });
    expect(firstTelegram.revocations).toEqual([
      { externalGroupId: GROUP_ID, externalMemberId: TELEGRAM_USER_ID },
    ]);
    // The old credential is dead: revoked at the provider, and gone from the row.
    expect(firstTelegram.liveInviteLinks).toHaveLength(0);

    // Phase three: they pay again. A separate composition — in production the API
    // revokes and the WORKER grants — and this one uses the real Telegram adapter, so
    // the ordering assertion is against actual Bot API calls.
    const calls: string[] = [];
    const realTelegram = new TelegramBotAdapter({
      botToken: "123456:AA_TEST_TOKEN",
      fetchFn: async (url) => {
        calls.push(new URL(url).pathname.split("/").pop() ?? "");
        return new Response(
          JSON.stringify({ ok: true, result: { invite_link: "https://t.me/+regranted" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    });
    const second = harness({ gating: realTelegram, now: at(8) });

    const repay = await second.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    // A NEW subscription: the churned one is history, and this is a new grant rather
    // than a renewal — which is exactly why it needs the unban.
    expect(repay.subscriptionId).not.toBe(subscriptionId);
    await pay(second, repay.transactionId);
    await second.grant.execute({ subscriptionId: repay.subscriptionId });

    // THE ASSERTION: the unban reached the provider FIRST, and exactly one link was
    // minted.
    expect(calls).toEqual(["unbanChatMember", "createChatInviteLink"]);
    expect(calls.filter((method) => method === "createChatInviteLink")).toHaveLength(1);

    const [after] = await db
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.id, membership.id));
    expect(after.status).toBe("active");
    expect(after.inviteLink).toBe("https://t.me/+regranted");
    // Still ONE membership row for this (member, channel) — the claim reactivated it.
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("queues the grant through the outbox, as every activation does", async () => {
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    h.clock.set(at(0));
    await h.renewals.execute();
    h.clock.set(at(5));
    const renewal = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    await pay(h, renewal.transactionId);

    // Two grant_access rows in total — one per activation — plus the reminder row the
    // renewal pass queued. The renewal's row is what makes the `already_granted` branch
    // run, which is where "no second mint" is actually decided.
    const rows = await outboxRows();
    expect(rows.filter((row) => row.eventType === "grant_access")).toHaveLength(2);
    expect(rows.filter((row) => row.eventType === "grant_access")[1].payload).toEqual({
      subscriptionId,
      memberId: (await reloadSubscription(subscriptionId)).memberId,
      communityId: community.id,
      transactionId: renewal.transactionId,
    });
  });
});
