import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import {
  channelMemberships,
  channels,
  communities,
  creators,
  events,
  joinRequests,
  members,
  membershipTiers,
  outbox,
  renewalReminders,
  subscriptions,
} from "./db/schema";
import { resetDatabase } from "./db/test-helpers";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import {
  OUTBOX_GRANT_ACCESS,
  OUTBOX_NOTIFY_JOIN_REQUEST,
  OUTBOX_NOTIFY_STREAM_LIVE,
  OUTBOX_REVOKE_ACCESS,
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  OUTBOX_SEND_RENEWAL_REMINDER,
} from "./application/ports/outbox-repository.port";
import { resolveAppBaseUrl } from "./bootstrap";
import { jakartaDayNumber } from "./domain/renewal-schedule";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { bootstrapWorker } from "./worker-bootstrap";

beforeEach(resetDatabase);

/**
 * A `YYYY-MM-DD` string `days` after TODAY as Asia/Jakarta reckons it — i.e. derived
 * from the real clock, on purpose.
 *
 * These dates are what make the two pass tests below prove the composition root wired a
 * `SystemClock`: a root that had injected a fixed instant, or a clock stuck at some
 * literal date, would compute a different stage for the same row (or none at all) and
 * the assertions would fail. A hardcoded 2026-03-10 could not tell the difference.
 */
function jakartaDateStringOffsetFromToday(days: number): string {
  return new Date((jakartaDayNumber(new Date()) + days) * 86_400_000).toISOString().slice(0, 10);
}

async function rowById(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
}

/**
 * A past-due member of a real community, i.e. exactly what `ProcessRenewals` enqueues a
 * `send_renewal_reminder` row for.
 */
async function seedPastDueMember(slug: string) {
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Bimbel Rina", slug })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community.id,
      name: "Paket Lengkap",
      priceAmount: 50_000,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+6281390${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: "past_due",
      nextBillingDate: "2026-03-10",
    })
    .returning();
  await db.insert(renewalReminders).values({ subscriptionId: subscription.id, stage: "due" });
  return { community, member, subscription };
}

/**
 * A member whose subscription the churn pass has just ended, still holding the Telegram
 * access it paid for — i.e. exactly what `ProcessChurn` enqueues a
 * `revoke_subscription_access` row for.
 */
async function seedChurnedMemberWithAccess() {
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-churn-${Date.now()}` })
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
    .values({ whatsappNumber: `+6281391${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      communityId: community.id,
      platform: "telegram",
      externalGroupId: `-100${Date.now()}`,
    })
    .returning();
  await db.insert(channelMemberships).values({
    memberId: member.id,
    channelId: channel.id,
    inviteLink: `https://t.me/+churn-${Date.now()}`,
    // What POST /webhooks/telegram records when the member joins, and the only thing
    // `banChatMember` can be aimed at.
    externalMemberId: "987654321",
  });
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: "churned",
      nextBillingDate: "2026-03-10",
      graceEndsAt: new Date("2026-03-17T00:00:00.000Z"),
    })
    .returning();
  return { community, member, channel, subscription };
}

/**
 * A member whose next billing date is `daysOverdue` WIB days in the past and whose
 * subscription is still `active` — i.e. exactly what `ProcessRenewals` is supposed to
 * find, remind and move to `past_due`.
 */
async function seedMemberDueDaysAgo(daysOverdue: number) {
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-due-${Date.now()}` })
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
    .values({ whatsappNumber: `+6281392${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: "active",
      nextBillingDate: jakartaDateStringOffsetFromToday(-daysOverdue),
    })
    .returning();
  return { community, member, tier, subscription };
}

/**
 * A `past_due` member whose stored grace deadline has already passed relative to the
 * REAL clock — i.e. exactly what `ProcessChurn` is supposed to find and end.
 */
async function seedMemberPastGrace() {
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-grace-${Date.now()}` })
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
    .values({ whatsappNumber: `+6281393${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      memberId: member.id,
      tierId: tier.id,
      status: "past_due",
      nextBillingDate: jakartaDateStringOffsetFromToday(-8),
      // A minute ago, by the real clock.
      graceEndsAt: new Date(Date.now() - 60_000),
    })
    .returning();
  return { community, member, subscription };
}

/**
 * A `live` event with one `active` subscriber — the minimum `NotifyStreamLive`
 * (Task 5) needs to send exactly one WhatsApp message.
 */
async function seedLiveEventWithActiveMember() {
  const [creator] = await db.insert(creators).values({ name: "Rina" }).returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina", slug: `kelas-live-${Date.now()}` })
    .returning();
  const [event] = await db
    .insert(events)
    .values({
      communityId: community.id,
      title: "Live Q&A",
      streamKey: `worker-key-${Date.now()}`,
      status: "live",
      hlsPlaybackPath: "https://fake-mediamtx.local/live/worker-key/index.m3u8",
    })
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
    .values({ whatsappNumber: `+6281394${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId: tier.id, status: "active" })
    .returning();
  return { event, member, subscription };
}

/**
 * A creator with a real WhatsApp number → free community → tier → member →
 * pending join request — the minimum `NotifyJoinRequest` (Task 5) needs to
 * send exactly one WhatsApp message to the OWNER.
 */
async function seedPendingJoinRequest() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", whatsappNumber: `+6281395${Date.now() % 100000}` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: "Kelas Rina",
      slug: `kelas-join-${Date.now()}`,
      accessMode: "request",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId: community.id, name: "Free", priceAmount: 0, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+6281396${Date.now() % 100000}`, name: "Siti" })
    .returning();
  const [request] = await db
    .insert(joinRequests)
    .values({ communityId: community.id, tierId: tier.id, memberId: member.id })
    .returning();
  return { creator, community, tier, member, request };
}

/**
 * A gating adapter this root selected, narrowed to the fake. An `instanceof` check
 * rather than a cast, for the same reason as `fakeNotifierOf`.
 */
function fakeGatingOf(
  worker: ReturnType<typeof bootstrapWorker>,
  platform: string
): FakeMessagingAdapter {
  const provider = worker.messaging.gating.get(platform);
  if (!(provider instanceof FakeMessagingAdapter)) {
    throw new Error(`expected the worker to select FakeMessagingAdapter for ${platform}`);
  }
  return provider;
}

/**
 * The notifier this root selected, narrowed to the fake so its recorded sends can be
 * read. An `instanceof` check rather than a cast: this file forbids casts for the same
 * reason bootstrap.test.ts does, and the check itself is worth making — under
 * `NODE_ENV=test` the fake is what must be selected.
 */
function fakeNotifierOf(worker: ReturnType<typeof bootstrapWorker>): FakeMessagingAdapter {
  const { notifier } = worker.messaging;
  if (!(notifier instanceof FakeMessagingAdapter)) {
    throw new Error("expected the worker to select FakeMessagingAdapter under NODE_ENV=test");
  }
  return notifier;
}

/**
 * The worker has its OWN composition root, separate from `bootstrap()`: it needs
 * no JWT secret, no web base URL and no payment provider, and refusing to start
 * without them would be a deployment hazard for a process that never serves a
 * request.
 *
 * These tests prove the wiring, which nothing else can: Phase 3 shipped a
 * confirmation page that was unreachable for a whole phase because no test
 * checked that an environment variable reached the composition root.
 */
describe("bootstrapWorker", () => {
  it("dispatches a real grant_access row to GrantChannelAccess, not to nothing", async () => {
    const repository = new DrizzleOutboxRepository(db);
    // A well-formed payload for a subscription that does not exist: it reaches
    // the use-case and fails THERE. The point is which error comes back — an
    // unwired handler would say "no handler is registered", which is the
    // failure mode this test exists to catch.
    const { id } = await repository.enqueue({
      eventType: OUTBOX_GRANT_ACCESS,
      payload: { subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666" },
    });

    const result = await bootstrapWorker().processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    const row = await rowById(id);
    expect(row.lastError).toContain("subscription");
    expect(row.lastError).not.toContain("no handler is registered");
  });

  /**
   * I3, final whole-branch review. A failed platform removal now becomes a
   * `revoke_access` row, and this proves the WORKER actually handles it — a row
   * nothing is wired for would fail permanently five attempts later, which is exactly
   * the "no durable, actionable record" state the finding was about.
   */
  it("dispatches a real revoke_access row to the revocation retry, not to nothing", async () => {
    const repository = new DrizzleOutboxRepository(db);
    // A well-formed payload for a membership that does not exist. It reaches the
    // use-case, which reports "nothing outstanding" and COMPLETES — so the row is
    // `sent`. An unwired handler would instead leave "no handler is registered".
    const { id } = await repository.enqueue({
      eventType: OUTBOX_REVOKE_ACCESS,
      payload: {
        membershipId: "3f1c9e0a-1111-4222-8333-444455556666",
        communityId: "3f1c9e0a-1111-4222-8333-444455556667",
        memberId: "3f1c9e0a-1111-4222-8333-444455556668",
      },
    });

    const result = await bootstrapWorker().processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    // Null, not an unwired-handler message: it never failed at all.
    expect(row.lastError).toBeNull();
  });

  /**
   * Phase 5. `ProcessRenewals` runs in this same process and enqueues these rows, so an
   * unregistered handler here would mean every reminder failing five times and then
   * permanently — a member who is about to lose access is never warned, and the only
   * trace is `outbox.last_error`. Phase 4 found a guard that existed in the API and had
   * never crossed the workspace seam; this is the same seam.
   */
  it("dispatches a real send_renewal_reminder row to SendRenewalReminder, not to nothing", async () => {
    const { member } = await seedPastDueMember("kelas-bimbel-rina");
    const [subscription] = await db.select().from(subscriptions);
    const { id } = await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_SEND_RENEWAL_REMINDER,
      payload: { subscriptionId: subscription.id, stage: "due" },
    });
    const worker = bootstrapWorker();
    const notifier = fakeNotifierOf(worker);

    const result = await worker.processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    expect(row.lastError).toBeNull();
    // The member was actually messaged, over WhatsApp, by THIS process.
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
  });

  it("builds the reminder's checkout link from APP_BASE_URL, in THIS root", async () => {
    // Phase 3 shipped a confirmation page nothing could reach for a whole phase because
    // no test checked that an environment variable arrived at the composition root. The
    // worker's root did not resolve APP_BASE_URL at all before Phase 5 — its docstring
    // said it had "no confirmation page to link to" — so this is the assertion that
    // stops the reminder link pointing at localhost on every member's phone.
    await seedPastDueMember("kelas-bimbel-rina");
    const [subscription] = await db.select().from(subscriptions);
    await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_SEND_RENEWAL_REMINDER,
      payload: { subscriptionId: subscription.id, stage: "overdue_3d" },
    });

    const original = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://worker-wired.example/";
    try {
      const worker = bootstrapWorker();
      const notifier = fakeNotifierOf(worker);
      await worker.processOutbox.execute();
      const { message } = notifier.notifications[0];
      // The SAME resolver the API uses, trailing slash stripped and all.
      expect(message).toContain(
        `${resolveAppBaseUrl({ appBaseUrl: "https://worker-wired.example/", nodeEnv: "test" })}` +
          "/c/kelas-bimbel-rina"
      );
      expect(message).not.toContain("localhost");
    } finally {
      if (original === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = original;
    }
  });

  /**
   * Phase 5, Task 5. `ProcessChurn` enqueues these, and an unregistered handler would
   * mean every churned member staying in the paid group for ever with nothing but
   * `outbox.last_error` to say a removal was owed — which is the exact gap Phase 4's
   * retry path was added to close, arriving by a different route.
   *
   * It also proves WHICH use-case is wired: the removal completes with no creator id
   * anywhere in the payload, so it cannot be the creator-scoped path.
   */
  it("dispatches a real revoke_subscription_access row to the system revoke, not to nothing", async () => {
    const { channel, subscription } = await seedChurnedMemberWithAccess();
    const { id } = await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
      payload: { subscriptionId: subscription.id },
    });
    const worker = bootstrapWorker();
    const telegram = fakeGatingOf(worker, "telegram");

    const result = await worker.processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    expect(row.lastError).toBeNull();
    // The member was actually removed, by THIS process, with the id the join webhook
    // recorded — not merely "a handler exists".
    expect(telegram.revocations).toEqual([
      { externalGroupId: channel.externalGroupId!, externalMemberId: "987654321" },
    ]);
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.status).toBe("revoked");
  });

  /**
   * Task 5. `HandleStreamLifecycle` (in `apps/api`'s own webhook route) enqueues
   * these; an unregistered handler here would mean a `notify_stream_live` row
   * failing five times and then permanently, with every active member of the
   * community never told the creator went live.
   *
   * `STREAM_TOKEN_SECRET` is set for the duration of this test, exactly like the
   * `APP_BASE_URL` test above: `notifyStreamLive` (and the handler for its event
   * type) is `undefined` — by design, mirroring `authoriseStream` in the API root
   * — on a box with no streaming secret configured, which is this file's default
   * environment.
   */
  it("dispatches a real notify_stream_live row to NotifyStreamLive, not to nothing", async () => {
    const { event, member, subscription } = await seedLiveEventWithActiveMember();
    const { id } = await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_NOTIFY_STREAM_LIVE,
      payload: { eventId: event.id, subscriptionId: subscription.id },
    });

    const original = process.env.STREAM_TOKEN_SECRET;
    process.env.STREAM_TOKEN_SECRET = "e".repeat(32);
    try {
      const worker = bootstrapWorker();
      const notifier = fakeNotifierOf(worker);

      const result = await worker.processOutbox.execute();

      expect(result.claimed).toBe(1);
      expect(result.sent).toBe(1);
      const row = await rowById(id);
      expect(row.status).toBe("sent");
      expect(row.lastError).toBeNull();
      // The member was actually messaged, over WhatsApp, by THIS process.
      expect(notifier.notifications).toHaveLength(1);
      expect(notifier.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
    } finally {
      if (original === undefined) delete process.env.STREAM_TOKEN_SECRET;
      else process.env.STREAM_TOKEN_SECRET = original;
    }
  });

  /**
   * Task 5, free communities. `RequestToJoin` (in `apps/api`'s own join-request
   * route) enqueues these; an unregistered handler here would mean every
   * `notify_join_request` row failing five times and then permanently, with the
   * owner never told a member asked to join — Task 7's dashboard list is the
   * documented FALLBACK for an undeliverable WhatsApp, not the primary channel,
   * so this wiring is what makes the primary channel real.
   *
   * Unlike `notify_stream_live`, no environment variable gates this handler's
   * registration — see `WorkerDependencies.notifyJoinRequest`'s own docstring —
   * so this test needs no STREAM_TOKEN_SECRET-style setup/teardown.
   */
  it("dispatches a real notify_join_request row to NotifyJoinRequest, not to nothing", async () => {
    const { creator, request } = await seedPendingJoinRequest();
    const { id } = await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_NOTIFY_JOIN_REQUEST,
      payload: { joinRequestId: request.id },
    });
    const worker = bootstrapWorker();
    const notifier = fakeNotifierOf(worker);

    const result = await worker.processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    expect(row.lastError).toBeNull();
    // The OWNER was actually messaged, over WhatsApp, by THIS process.
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe(creator.whatsappNumber!);
  });

  /**
   * Review round 2. `selectStreamingProvider` on the API side enforces
   * `MIN_STREAMING_SECRET_LENGTH` on `STREAM_TOKEN_SECRET` at boot — but until now
   * this root read the SAME variable raw, with no such check. A worker box whose
   * secret is merely present, but weak or truncated relative to the API's, would
   * boot silently and mint watch tokens the API's `AuthoriseStream` then rejects
   * at read time: every member gets a link that 403s on every segment, with
   * nothing here ever failing loud enough to say why.
   */
  it("refuses to boot when STREAM_TOKEN_SECRET is set but too short", async () => {
    const original = process.env.STREAM_TOKEN_SECRET;
    process.env.STREAM_TOKEN_SECRET = "too-short";
    try {
      expect(() => bootstrapWorker()).toThrow(/STREAM_TOKEN_SECRET is too short/);
    } finally {
      if (original === undefined) delete process.env.STREAM_TOKEN_SECRET;
      else process.env.STREAM_TOKEN_SECRET = original;
    }
  });

  it("does not register a notify_stream_live handler when STREAM_TOKEN_SECRET is unset", async () => {
    const { event } = await seedLiveEventWithActiveMember();
    const { id } = await new DrizzleOutboxRepository(db).enqueue({
      eventType: OUTBOX_NOTIFY_STREAM_LIVE,
      payload: { eventId: event.id },
    });
    const original = process.env.STREAM_TOKEN_SECRET;
    delete process.env.STREAM_TOKEN_SECRET;

    try {
      const worker = bootstrapWorker();
      expect(worker.notifyStreamLive).toBeUndefined();

      await worker.processOutbox.execute();

      expect((await rowById(id)).lastError).toContain("no handler is registered");
    } finally {
      if (original === undefined) delete process.env.STREAM_TOKEN_SECRET;
      else process.env.STREAM_TOKEN_SECRET = original;
    }
  });

  it("wires exactly the event types it knows about, and no more", async () => {
    const repository = new DrizzleOutboxRepository(db);
    const { id } = await repository.enqueue({ eventType: "some_future_event", payload: {} });

    await bootstrapWorker().processOutbox.execute();

    expect((await rowById(id)).lastError).toContain("no handler is registered");
  });

  /**
   * Phase 5, Task 7. Until this task nothing constructed `ProcessRenewals` at all: its
   * outbox handler was registered, its use-case was tested, and no process would ever
   * have called it — the whole phase was dead code reachable only from a test. These
   * two tests are what make "the pass exists" mean "the pass runs".
   */
  it("constructs a renewal pass that actually reminds a real due subscription", async () => {
    const { member, subscription } = await seedMemberDueDaysAgo(1);

    const result = await bootstrapWorker().processRenewals.execute();

    expect(result.considered).toBe(1);
    expect(result.reminded).toBe(1);
    expect(result.transitionedToPastDue).toBe(1);
    // The stage is derived from the REAL clock against a date seeded one WIB day ago,
    // so this also proves the root injected a `SystemClock` and not a fixed instant.
    const reminders = await db.select().from(renewalReminders);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].stage).toBe("overdue_1d");
    expect(reminders[0].subscriptionId).toBe(subscription.id);
    // And a row for the OTHER half of the wiring to pick up.
    const [row] = await db.select().from(outbox);
    expect(row.eventType).toBe(OUTBOX_SEND_RENEWAL_REMINDER);
    const [updated] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscription.id));
    expect(updated.status).toBe("past_due");
    expect(updated.graceEndsAt).not.toBeNull();
    expect(member.whatsappNumber).toBeTruthy();
  });

  it("runs the renewal pass and the outbox in ONE process, so the member is really messaged", async () => {
    // The end-to-end seam this task closes: clock → pass → outbox row → WhatsApp. Every
    // link is a different module and none of them was connected before.
    const { member } = await seedMemberDueDaysAgo(3);
    const worker = bootstrapWorker();
    const notifier = fakeNotifierOf(worker);

    await worker.processRenewals.execute();
    const delivered = await worker.processOutbox.execute();

    expect(delivered.sent).toBe(1);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe(member.whatsappNumber);
  });

  it("constructs a churn pass that actually ends a subscription past its grace deadline", async () => {
    const { subscription } = await seedMemberPastGrace();

    const result = await bootstrapWorker().processChurn.execute();

    expect(result.considered).toBe(1);
    expect(result.churned).toBe(1);
    expect(result.revocationsQueued).toBe(1);
    const [updated] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscription.id));
    expect(updated.status).toBe("churned");
    const [row] = await db.select().from(outbox);
    expect(row.eventType).toBe(OUTBOX_REVOKE_SUBSCRIPTION_ACCESS);
  });

  it("injects the REAL clock into the passes, not a fixture", () => {
    // The passes are the first things in this codebase whose behaviour depends entirely
    // on the current instant, and `FixedClock` exists in this workspace. A root that
    // wired that by accident would leave every member's stage frozen on the day the
    // process booted, and the two tests above are the only other thing that would
    // notice.
    const { clock } = bootstrapWorker();
    expect(clock).toBeInstanceOf(SystemClock);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("selects the fake messaging adapters under NODE_ENV=test", () => {
    // `bun test` sets NODE_ENV=test, and the whole suite depends on the fakes.
    // Constructing the root at all is the assertion: with real tokens absent and
    // a NODE_ENV outside the allowlist, selectMessagingProviders throws.
    const worker = bootstrapWorker();
    expect(worker.messaging.notifier.capabilities().canGateAccess).toBe(false);
    expect(worker.messaging.gating.get("telegram")?.capabilities().canGateAccess).toBe(true);
  });
});
