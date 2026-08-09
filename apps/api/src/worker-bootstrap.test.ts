import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import {
  channelMemberships,
  channels,
  communities,
  creators,
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
  OUTBOX_REVOKE_ACCESS,
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  OUTBOX_SEND_RENEWAL_REMINDER,
} from "./application/ports/outbox-repository.port";
import { resolveAppBaseUrl } from "./bootstrap";
import { bootstrapWorker } from "./worker-bootstrap";

beforeEach(resetDatabase);

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

  it("wires exactly the event types it knows about, and no more", async () => {
    const repository = new DrizzleOutboxRepository(db);
    const { id } = await repository.enqueue({ eventType: "some_future_event", payload: {} });

    await bootstrapWorker().processOutbox.execute();

    expect((await rowById(id)).lastError).toContain("no handler is registered");
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
