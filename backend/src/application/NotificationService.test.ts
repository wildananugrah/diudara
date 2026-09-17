import { describe, expect, test } from "bun:test";
import { NotificationService } from "./NotificationService.ts";
import type {
  CommunityRepository, MembershipRepository, Notification, NotificationRepository,
  PostRepository, TierRepository, UserRepository,
} from "../domain/ports.ts";

/**
 * Two communities' worth of people, so "who hears about this" is a real question
 * rather than something the fakes decide for us:
 *
 *   bimbel-sbmptn — andi owns it, dewi admins it, sari is a member
 *   rangga        — a stranger, member of nothing
 */
function makeService() {
  const written: Array<Parameters<NotificationRepository["create"]>[0]> = [];
  const rows: Notification[] = [];

  const notifications = {
    create: async (input: Parameters<NotificationRepository["create"]>[0]) => {
      written.push(input);
      const row: Notification = {
        id: `n${written.length}`, type: input.type, actorId: input.actorId ?? null,
        communityId: input.communityId ?? null, entityId: input.entityId ?? null,
        data: input.data, createdAt: new Date(), readAt: null,
      };
      rows.push(row);
      return row;
    },
  } as unknown as NotificationRepository;

  const users = {
    findById: async (id: string) => ({
      id, name: { andi: "Pak Andi", sari: "Sari Wulandari", dewi: "Bu Dewi" }[id] ?? id,
      email: `${id}@diudara.id`, handle: `@${id}`, avatarColor: "#2b4c6f", initials: "XX",
    }),
  } as unknown as UserRepository;

  const communities = {
    findById: async (id: string) => (id === "bimbel-sbmptn"
      ? { id, name: "Bimbel Matematika Pak Andi" }
      : null),
  } as unknown as CommunityRepository;

  const tiers = {
    findById: async (id: string) => (id === "t-pro" ? { id, name: "Pro", priceCents: 14900000 } : null),
  } as unknown as TierRepository;

  const memberships = {
    listMembers: async (communityId: string) => (communityId === "bimbel-sbmptn"
      ? [
          { userId: "andi", name: "Pak Andi", role: "owner", status: "active" },
          { userId: "dewi", name: "Bu Dewi", role: "admin", status: "active" },
          { userId: "sari", name: "Sari Wulandari", role: "member", status: "active" },
          { userId: "lama", name: "Anggota Lama", role: "admin", status: "churned" },
        ]
      : []),
  } as unknown as MembershipRepository;

  const posts = {
    findById: async (id: string) => (id === "p1"
      ? { id, title: "Cara cepat integral", type: "diskusi", communityId: "bimbel-sbmptn", authorId: "andi" }
      : null),
  } as unknown as PostRepository;

  return {
    service: new NotificationService(notifications, users, communities, tiers, memberships, posts),
    written,
    rows,
  };
}

describe("post.commented", () => {
  test("tells the post's author who replied, and to what", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "post.commented", postId: "p1", postAuthorId: "andi",
      actorId: "sari", communityId: "bimbel-sbmptn",
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      userId: "andi", type: "post.commented", actorId: "sari",
      communityId: "bimbel-sbmptn", entityId: "p1",
    });
    // The sentence is the frontend's job, but it can only build one from this.
    expect(written[0]!.data).toMatchObject({
      actorName: "Sari Wulandari", postTitle: "Cara cepat integral", postType: "diskusi",
    });
  });

  test("says nothing when you comment on your own post", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "post.commented", postId: "p1", postAuthorId: "andi",
      actorId: "andi", communityId: "bimbel-sbmptn",
    });
    expect(written).toEqual([]);
  });

  test("writes nothing rather than a half-empty row when the post is gone", async () => {
    // A comment on a post deleted in the same second is a race, not a crash.
    const { service, written } = makeService();
    await service.handle({
      type: "post.commented", postId: "deleted", postAuthorId: "andi",
      actorId: "sari", communityId: "bimbel-sbmptn",
    });
    expect(written).toEqual([]);
  });
});

describe("payment.confirmed", () => {
  test("tells the buyer what they bought", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "payment.confirmed", userId: "sari", communityId: "bimbel-sbmptn",
      tierId: "t-pro", paymentId: "pay1",
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ userId: "sari", type: "payment.confirmed", entityId: "pay1" });
    // Cents, not "Rp149.000" — formatting is lib/format.ts's job (CLAUDE.md).
    expect(written[0]!.data).toMatchObject({
      communityName: "Bimbel Matematika Pak Andi", tierName: "Pro", amountCents: 14900000,
    });
  });
});

describe("member.joined", () => {
  test("reaches every active admin and owner, and nobody else", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "member.joined", communityId: "bimbel-sbmptn", memberId: "sari", tierId: "t-pro",
    });

    expect(written.map((w) => w.userId).sort()).toEqual(["andi", "dewi"]);
    expect(written[0]).toMatchObject({ type: "member.joined", actorId: "sari" });
    expect(written[0]!.data).toMatchObject({ actorName: "Sari Wulandari", tierName: "Pro" });
  });

  test("never tells an admin about their own purchase", async () => {
    // dewi admins this community and subscribes to it: one notification, not two.
    const { service, written } = makeService();
    await service.handle({
      type: "member.joined", communityId: "bimbel-sbmptn", memberId: "dewi", tierId: "t-pro",
    });
    expect(written.map((w) => w.userId)).toEqual(["andi"]);
  });

  test("skips admins who are no longer active members", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "member.joined", communityId: "bimbel-sbmptn", memberId: "sari", tierId: "t-pro",
    });
    expect(written.map((w) => w.userId)).not.toContain("lama");
  });
});

describe("membership.ended and message.sent", () => {
  test("tells the removed member which community they lost", async () => {
    const { service, written } = makeService();
    await service.handle({ type: "membership.ended", userId: "sari", communityId: "bimbel-sbmptn" });
    expect(written[0]).toMatchObject({ userId: "sari", type: "membership.ended" });
    expect(written[0]!.data).toMatchObject({ communityName: "Bimbel Matematika Pak Andi" });
  });

  test("tells the recipient of a message, never the sender", async () => {
    const { service, written } = makeService();
    await service.handle({
      type: "message.sent", conversationId: "c1", senderId: "andi",
      recipientId: "sari", preview: "Halo, materi besok jadi?",
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ userId: "sari", actorId: "andi", entityId: "c1" });
    expect(written[0]!.data).toMatchObject({ actorName: "Pak Andi", preview: "Halo, materi besok jadi?" });
  });
});
