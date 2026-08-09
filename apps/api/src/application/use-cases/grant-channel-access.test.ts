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
  outbox,
  subscriptions,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "../../infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "../../infrastructure/repositories/drizzle-channel.repository";
import { DrizzleMemberRepository } from "../../infrastructure/repositories/drizzle-member.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { TelegramBotAdapter } from "../../infrastructure/messaging/telegram-bot.adapter";
import type { ChannelMembershipRepositoryPort } from "../ports/channel-membership-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import { OUTBOX_GRANT_ACCESS } from "../ports/outbox-repository.port";
import {
  GrantChannelAccess,
  grantAccessOutboxHandler,
  MANUAL_ADDITION_NOTICE,
} from "./grant-channel-access";
import { ProcessOutbox } from "./process-outbox";

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

function wire(
  overrides: {
    gating?: ReadonlyMap<string, MessagingProviderPort>;
    memberships?: ChannelMembershipRepositoryPort;
    /**
     * Runs inside `grantAccess`, before the link is minted. The seam a test uses to
     * hold a caller in the mint window and force a specific interleaving instead of
     * hoping for one.
     */
    beforeMint?: () => Promise<void>;
  } = {}
): Wiring {
  const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
  const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  const { beforeMint } = overrides;
  // Delegates everything; `telegram` itself is still what tests assert on, so the
  // link counts come from the fake and not from the wrapper.
  const gatingTelegram: MessagingProviderPort =
    beforeMint === undefined
      ? telegram
      : {
          platform: telegram.platform,
          capabilities: () => telegram.capabilities(),
          grantAccess: async (input) => {
            await beforeMint();
            return telegram.grantAccess(input);
          },
          revokeInviteLink: (input) => telegram.revokeInviteLink(input),
          revokeAccess: (input) => telegram.revokeAccess(input),
          notify: (input) => telegram.notify(input),
        };
  const useCase = new GrantChannelAccess(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleChannelRepository(db),
    overrides.memberships ?? new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    overrides.gating ??
      new Map<string, MessagingProviderPort>([
        ["telegram", gatingTelegram],
        ["whatsapp", whatsapp],
      ]),
    whatsapp
  );
  return { telegram, whatsapp, useCase };
}

/**
 * A latch that opens once `expected` CLAIMS have completed.
 *
 * IT COUNTS CLAIMS, NOT ARRIVALS IN THE MINT WINDOW, and that difference is the
 * point. The previous version released every waiter after 250 ms whichever way the
 * race went, so it was a TEMPORAL barrier, not a causal one: on a pathologically slow
 * database — a loaded CI box, a cold connection pool — caller 1 could be released
 * before caller 2 had claimed at all, and the test would pass VACUOUSLY without ever
 * constructing the interleaving it is named for. A concurrency test that can pass
 * without the concurrency happening is not evidence.
 *
 * Counting claims makes the release CAUSED by the state the bug needs: caller 1 is
 * held inside `grantAccess` until caller 2's `claim` has actually returned, so both
 * callers have demonstrably contended for the same (member, channel) before either
 * mints. It works on both sides of the fix — before it, both claims return `mint`;
 * after it, the second returns `mint_in_progress` — because a claim is counted
 * whatever its outcome.
 *
 * `wait` REJECTS on the safety timeout instead of resolving. A hang would stall the
 * suite with no diagnosis, and resolving would be exactly the vacuous pass this class
 * exists to remove; a rejection fails the test with the count it actually saw.
 */
class ClaimLatch {
  private claims = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly expected: number,
    /** Generous: it is a deadlock detector, never part of the timing being tested. */
    private readonly timeoutMs = 5_000
  ) {}

  /** Called after every `claim`, whatever it returned. */
  recordClaim(): void {
    this.claims += 1;
    if (this.claims >= this.expected) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
  }

  wait(): Promise<void> {
    if (this.claims >= this.expected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `ClaimLatch: only ${this.claims} of ${this.expected} claims arrived within ` +
              `${this.timeoutMs}ms — the interleaving under test never happened, so a pass ` +
              "would have been vacuous"
          )
        );
      }, this.timeoutMs);
      this.waiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * The real repository, with every completed `claim` counted on a latch. Nothing else
 * changes, so the claim under test is the production one.
 */
function countingClaims(
  real: ChannelMembershipRepositoryPort,
  latch: ClaimLatch
): ChannelMembershipRepositoryPort {
  return {
    claim: async (input) => {
      const claim = await real.claim(input);
      latch.recordClaim();
      return claim;
    },
    recordGrant: (id, link) => real.recordGrant(id, link),
    releaseMintWindow: (id) => real.releaseMintWindow(id),
    recordPlatformMemberIdByInviteLink: (input) => real.recordPlatformMemberIdByInviteLink(input),
    revoke: (id) => real.revoke(id),
    findByIdWithChannel: (id) => real.findByIdWithChannel(id),
    listActiveForMemberInCommunity: (memberId, communityId) =>
      real.listActiveForMemberInCommunity(memberId, communityId),
  };
}

/**
 * The concurrency test's release condition is itself worth pinning, because the
 * previous version of it could pass VACUOUSLY.
 *
 * `Barrier(2, 250)` released caller 1 after 250 ms whether or not caller 2 had
 * claimed, so on a slow database the invariant test never constructed the
 * interleaving it claims to test — and a green result meant nothing. These two tests
 * fail against that temporal barrier and pass against the causal latch.
 */
describe("ClaimLatch (the concurrency test's release condition)", () => {
  it("does NOT release on time alone — only a second claim releases it", async () => {
    const latch = new ClaimLatch(2, 120);
    latch.recordClaim();

    // The old barrier resolved here after its 250ms timeout. This must not: nothing
    // has contended yet, so releasing would let the test that depends on it pass
    // without the race ever happening.
    await expect(latch.wait()).rejects.toThrow(/only 1 of 2 claims/);
  });

  it("releases as soon as the expected claims have happened, however long that took", async () => {
    const latch = new ClaimLatch(2, 5_000);
    latch.recordClaim();
    const waiting = latch.wait();
    // Well past any fixed timeout the old barrier would have used.
    setTimeout(() => latch.recordClaim(), 300);

    await waiting;
  });
});

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

  it("finishes a grant for a row claimed with no mint ever started", async () => {
    const { member, channels: created } = await seed();
    const { telegram, useCase } = wire();
    // A row that is active with no link and NO mint marker: nobody has called the
    // provider, so nothing can have been minted and it is safe to mint now. (A row
    // predating the marker columns looks like this, and so does one written by hand.)
    await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: created[0].id, status: "active" });

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    // "A row already exists" must NOT be read as "already granted" — the member
    // has no link at all.
    expect(result.granted).toBe(1);
    expect(telegram.grants).toHaveLength(1);
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.inviteLink).toBe(telegram.lastInviteLink!);
    expect(telegram.liveInviteLinks).toHaveLength(1);
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("REFUSES to finish a grant whose mint was started and lost, and says so", async () => {
    const { member, channels: created } = await seed();
    // A zero-second lease so the marker is already lapsed — the state a worker
    // killed between the claim and the provider's answer leaves behind, seen after
    // the lease expires.
    const memberships = new DrizzleChannelMembershipRepository(db, { mintLeaseSeconds: 0 });
    const { telegram, whatsapp, useCase } = wire({ memberships });
    const claim = await memberships.claim({ memberId: member.id, channelId: created[0].id });
    expect(claim.outcome).toBe("mint");

    const result = await useCase.execute({ subscriptionId: (await onlySubscription()).id });

    // This used to mint a fresh link, which is how one lost link became five. A
    // link may already be live at the provider and we do not hold its value, so a
    // replacement would be a second unkillable credential.
    expect(telegram.grants).toHaveLength(0);
    expect(telegram.liveInviteLinks).toHaveLength(0);
    expect(result.granted).toBe(0);
    expect(result.mintLost).toBe(1);
    expect(result.automated).toBe(false);

    // Fails CLOSED, not SILENTLY: the member is told a human will add them, and the
    // creator's audit trail says exactly what happened.
    expect(whatsapp.notifications).toHaveLength(1);
    expect(whatsapp.notifications[0].message).toContain(MANUAL_ADDITION_NOTICE);
    const logs = await db.select().from(activityLogs);
    expect(logs[0].eventType).toBe("access_manual_required");
    expect(JSON.stringify(logs[0].metadata)).toContain("invite_link_minted_but_not_recorded");
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

/**
 * THE CREDENTIAL-LIFECYCLE INVARIANT, tested from the PROVIDER's side.
 *
 * At most one live invite link per (member, channel) may exist at the provider at
 * any time, and every link that exists is recorded in
 * `channel_membership.invite_link`.
 *
 * Every test above this block asserts on `channelMemberships` rows and on
 * `telegram.grants`. That is not the same property, and the whole-branch review
 * proved it: with `recordGrant` failing after a successful mint, the branch that
 * treated "claimed, no link" as "finish the grant" re-minted on every bounded
 * retry — 4 live single-use links at Telegram behind ONE membership row whose
 * `invite_link` was NULL. Every database assertion passed. None of the links was
 * recorded, so a join through any of them resolved to `unknown_invite_link`, no
 * `external_member_id` was ever captured, and the creator could never revoke that
 * person.
 *
 * So these tests count `telegram.liveInviteLinks` — minted minus revoked, at the
 * provider. `expect(memberships).toHaveLength(1)` is not evidence here.
 */
describe("GrantChannelAccess: at most one LIVE invite link per (member, channel)", () => {
  it("mints no second link when recordGrant fails on every attempt of the full retry bound", async () => {
    await seed();
    const { telegram, whatsapp, useCase } = wire({
      memberships: recordGrantAlwaysFails(new DrizzleChannelMembershipRepository(db)),
    });
    const subscriptionId = (await onlySubscription()).id;

    // The real retry path, not a loop over `execute`: the row is claimed,
    // attempted, failed and re-claimed by the same bounded policy production runs.
    const outboxRepository = new DrizzleOutboxRepository(db);
    await outboxRepository.enqueue({
      eventType: OUTBOX_GRANT_ACCESS,
      payload: { subscriptionId },
    });
    const processOutbox = new ProcessOutbox(
      outboxRepository,
      new Map([[OUTBOX_GRANT_ACCESS, grantAccessOutboxHandler(useCase)]]),
      // baseBackoffMs 0 so every retry is immediately due; 5 attempts is the
      // production default, and the leak scaled linearly with it.
      { maxAttempts: 5, baseBackoffMs: 0 }
    );

    // Bounded by the retry policy, not by a fixed pass count: `next_attempt_at` is
    // stamped from this process's clock and compared against the database's, so a
    // pass can find nothing due. Loop until the row is terminal.
    for (let pass = 0; pass < 20; pass++) {
      const [current] = await db.select().from(outbox);
      if (current.status !== "pending") break;
      await processOutbox.execute();
    }

    // The row is terminal, which is correct — recordGrant never recovers.
    const [row] = await db.select().from(outbox);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);

    // THE ASSERTION, and the one the old tests could not make: ZERO live links at
    // the provider. Before the fix this was 5 — one per attempt, all live, all
    // single-use, none recorded, none revocable.
    expect(telegram.liveInviteLinks).toHaveLength(0);

    // Nothing minted is unaccounted for. Each attempt is free to mint again ONLY
    // because the previous attempt's link was killed at the provider first, so
    // mints and revokes balance exactly.
    expect(telegram.grants.length).toBeGreaterThan(0);
    expect(telegram.revokedInviteLinks).toHaveLength(telegram.issuedLinks.length);
    const [membership] = await db.select().from(channelMemberships);
    expect(membership.inviteLink).toBeNull();
    // And the window was reopened each time, so nothing is left half-claimed.
    expect(membership.linkMintedAt).toBeNull();

    // The member was never handed a link that does not work.
    expect(whatsapp.notifications).toHaveLength(0);
  });

  it("mints no second link when a cleanup revoke ALSO fails — it refuses instead", async () => {
    await seed();
    // A zero-second lease so the retries that follow the failed cleanup reach the
    // `mint_lost` branch immediately instead of after the default minute. In
    // production the 30s backoff and the 60s lease mean the first retry or two
    // report "in progress" and the ones after that report manual — same end state.
    const { telegram, useCase } = wire({
      memberships: recordGrantAlwaysFails(
        new DrizzleChannelMembershipRepository(db, { mintLeaseSeconds: 0 })
      ),
    });
    const subscriptionId = (await onlySubscription()).id;
    // The one path that legitimately leaves an orphan: we minted, could not record
    // it, and could not kill it either. The marker must stay set so the retries
    // that follow refuse rather than stacking a second credential on top.
    telegram.failNextInviteLinkRevoke = true;

    for (let attempt = 0; attempt < 5; attempt++) {
      await useCase.execute({ subscriptionId }).catch(() => {});
    }

    // One orphan, not five. It is reported, not hidden — see the manual/log
    // assertions below.
    expect(telegram.liveInviteLinks).toHaveLength(1);
    expect(telegram.grants).toHaveLength(1);

    const logs = await db.select().from(activityLogs);
    const reported = logs.filter(
      (log) =>
        log.eventType === "access_manual_required" &&
        JSON.stringify(log.metadata).includes("invite_link_minted_but_not_recorded")
    );
    expect(reported.length).toBeGreaterThan(0);
    // The orphan is never named in the audit trail — it is still a live credential.
    expect(JSON.stringify(logs)).not.toContain(telegram.issuedLinks[0]);
  });

  it("mints ONE link for two concurrent executes of the same (member, channel)", async () => {
    // Fully reachable without a second worker: StartCheckout lets one member buy
    // two tiers of the same community, both tiers resolve the same channel list,
    // so both activations enqueue a grant for the same (member, channel).
    //
    // THE INTERLEAVING IS FORCED, not raced. Written first as two bare concurrent
    // `execute` calls, this PASSED against the unfixed code — the second caller
    // happened to claim after the first had already recorded its link, so it took
    // the `already_granted` path. A test of a concurrency invariant that depends on
    // the scheduler proves nothing (the same lesson drizzle-outbox.repository.test.ts
    // records for `claimBatch`).
    //
    // The latch holds caller 1 inside `grantAccess` until caller 2's CLAIM has
    // returned, which is the state the bug needs. Causal, not temporal: it releases
    // because the second claim happened, never merely because time passed — see
    // `ClaimLatch`.
    await seed();
    const latch = new ClaimLatch(2);
    const { telegram, useCase } = wire({
      memberships: countingClaims(new DrizzleChannelMembershipRepository(db), latch),
      beforeMint: () => latch.wait(),
    });
    const subscriptionId = (await onlySubscription()).id;

    const outcomes = await Promise.allSettled([
      useCase.execute({ subscriptionId }),
      useCase.execute({ subscriptionId }),
    ]);

    // Exactly one live credential. The loser must not have minted one, and must
    // not have overwritten the winner's record with an orphan either.
    expect(telegram.liveInviteLinks).toHaveLength(1);
    expect(telegram.grants).toHaveLength(1);

    const memberships = await db.select().from(channelMemberships);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].inviteLink).toBe(telegram.liveInviteLinks[0]);

    // One caller succeeded. The other either reported "in progress" and threw, so
    // its outbox row retries and then finds the recorded link, or it observed the
    // finished grant — never a second mint.
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    for (const outcome of rejected) {
      expect(String(outcome.reason)).toMatch(/in progress/i);
    }
  });

  it("a retry after an in-progress report delivers the link the winner recorded", async () => {
    // The other half of the concurrency case: "report, do not mint" is only correct
    // if the retry then works. Otherwise the second purchase's row fails
    // permanently and the member is told nothing at all.
    await seed();
    const { telegram, whatsapp, useCase } = wire();
    const subscriptionId = (await onlySubscription()).id;

    await Promise.allSettled([
      useCase.execute({ subscriptionId }),
      useCase.execute({ subscriptionId }),
    ]);
    const retry = await useCase.execute({ subscriptionId });

    expect(retry.alreadyGranted).toBe(1);
    expect(retry.automated).toBe(true);
    expect(telegram.liveInviteLinks).toHaveLength(1);
    expect(whatsapp.notifications.at(-1)!.message).toContain(telegram.liveInviteLinks[0]);
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

  /**
   * Task 7b. Now that `POST /webhooks/telegram` records a member's Telegram user id,
   * a RE-grant can and must pass it back to the adapter.
   *
   * The Telegram rule this exists for: `banChatMember` — how `revokeAccess` removes
   * someone — also blocks them from joining via ANY invite link. So a churned member
   * who re-pays gets a fresh link that silently does not work until they are
   * unbanned, and `unbanChatMember` needs their user id. Before this, no id was ever
   * recorded, so nothing could be passed and the limitation was documented instead.
   * With ids being recorded, NOT passing it would make the first genuinely-automated
   * revocation a permanent lockout.
   */
  it("passes a previously recorded member id back to the adapter on a RE-grant", async () => {
    const { channels: created } = await seed();
    const memberships = new DrizzleChannelMembershipRepository(db);
    const { telegram, useCase } = wire();
    const subscriptionId = (await onlySubscription()).id;

    // First grant, then the join that records the id, then a revoke.
    await useCase.execute({ subscriptionId });
    const [granted] = await db.select().from(channelMemberships);
    await memberships.recordPlatformMemberIdByInviteLink({
      inviteLink: granted.inviteLink!,
      externalGroupId: created[0].externalGroupId!,
      externalMemberId: "987654321",
    });
    await memberships.revoke(granted.id);

    // The member re-pays: a new outbox row for the same subscription.
    await useCase.execute({ subscriptionId });

    expect(telegram.grants).toHaveLength(2);
    // The first grant could not have carried one — there was nothing recorded yet.
    expect(telegram.grants[0].previousExternalMemberId).toBeUndefined();
    // The second must, or the fresh link it issues admits nobody.
    expect(telegram.grants[1].previousExternalMemberId).toBe("987654321");
  });

  it("passes nothing on a re-grant when no member id was ever recorded", async () => {
    // The ordinary Phase 4 state: the member never joined, so nothing was recorded.
    // `previousExternalMemberId` must be ABSENT rather than null or "", because
    // TelegramBotAdapter treats its presence as "call unbanChatMember".
    await seed();
    const memberships = new DrizzleChannelMembershipRepository(db);
    const { telegram, useCase } = wire();
    const subscriptionId = (await onlySubscription()).id;

    await useCase.execute({ subscriptionId });
    const [granted] = await db.select().from(channelMemberships);
    await memberships.revoke(granted.id);
    await useCase.execute({ subscriptionId });

    expect(telegram.grants).toHaveLength(2);
    expect("previousExternalMemberId" in telegram.grants[1]).toBe(false);
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

/**
 * The real repository with `recordGrant` failing, and NOTHING else changed.
 *
 * This is the mutation the whole-branch review used, and it is not exotic: a
 * connection reset, a statement timeout or a failover between the provider's
 * response and our write produces exactly this. The mint has already happened at
 * that point, which is what makes it the sharpest test of the invariant — the
 * credential exists and our record of it does not.
 */
function recordGrantAlwaysFails(
  real: ChannelMembershipRepositoryPort
): ChannelMembershipRepositoryPort {
  return {
    claim: (input) => real.claim(input),
    recordGrant: async () => {
      throw new Error("simulated: the database went away between the mint and the write");
    },
    releaseMintWindow: (id) => real.releaseMintWindow(id),
    recordPlatformMemberIdByInviteLink: (input) =>
      real.recordPlatformMemberIdByInviteLink(input),
    revoke: (id) => real.revoke(id),
    findByIdWithChannel: (id) => real.findByIdWithChannel(id),
    listActiveForMemberInCommunity: (memberId, communityId) =>
      real.listActiveForMemberInCommunity(memberId, communityId),
  };
}

/** The one subscription `seed()` created — keeps each test's setup to one line. */
async function onlySubscription() {
  const rows = await db.select().from(subscriptions);
  expect(rows).toHaveLength(1);
  return rows[0];
}
