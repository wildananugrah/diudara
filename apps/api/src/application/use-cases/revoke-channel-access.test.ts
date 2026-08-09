import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  channelMemberships,
  channels,
  communities,
  creators,
  members,
  outbox,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "../../infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleCommunityRepository } from "../../infrastructure/repositories/drizzle-community.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { NotFoundError } from "../errors";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import {
  RetryChannelAccessRevocation,
  RevokeChannelAccess,
  revokeAccessOutboxHandler,
} from "./revoke-channel-access";

beforeEach(resetDatabase);

let seq = 0;

async function seed(options: { platform?: string; externalMemberId?: string | null } = {}) {
  seq += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${seq}-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${seq}-${Date.now()}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      communityId: community.id,
      platform: options.platform ?? "telegram",
      externalGroupId: `-100${seq}${Date.now()}`,
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${seq}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  const [membership] = await db
    .insert(channelMemberships)
    .values({
      memberId: member.id,
      channelId: channel.id,
      // Unique per seed, like a real invite link — and now REQUIRED to be:
      // `channel_membership_invite_link_unique` (Task 7b) makes the link the
      // unambiguous lookup key for recording a joining member's platform user id.
      inviteLink: `https://t.me/+granted-${seq}-${Date.now()}`,
      // Nothing records a provider member id at GRANT time (there is nothing to
      // record it from). Tests that want the AUTOMATED path set it explicitly,
      // which is exactly the state POST /webhooks/telegram produces when the member
      // joins — see routes/channel-access-lifecycle.test.ts for that path end to
      // end, through real HTTP, with no value set by hand.
      externalMemberId: options.externalMemberId ?? null,
    })
    .returning();
  return { creator, community, channel, member, membership };
}

function wire() {
  const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
  const whatsapp = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  // The real outbox repository against the test database: a removal the provider could
  // not perform has to end up as a row the worker can see, and asserting on a
  // hand-written fake would only prove the fake was called.
  const outboxRepository = new DrizzleOutboxRepository(db);
  const useCase = new RevokeChannelAccess(
    new DrizzleCommunityRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    new Map<string, MessagingProviderPort>([
      ["telegram", telegram],
      ["whatsapp", whatsapp],
    ]),
    outboxRepository
  );
  return { telegram, whatsapp, useCase, outboxRepository };
}

async function membershipById(id: string) {
  const [row] = await db.select().from(channelMemberships).where(eq(channelMemberships.id, id));
  return row;
}

describe("RevokeChannelAccess", () => {
  it("removes the member through the provider and marks the membership revoked", async () => {
    const { creator, community, channel, member, membership } = await seed({
      externalMemberId: "987654321",
    });
    const { telegram, useCase } = wire();

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.revoked).toBe(1);
    expect(result.automated).toBe(true);
    expect(telegram.revocations).toEqual([
      { externalGroupId: channel.externalGroupId!, externalMemberId: "987654321" },
    ]);

    const row = await membershipById(membership.id);
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).toBeInstanceOf(Date);
    // The link dies with the membership: it is a bearer credential, and a
    // revoked row that still carries one is a live key on a closed door.
    expect(row.inviteLink).toBeNull();

    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("channel_access_revoked");
    expect(logs[0].memberId).toBe(member.id);
    expect(logs[0].communityId).toBe(community.id);
  });

  describe("creator scoping", () => {
    it("404s for a stranger AND leaves the membership completely unchanged", async () => {
      const { community, member, membership } = await seed({ externalMemberId: "987654321" });
      const [stranger] = await db
        .insert(creators)
        .values({ name: "Stranger", email: `s-${Date.now()}@example.com` })
        .returning();
      const { telegram, useCase } = wire();
      const before = await membershipById(membership.id);

      await expect(
        useCase.execute({
          communityId: community.id,
          creatorId: stranger.id,
          memberId: member.id,
        })
      ).rejects.toBeInstanceOf(NotFoundError);

      // BOTH halves. A 404 that still removed the member would be worse than a
      // 403 that did not.
      const after = await membershipById(membership.id);
      expect(after).toEqual(before);
      expect(after.status).toBe("active");
      expect(telegram.revocations).toEqual([]);
      expect(await db.select().from(activityLogs)).toHaveLength(0);
    });

    it("404s rather than 403s, so a stranger learns nothing about the community", async () => {
      const { community, member } = await seed();
      const [stranger] = await db
        .insert(creators)
        .values({ name: "Stranger", email: `s2-${Date.now()}@example.com` })
        .returning();
      const { useCase } = wire();

      const error = await useCase
        .execute({ communityId: community.id, creatorId: stranger.id, memberId: member.id })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).status).toBe(404);
    });
  });

  it("404s when the member has no active membership in this community", async () => {
    const { creator, community, member, membership } = await seed();
    const { useCase } = wire();
    await new DrizzleChannelMembershipRepository(db).revoke(membership.id);

    await expect(
      useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s for a member who was never in this community at all", async () => {
    const { creator, community } = await seed();
    const other = await seed();
    const { useCase } = wire();

    await expect(
      useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        // A real member, with a real active membership — in someone else's
        // community.
        memberId: other.member.id,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await membershipById(other.membership.id)).status).toBe("active");
  });

  describe("what cannot be automated is reported, not claimed", () => {
    it("says so for a notify-only channel", async () => {
      const { creator, community, member, membership } = await seed({ platform: "whatsapp" });
      const { whatsapp, useCase } = wire();

      const result = await useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      });

      // The entitlement is withdrawn — that part IS ours to do — but WhatsApp
      // cannot remove anyone from a group (spec §2.1), so the creator has to.
      // Saying "revoked" with nothing else would leave a removed member sitting
      // in the group with the creator believing otherwise.
      expect(result.revoked).toBe(1);
      expect(result.automated).toBe(false);
      expect(result.channels[0].automated).toBe(false);
      expect(result.channels[0].reason).toBe("provider_cannot_gate_access");
      expect(whatsapp.revocations).toEqual([]);
      expect((await membershipById(membership.id)).status).toBe("revoked");

      const logs = await db.select().from(activityLogs);
      expect(logs[0].eventType).toBe("channel_access_revoked");
      expect(JSON.stringify(logs[0].metadata)).toContain("provider_cannot_gate_access");
    });

    it("says so when no provider member id was ever recorded", async () => {
      // A member who was invited but never joined, so no `chat_member` update ever
      // arrived and we never learned their Telegram user id — and banChatMember
      // addresses one. This must not look like a completed removal.
      const { creator, community, member } = await seed({ externalMemberId: null });
      const { telegram, useCase } = wire();

      const result = await useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      });

      expect(result.revoked).toBe(1);
      expect(result.automated).toBe(false);
      expect(result.channels[0].reason).toBe("no_provider_member_id_recorded");
      expect(telegram.revocations).toEqual([]);
    });

    it("says so when the platform has no provider wired", async () => {
      const { creator, community, member, membership } = await seed({ platform: "discord" });
      const { useCase } = wire();

      const result = await useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      });

      expect(result.automated).toBe(false);
      expect(result.channels[0].reason).toBe("no_provider_for_platform");
      // Still revoked in OUR records: the creator asked for this, and leaving the
      // row active would mean Phase 5's churn revocation retries forever.
      expect((await membershipById(membership.id)).status).toBe("revoked");
    });

    it("reports a provider that FAILED without pretending it succeeded", async () => {
      const { creator, community, member, membership } = await seed({
        externalMemberId: "987654321",
      });
      const { telegram, useCase } = wire();
      telegram.failNextRevoke = true;

      const result = await useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      });

      expect(result.automated).toBe(false);
      expect(result.channels[0].reason).toBe("provider_error");
      // The entitlement is still withdrawn, and the audit entry records the
      // failure — a creator who is told "done" and finds them still in the group
      // is the failure mode this avoids.
      expect((await membershipById(membership.id)).status).toBe("revoked");
      const logs = await db.select().from(activityLogs);
      expect(JSON.stringify(logs[0].metadata)).toContain("provider_error");
    });
  });

  it("revokes every active membership the member has in the community", async () => {
    const { creator, community, member } = await seed({ externalMemberId: "111" });
    const [second] = await db
      .insert(channels)
      .values({
        communityId: community.id,
        platform: "telegram",
        externalGroupId: `-100second${Date.now()}`,
      })
      .returning();
    await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: second.id, externalMemberId: "111" });
    const { telegram, useCase } = wire();

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.revoked).toBe(2);
    expect(telegram.revocations).toHaveLength(2);
    const rows = await db.select().from(channelMemberships);
    expect(rows.every((row) => row.status === "revoked")).toBe(true);
  });

  it("is idempotent: a second revoke finds nothing active and 404s", async () => {
    const { creator, community, member } = await seed({ externalMemberId: "111" });
    const { telegram, useCase } = wire();
    const input = { communityId: community.id, creatorId: creator.id, memberId: member.id };

    await useCase.execute(input);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(NotFoundError);

    // One provider call and one audit entry, not two.
    expect(telegram.revocations).toHaveLength(1);
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  it("keeps the invite link out of the audit trail", async () => {
    const { creator, community, member } = await seed({ externalMemberId: "111" });
    const { useCase } = wire();

    await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    const logs = await db.select().from(activityLogs);
    expect(JSON.stringify(logs)).not.toContain("t.me");
  });

  it("takes no HTTP anything — Phase 5 calls it from churn detection", () => {
    // Not a formality: the churn job has no Context, no request and no bearer
    // token. `execute` takes three ids and returns a plain object, so the only
    // thing Phase 5 has to supply is the creator id it already has.
    const { useCase } = wire();
    expect(useCase.execute.length).toBe(1);
  });
});

/**
 * I3, final whole-branch review: revocation had no retry path, and Phase 5 is built
 * on it.
 *
 * The membership was revoked even when the provider call failed, `automated: false`
 * was returned, and NOTHING ever tried again. For a creator clicking a button that is
 * honest — they are told. For Phase 5's churn job it means a churned member stays in
 * the paid group forever, with no durable record anywhere that a removal is owed.
 */
describe("RevokeChannelAccess — an outstanding removal is recorded for retry", () => {
  async function outboxRows() {
    return db.select().from(outbox);
  }

  it("enqueues a revoke_access row when the provider FAILS", async () => {
    const { creator, community, member, membership } = await seed({
      externalMemberId: "987654321",
    });
    const { telegram, useCase } = wire();
    telegram.failNextRevoke = true;

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.channels[0].reason).toBe("provider_error");
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("revoke_access");
    // Ids only, as every payload in this codebase is.
    expect(rows[0].payload).toEqual({
      membershipId: membership.id,
      communityId: community.id,
      memberId: member.id,
    });
    expect(rows[0].status).toBe("pending");
  });

  it("enqueues one when no platform member id was ever recorded", async () => {
    // It may become satisfiable: a `chat_member` update can land between the failure
    // and the retry. When it has not, the handler records manual action rather than
    // burning the retry bound — see the retry tests below.
    const { creator, community, member } = await seed({ externalMemberId: null });
    const { useCase } = wire();

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.channels[0].reason).toBe("no_provider_member_id_recorded");
    expect(await outboxRows()).toHaveLength(1);
  });

  it("enqueues NOTHING for a provider that can never gate, or a platform not wired", async () => {
    // WhatsApp will never be able to remove anyone and an unwired platform needs a
    // deploy. A row for either would retry five times and fail permanently, which is
    // operator noise rather than a record of anything actionable.
    const whatsappOnly = await seed({ platform: "whatsapp", externalMemberId: "111" });
    const { useCase } = wire();
    await useCase.execute({
      communityId: whatsappOnly.community.id,
      creatorId: whatsappOnly.creator.id,
      memberId: whatsappOnly.member.id,
    });

    const unwired = await seed({ platform: "discord", externalMemberId: "111" });
    await useCase.execute({
      communityId: unwired.community.id,
      creatorId: unwired.creator.id,
      memberId: unwired.member.id,
    });

    expect(await outboxRows()).toHaveLength(0);
  });

  it("enqueues nothing at all when the removal SUCCEEDED", async () => {
    const { creator, community, member } = await seed({ externalMemberId: "987654321" });
    const { useCase } = wire();

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.automated).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("revokes the INVITE LINK too, so a member who never joined cannot still use it", async () => {
    // Part of the credential-lifecycle invariant: `revoke` NULLS `invite_link`, so
    // without this the link goes on admitting whoever holds it — unrecorded and
    // therefore unrevocable — until it expires. `member_limit: 1` does not help a link
    // that was never used, which is exactly this case.
    const { creator, community, member, membership } = await seed({ externalMemberId: null });
    const { telegram, useCase } = wire();
    const issuedLink = membership.inviteLink!;

    await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(telegram.revokedInviteLinks.map((entry) => entry.inviteLink)).toEqual([issuedLink]);
  });

  it("still revokes the membership when the invite-link cleanup fails", async () => {
    // Best-effort: `banChatMember` is what decides `automated`, and a creator must not
    // be told the removal failed because a link cleanup did.
    const { creator, community, member, membership } = await seed({
      externalMemberId: "987654321",
    });
    const { telegram, useCase } = wire();
    telegram.failNextInviteLinkRevoke = true;

    const result = await useCase.execute({
      communityId: community.id,
      creatorId: creator.id,
      memberId: member.id,
    });

    expect(result.automated).toBe(true);
    expect((await membershipById(membership.id)).status).toBe("revoked");
  });

  it("summarises a provider error the same way ProcessOutbox does", async () => {
    // MINORS, final whole-branch review: this used `redactLinks(err.message)` while
    // ProcessOutbox used `redactLinks(safeErrorSummary(err))`, so a WRAPPED driver
    // error kept its multi-line, parameter-bearing message here. Two guards for the
    // same class of error must not drift — the exact drift class Task 8 found.
    const { creator, community, member } = await seed({ externalMemberId: "987654321" });
    const { telegram, useCase } = wire();
    // A drizzle-shaped wrapper: the statement and its bound parameters outside, the
    // reason on `.cause`, and an invite link interpolated in for good measure.
    telegram.revokeAccess = async () => {
      throw new Error(
        "Failed query: update channel_membership set x = $1\nparams: https://t.me/+SECRET",
        { cause: new Error("connection terminated unexpectedly") }
      );
    };

    const lines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await useCase.execute({
        communityId: community.id,
        creatorId: creator.id,
        memberId: member.id,
      });
    } finally {
      console.warn = originalWarn;
    }

    const logged = lines.join("\n");
    // The reason on the cause survives...
    expect(logged).toContain("connection terminated unexpectedly");
    // ...the bound parameters and the link do not...
    expect(logged).not.toContain("t.me/+SECRET");
    expect(logged).not.toContain("params:");
    // ...and no diagnostic forges a second log line.
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });
});

/**
 * The other half of I3: the worker actually completing a removal the API could not.
 */
describe("RetryChannelAccessRevocation", () => {
  function retryWire() {
    const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const useCase = new RetryChannelAccessRevocation(
      new DrizzleChannelMembershipRepository(db),
      new DrizzleActivityLogRepository(db),
      new Map<string, MessagingProviderPort>([["telegram", telegram]])
    );
    return { telegram, useCase };
  }

  /** A revoked membership whose platform removal never happened. */
  async function outstanding(externalMemberId: string | null) {
    const seeded = await seed({ externalMemberId });
    const { telegram, useCase } = wire();
    telegram.failNextRevoke = true;
    await useCase.execute({
      communityId: seeded.community.id,
      creatorId: seeded.creator.id,
      memberId: seeded.member.id,
    });
    await db.delete(activityLogs);
    return seeded;
  }

  it("removes the member on a later attempt, and says the removal was retried", async () => {
    const { community, member, membership, channel } = await outstanding("987654321");
    const { telegram, useCase } = retryWire();

    const outcome = await useCase.execute({
      membershipId: membership.id,
      communityId: community.id,
      memberId: member.id,
    });

    expect(outcome).toBe("removed");
    // THE ASSERTION: the person is actually out of the group, which the synchronous
    // revoke never achieved and never retried. The group and member ids are read back
    // off the row at retry time, so both are asserted.
    expect(telegram.revocations).toEqual([
      { externalGroupId: channel.externalGroupId!, externalMemberId: "987654321" },
    ]);
    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    // `retried: true` distinguishes a late completion from a double revocation.
    expect(JSON.stringify(logs[0].metadata)).toContain('"retried":true');
  });

  it("THROWS when the provider fails again, so the outbox schedules another attempt", async () => {
    const { community, member, membership } = await outstanding("987654321");
    const { telegram, useCase } = retryWire();
    telegram.failNextRevoke = true;

    // A throw is the ONLY way to get another attempt, and the outbox is what bounds
    // them — five, then permanently failed with `last_error`.
    await expect(
      useCase.execute({
        membershipId: membership.id,
        communityId: community.id,
        memberId: member.id,
      })
    ).rejects.toThrow();
  });

  it("does nothing when the member has been re-granted since", async () => {
    // They re-paid and were granted again. Removing them now would eject somebody who
    // is currently entitled to be there.
    const { community, member, membership, channel } = await outstanding("987654321");
    await new DrizzleChannelMembershipRepository(db).claim({
      memberId: member.id,
      channelId: channel.id,
    });
    const { telegram, useCase } = retryWire();

    const outcome = await useCase.execute({
      membershipId: membership.id,
      communityId: community.id,
      memberId: member.id,
    });

    expect(outcome).toBe("no_longer_outstanding");
    expect(telegram.revocations).toHaveLength(0);
  });

  it("records manual action instead of retrying when no member id can ever arrive", async () => {
    // `revoke` nulled the invite link, so no `chat_member` update can resolve back to
    // this row and no later attempt can learn the id. Retrying would burn the bound to
    // reach the same conclusion; a durable record is what a person actually needs.
    const { community, member, membership } = await outstanding(null);
    const { telegram, useCase } = retryWire();

    const outcome = await useCase.execute({
      membershipId: membership.id,
      communityId: community.id,
      memberId: member.id,
    });

    expect(outcome).toBe("manual_action_required");
    expect(telegram.revocations).toHaveLength(0);
    const logs = await db.select().from(activityLogs);
    expect(logs[0].eventType).toBe("revocation_manual_required");
    expect(JSON.stringify(logs[0].metadata)).toContain("no_provider_member_id_recorded");
  });

  it("treats a membership that no longer exists as nothing to do", async () => {
    const { useCase } = retryWire();

    expect(
      await useCase.execute({
        membershipId: "3f1c9e0a-1111-4222-8333-444455556666",
        communityId: "3f1c9e0a-1111-4222-8333-444455556667",
        memberId: "3f1c9e0a-1111-4222-8333-444455556668",
      })
    ).toBe("no_longer_outstanding");
  });
});

describe("revokeAccessOutboxHandler", () => {
  it("rejects a payload with no usable ids, without echoing it", async () => {
    const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    const handler = revokeAccessOutboxHandler(
      new RetryChannelAccessRevocation(
        new DrizzleChannelMembershipRepository(db),
        new DrizzleActivityLogRepository(db),
        new Map<string, MessagingProviderPort>([["telegram", telegram]])
      )
    );

    for (const payload of [
      null,
      "nope",
      {},
      { membershipId: "m" },
      { membershipId: "m", communityId: "c" },
      { membershipId: 1, communityId: "c", memberId: "x" },
      { membershipId: "", communityId: "c", memberId: "x" },
    ]) {
      await expect(handler(payload)).rejects.toThrow(/deliberately not repeated/);
    }
  });

  it("passes the payload's ids to the use-case", async () => {
    const { community, member, membership } = await (async () => {
      const seeded = await seed({ externalMemberId: "987654321" });
      const { telegram: t, useCase: u } = wire();
      t.failNextRevoke = true;
      await u.execute({
        communityId: seeded.community.id,
        creatorId: seeded.creator.id,
        memberId: seeded.member.id,
      });
      return seeded;
    })();

    const telegram = new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true });
    await revokeAccessOutboxHandler(
      new RetryChannelAccessRevocation(
        new DrizzleChannelMembershipRepository(db),
        new DrizzleActivityLogRepository(db),
        new Map<string, MessagingProviderPort>([["telegram", telegram]])
      )
    )({ membershipId: membership.id, communityId: community.id, memberId: member.id });

    expect(telegram.revocations).toHaveLength(1);
    expect(telegram.revocations[0].externalMemberId).toBe("987654321");
  });
});
