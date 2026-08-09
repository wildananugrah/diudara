import { describe, expect, it, beforeEach } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
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
  webhookEvents,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { computeNextBillingDate } from "../../domain/billing-cycle";
import { ConflictError } from "../errors";
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

/** One channel_membership row, straight from the database. */
async function membershipRow(id: string) {
  const [row] = await db
    .select()
    .from(channelMemberships)
    .where(eq(channelMemberships.id, id));
  return row;
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

  it("TWO CONCURRENT PAYMENTS BUY TWO PERIODS, not one", async () => {
    // `renewalAnchor` exists so that two payments inside the window stack instead of
    // both landing on the same date — see its docstring. That only holds if the read of
    // `next_billing_date` and the write derived from it cannot interleave. They can:
    // `markPaid` reads the column with a plain SELECT under READ COMMITTED, so two
    // deliveries that both read before either writes compute the SAME new date, and the
    // member pays twice for one month. Found by driving the real API in Task 9.
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId } = await firstPurchase(h, community.slug, tier.id);

    // Inside the reminder window, where a member can legitimately hold two invoices:
    // one from the `pre_3d` link and one from opening the page again.
    h.clock.set(at(-3));
    const first = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    const second = await h.startCheckout.execute({
      slug: community.slug,
      tierId: tier.id,
      ...PAYER,
    });
    expect(first.subscriptionId).toBe(subscriptionId);
    expect(second.subscriptionId).toBe(subscriptionId);
    expect(first.transactionId).not.toBe(second.transactionId);

    // THE INTERLEAVING IS FORCED, NOT RACED. A third connection holds the subscription
    // row, so both activations are provably contending for it — reported by Postgres,
    // not by a timer — before either is allowed to write. A bare `Promise.all` here
    // serialises on a fast database and proves nothing (see test-support/arrival-latch).
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .for("update");
      await waitUntilTwoBackendsBlockedOnSubscription();
    });
    const deliveries = Promise.all([pay(h, first.transactionId), pay(h, second.transactionId)]);
    await holder;
    const results = await deliveries;

    // Both payments were collected: this is not a replay, and the money is real.
    expect(results.map((r) => r.activated)).toEqual([true, true]);
    const paidTransactions = await db.select().from(transactions);
    expect(paidTransactions.filter((t) => t.status === "success")).toHaveLength(3);

    // TWO periods from the due date, not one. `at(-3)` is before the due date, so the
    // anchor is the due date both times: 2026-03-10 -> 2026-04-10 -> 2026-05-10.
    const row = await reloadSubscription(subscriptionId);
    expect(row.status).toBe("active");
    expect(row.nextBillingDate).toBe("2026-05-10");

    // And the audit trail agrees with the row, which is the half that made the bug
    // invisible: both `renewed` entries used to claim the same `nextBillingDate`.
    const renewedDates = (
      await db.select().from(activityLogs).where(eq(activityLogs.eventType, RENEWED))
    )
      .map((entry) => (entry.metadata as { nextBillingDate: string }).nextBillingDate)
      .sort();
    expect(renewedDates).toEqual(["2026-04-10", "2026-05-10"]);
  });
});

/**
 * Resolves once Postgres reports TWO backends of this database waiting on a lock while
 * running a statement against `subscription`.
 *
 * The database is what says the interleaving was constructed — the same technique
 * `drizzle-webhook-event.repository.test.ts` uses for its uncommitted-winner test, and
 * for the same reason: it THROWS rather than resolving if the contention never happens,
 * so the test cannot pass from a precondition it did not reach.
 */
async function waitUntilTwoBackendsBlockedOnSubscription(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike '%subscription%'
    `);
    waiting = Number(row.waiting);
    if (waiting >= 2) return;
    await Bun.sleep(5);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for two backends to contend for the ` +
      `subscription row; only ${waiting} were blocked, so the interleaving was never built`
  );
}

describe("the final warning lands BEFORE the grace deadline", () => {
  it("delivers overdue_7d on day 7, leaves the member in the group, and churns after day 10", async () => {
    // Task 9 walked this lifecycle in a running worker twice and `overdue_7d` fired
    // NEITHER time: it becomes claimable at 00:00 WIB on day 7 and the deadline used to
    // land at 07:00 WIB the same day, so the reminder pass and the churn pass — two
    // independent PollLoops — raced for seven hours, and churn won both times. The
    // member was removed having received `overdue_3d` as their last word, which Spec 6
    // and Spec 8 both forbid. `GRACE_DAYS` is now 10.
    const { community, tier } = await seedCommunity();
    const h = harness();
    const { subscriptionId, membership } = await firstPurchase(h, community.slug, tier.id);

    // The whole schedule, one pass per stage, as a real member experiences it.
    for (const dayOffset of [-3, 0, 1, 3, 7]) {
      h.clock.set(at(dayOffset));
      await h.renewals.execute();
      // The churn pass runs on its own loop at the same cadence, so it gets a turn at
      // every one of these instants. It must take nobody until the deadline.
      await h.churn.execute();
    }

    // ALL FIVE stages, including the final warning.
    expect(await reminderStages()).toEqual([
      "pre_3d",
      "due",
      "overdue_1d",
      "overdue_3d",
      "overdue_7d",
    ]);
    // And each one was actually queued for delivery, not merely claimed.
    const queued = await db
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, OUTBOX_SEND_RENEWAL_REMINDER));
    expect(queued).toHaveLength(5);

    // Day 7: warned, still past_due, still in the group.
    const warned = await reloadSubscription(subscriptionId);
    expect(warned.status).toBe("past_due");
    expect(warned.graceEndsAt?.toISOString()).toBe("2026-03-20T00:00:00.000Z");
    expect(await db.select().from(activityLogs).where(eq(activityLogs.eventType, "churned")))
      .toHaveLength(0);

    // Late on day 9 — two whole days after the final warning — still inside grace.
    h.clock.set(at(9, 23));
    expect((await h.churn.execute()).churned).toBe(0);
    expect((await reloadSubscription(subscriptionId)).status).toBe("past_due");
    const [stillIn] = await db
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.id, membership.id));
    expect(stillIn.status).toBe("active");

    // Past the stored deadline (07:00 WIB on day 10) — now they churn.
    h.clock.set(at(10));
    expect((await h.churn.execute()).churned).toBe(1);
    expect((await reloadSubscription(subscriptionId)).status).toBe("churned");

    // No extra reminder was invented in the three days the change added: the schedule
    // stays at its final stage rather than growing a stage to fill the gap.
    expect(await reminderStages()).toEqual([
      "pre_3d",
      "due",
      "overdue_1d",
      "overdue_3d",
      "overdue_7d",
    ]);
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

    // Phase two: they never renew, and the churn pass evicts them. Day 11 — past the
    // day-10 grace deadline, which sits three days beyond the `overdue_7d` warning so
    // that the warning is never racing the eviction (see GRACE_DAYS).
    first.clock.set(at(0));
    await first.renewals.execute();
    first.clock.set(at(11));
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
    const second = harness({ gating: realTelegram, now: at(11) });

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

  /**
   * C1 and C2, final whole-branch review. THE REGRESSION SHAPE NOTHING ELSE COVERED: an
   * outbox row delivered after the entitlement it was written for has changed.
   *
   * Both findings live in the same window — a member paying around the instant their
   * grace runs out — and the reviewer reproduced both against real Postgres. They are
   * walked here end to end, through the real passes and the real repositories, because
   * neither is visible from inside a single use-case.
   */
  describe("a payment and a churn that cross in flight", () => {
    it("REFUSES a payment for a subscription the churn pass has already ended", async () => {
      const { community, tier } = await seedCommunity();
      const h = harness();
      const { subscriptionId, membership } = await firstPurchase(h, community.slug, tier.id);
      const telegram = fake(h.telegram);

      // Past due, then chased to the last warning, then the invoice they create from
      // their own reminder link on day 9 — still inside grace.
      h.clock.set(at(0));
      await h.renewals.execute();
      h.clock.set(at(9));
      const late = await h.startCheckout.execute({
        slug: community.slug,
        tierId: tier.id,
        ...PAYER,
      });
      expect(late.subscriptionId).toBe(subscriptionId);

      // Their deadline passes before the callback arrives.
      h.clock.set(at(11));
      expect((await h.churn.execute()).churned).toBe(1);
      expect((await reloadSubscription(subscriptionId)).status).toBe("churned");

      // THE PAYMENT LANDS. It used to flip `churned` back to `active`, advance the
      // billing date, clear the deadline, delete the reminder claims and enqueue a
      // grant — while the revocation the churn pass had already queued was still
      // pending. Now it is refused, loudly, with nothing written.
      await expect(pay(h, late.transactionId)).rejects.toBeInstanceOf(ConflictError);

      const row = await reloadSubscription(subscriptionId);
      expect(row.status).toBe("churned");
      expect(row.nextBillingDate).toBe(FIRST_DUE_DATE);
      expect(row.graceEndsAt).toBeInstanceOf(Date);
      // The event id is unspent and the money is not recorded as collected, so the
      // delivery can be replayed once a person has decided what the member gets.
      const [tx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, late.transactionId));
      expect(tx.status).toBe("pending");
      expect(await db.select().from(webhookEvents)).toHaveLength(1);
      // NO second grant, and therefore no second invite link — spec §7.
      expect((await outboxRows()).filter((r) => r.eventType === "grant_access")).toHaveLength(1);
      expect(telegram.issuedLinks).toHaveLength(1);

      // And the eviction the churn pass queued still applies, because it does: the
      // member's subscription is churned and they hold no other.
      await h.systemRevoke.execute({ subscriptionId });
      expect((await membershipRow(membership.id)).status).toBe("revoked");
    });

    it("does NOT evict a member whose NEW subscription arrived before the stale revoke did", async () => {
      // No race and no ordering assumption: the worker was simply down. The revoke row
      // the churn pass wrote sits in the outbox while the member buys again — and a
      // churned member buying again gets a NEW subscription, so the row's own
      // subscription stays `churned` for ever and a status re-check alone never fires.
      const { community, tier } = await seedCommunity();
      const h = harness();
      const { subscriptionId, membership } = await firstPurchase(h, community.slug, tier.id);
      const telegram = fake(h.telegram);

      h.clock.set(at(0));
      await h.renewals.execute();
      h.clock.set(at(11));
      expect((await h.churn.execute()).churned).toBe(1);
      const queued = (await outboxRows()).filter(
        (row) => row.eventType === "revoke_subscription_access"
      );
      expect(queued).toHaveLength(1);

      // The next day they buy again and are granted a fresh link — the whole re-grant,
      // through checkout, the callback and the grant use-case.
      h.clock.set(at(12));
      const fresh = await h.startCheckout.execute({
        slug: community.slug,
        tierId: tier.id,
        ...PAYER,
      });
      expect(fresh.subscriptionId).not.toBe(subscriptionId);
      expect((await pay(h, fresh.transactionId)).activated).toBe(true);
      await h.grant.execute({ subscriptionId: fresh.subscriptionId });
      const regranted = await membershipRow(membership.id);
      expect(regranted.status).toBe("active");
      expect(regranted.inviteLink).not.toBeNull();
      expect(telegram.liveInviteLinks).toHaveLength(1);

      // ONLY NOW does the worker come back and deliver the stale row.
      const result = await h.systemRevoke.execute({
        subscriptionId: (queued[0].payload as { subscriptionId: string }).subscriptionId,
      });

      // THE ASSERTIONS: measured at the provider, because the database was never the
      // thing at risk. Before this guard the member was removed from the group, their
      // brand-new link was revoked, `invite_link` was nulled, and nothing retried —
      // the system revoke swallows provider errors and completes.
      expect(result).toEqual({ revoked: 0, automated: false, channels: [] });
      expect(telegram.revocations).toHaveLength(0);
      expect(telegram.liveInviteLinks).toHaveLength(1);
      const after = await membershipRow(membership.id);
      expect(after.status).toBe("active");
      expect(after.inviteLink).toBe(regranted.inviteLink);
      // And it is recorded, so "the member kept access" is never a silent decision.
      const logs = await db
        .select()
        .from(activityLogs)
        .where(eq(activityLogs.eventType, "access_not_revoked"));
      expect(logs).toHaveLength(1);
    });
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
