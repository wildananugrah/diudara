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
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "../../infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleCommunityRepository } from "../../infrastructure/repositories/drizzle-community.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { NotFoundError } from "../errors";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import { RevokeChannelAccess } from "./revoke-channel-access";

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
  const useCase = new RevokeChannelAccess(
    new DrizzleCommunityRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    new Map<string, MessagingProviderPort>([
      ["telegram", telegram],
      ["whatsapp", whatsapp],
    ])
  );
  return { telegram, whatsapp, useCase };
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
