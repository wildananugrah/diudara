import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import {
  channelMemberships,
  channels,
  communities,
  creators,
  members,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleChannelMembershipRepository } from "./drizzle-channel-membership.repository";

beforeEach(resetDatabase);

const repository = () => new DrizzleChannelMembershipRepository(db);

let seq = 0;
async function seed(platform = "telegram") {
  seq += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}-${seq}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${Date.now()}-${seq}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      communityId: community.id,
      platform,
      externalGroupId: `-100${Date.now()}${seq}`,
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${seq}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  return { creator, community, channel, member };
}

describe("DrizzleChannelMembershipRepository.claim", () => {
  it("claims the (member, channel) pair and reports that it won", async () => {
    const { channel, member } = await seed();

    const claimed = await repository().claim({ memberId: member.id, channelId: channel.id });

    expect(claimed.won).toBe(true);
    expect(claimed.membership.status).toBe("active");
    // The link is attached AFTER the provider issues it, so the claim leaves it
    // empty — an unfinished grant is distinguishable from a finished one.
    expect(claimed.membership.inviteLink).toBeNull();
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("reports a LOSS on a second claim, and writes no second row", async () => {
    const { channel, member } = await seed();
    const first = await repository().claim({ memberId: member.id, channelId: channel.id });
    await repository().recordGrant(first.membership.id, "https://t.me/+first");

    const second = await repository().claim({ memberId: member.id, channelId: channel.id });

    // The unique index arbitrates, not a pre-check: `won: false` is how the
    // caller learns not to issue a second invite link.
    expect(second.won).toBe(false);
    expect(second.membership.id).toBe(first.membership.id);
    expect(second.membership.inviteLink).toBe("https://t.me/+first");
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });

  it("does not throw on the losing claim — the caller needs the existing row", async () => {
    const { channel, member } = await seed();
    await repository().claim({ memberId: member.id, channelId: channel.id });

    // A raised unique violation here would become a retry loop that can never
    // succeed. The loser must be able to read what is already there.
    const second = await repository().claim({ memberId: member.id, channelId: channel.id });
    expect(second.membership.inviteLink).toBeNull();
  });

  it("keeps different members and different channels independent", async () => {
    const { community, channel, member } = await seed();
    const [otherChannel] = await db
      .insert(channels)
      .values({
        communityId: community.id,
        platform: "telegram",
        externalGroupId: `-100other${Date.now()}`,
      })
      .returning();
    const [otherMember] = await db
      .insert(members)
      .values({ whatsappNumber: `+62999${Date.now()}`.slice(0, 15) })
      .returning();

    expect((await repository().claim({ memberId: member.id, channelId: channel.id })).won).toBe(
      true
    );
    expect(
      (await repository().claim({ memberId: member.id, channelId: otherChannel.id })).won
    ).toBe(true);
    expect(
      (await repository().claim({ memberId: otherMember.id, channelId: channel.id })).won
    ).toBe(true);
    expect(await db.select().from(channelMemberships)).toHaveLength(3);
  });

  it("reclaims a REVOKED row instead of leaving it dead", async () => {
    const { channel, member } = await seed();
    const first = await repository().claim({ memberId: member.id, channelId: channel.id });
    await repository().recordGrant(first.membership.id, "https://t.me/+first");
    await repository().revoke(first.membership.id);

    const again = await repository().claim({ memberId: member.id, channelId: channel.id });

    // A churned member who re-pays must be grantable again. The unique index
    // makes a second row impossible, so the existing one is reactivated — and
    // `won: true` is what tells the caller to issue a fresh link.
    expect(again.won).toBe(true);
    expect(again.membership.status).toBe("active");
    expect(again.membership.revokedAt).toBeNull();
    // The old link is cleared: it is revoked, and leaving it there would make a
    // half-finished re-grant look complete.
    expect(again.membership.inviteLink).toBeNull();
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });
});

/**
 * The unique index is this phase's entire grant-idempotency mechanism, so how
 * `claim` reaches it may not be left to a single-threaded test: a select-then-
 * insert pre-check passes every sequential assertion above and hands two workers
 * the same pair under concurrency — two invite links for one paying member.
 * Phase 2 and Phase 3 each shipped exactly that shape.
 *
 * Deterministic by construction: this inspects the SQL that reached the driver.
 */
describe("DrizzleChannelMembershipRepository.claim — the mechanism, pinned", () => {
  it("claims in ONE conditional write, not a read followed by a write", async () => {
    const { channel, member } = await seed();

    const statements: string[] = [];
    const debugClient = postgres(process.env.DATABASE_URL!, {
      max: 1,
      debug: (_connection, query) => statements.push(query),
    });
    try {
      const debugRepo = new DrizzleChannelMembershipRepository(
        drizzle(debugClient, { schema })
      );

      expect((await debugRepo.claim({ memberId: member.id, channelId: channel.id })).won).toBe(
        true
      );

      const touchingTheTable = statements.filter((query) => /channel_membership/i.test(query));
      // ONE statement on the winning path. A pre-check emits a SELECT first.
      expect(touchingTheTable).toHaveLength(1);

      const statement = touchingTheTable[0].toLowerCase();
      expect(statement).toContain("insert into");
      expect(statement).toContain("on conflict");
      // Conditional, so an ALREADY-ACTIVE row is not reactivated (and its link
      // not cleared) by a retry.
      expect(statement).toMatch(/do update set[\s\S]*where/);
      expect(statement).toContain("returning");
      expect(touchingTheTable.filter((query) => /^\s*select/i.test(query))).toHaveLength(0);
    } finally {
      await debugClient.end();
    }
  });

  it("lets the DATABASE arbitrate concurrent claims — exactly one wins", async () => {
    // SMOKE CHECK. Whether these four actually collide is up to the scheduler,
    // so a green run proves nothing on its own; the SQL-shape test above is the
    // guard. It is here because the property it states is the one that matters.
    const { channel, member } = await seed();

    const claims = await Promise.all(
      [0, 1, 2, 3].map(() => repository().claim({ memberId: member.id, channelId: channel.id }))
    );

    expect(claims.filter((claim) => claim.won)).toHaveLength(1);
    expect(await db.select().from(channelMemberships)).toHaveLength(1);
  });
});

describe("DrizzleChannelMembershipRepository.recordGrant", () => {
  it("attaches the issued link and moves updated_at", async () => {
    const { channel, member } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });

    await repository().recordGrant(membership.id, "https://t.me/+abc123");

    const [row] = await db
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.id, membership.id));
    expect(row.inviteLink).toBe("https://t.me/+abc123");
    expect(row.status).toBe("active");
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.grantedAt.getTime());
  });
});

describe("DrizzleChannelMembershipRepository.revoke", () => {
  it("marks the row revoked with a revokedAt, and reports that it did", async () => {
    const { channel, member } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });
    await repository().recordGrant(membership.id, "https://t.me/+abc123");

    expect(await repository().revoke(membership.id)).toBe(true);

    const [row] = await db
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.id, membership.id));
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it("reports false for a second revoke, so nothing double-counts it", async () => {
    const { channel, member } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });
    await repository().revoke(membership.id);

    // Conditional on the row still being active: the database decides, so two
    // concurrent revokes produce one activity_log entry, not two.
    expect(await repository().revoke(membership.id)).toBe(false);
  });
});

describe("DrizzleChannelMembershipRepository.listActiveForMemberInCommunity", () => {
  it("returns the member's active memberships with their channel, scoped to the community", async () => {
    const { community, channel, member } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });
    await repository().recordGrant(membership.id, "https://t.me/+abc123");

    const rows = await repository().listActiveForMemberInCommunity(member.id, community.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(membership.id);
    expect(rows[0].channel.id).toBe(channel.id);
    expect(rows[0].channel.platform).toBe("telegram");
    expect(rows[0].channel.externalGroupId).toBe(channel.externalGroupId);
  });

  it("excludes another community's channels — the caller is creator-scoped by community", async () => {
    const { member } = await seed();
    const other = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: other.channel.id,
    });
    await repository().recordGrant(membership.id, "https://t.me/+abc123");

    // The membership exists, but not in this community, so a creator scoped to
    // it must see nothing.
    const { community } = await seed();
    expect(await repository().listActiveForMemberInCommunity(member.id, community.id)).toEqual([]);
  });

  it("excludes revoked memberships", async () => {
    const { community, channel, member } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });
    await repository().revoke(membership.id);

    expect(await repository().listActiveForMemberInCommunity(member.id, community.id)).toEqual([]);
  });

  it("reports a malformed id as a miss rather than raising a driver error", async () => {
    // Same rule as DrizzleSubscriptionRepository.findById: these ids arrive from
    // a URL, and `uuid = 'not-a-uuid'` is SQLSTATE 22P02, which would become a
    // 500 instead of the 404 an unknown id deserves.
    expect(await repository().listActiveForMemberInCommunity("nope", "also-nope")).toEqual([]);
  });
});

/**
 * Task 7b. This is the write that makes revocation automatable: `banChatMember`
 * needs a Telegram user id, Phase 4 has none at grant time, and the only moment one
 * becomes knowable is the join — which Telegram reports along with the invite link
 * that was used. Since links are single-use per member, the link is the join key.
 */
describe("DrizzleChannelMembershipRepository.recordPlatformMemberIdByInviteLink", () => {
  /** A granted membership, i.e. one that carries a link. */
  async function granted(inviteLink: string) {
    const { channel, member, community } = await seed();
    const { membership } = await repository().claim({
      memberId: member.id,
      channelId: channel.id,
    });
    await repository().recordGrant(membership.id, inviteLink);
    return { membership, member, channel, community };
  }

  async function row(id: string) {
    const [found] = await db.select().from(channelMemberships).where(eq(channelMemberships.id, id));
    return found;
  }

  it("records the id against the membership the link belongs to", async () => {
    const link = `https://t.me/+rec-${Date.now()}`;
    const { membership } = await granted(link);

    const outcome = await repository().recordPlatformMemberIdByInviteLink({
      inviteLink: link,
      externalMemberId: "987654321",
    });

    expect(outcome).toEqual({ outcome: "recorded", membershipId: membership.id });
    expect((await row(membership.id)).externalMemberId).toBe("987654321");
  });

  it("bumps updated_at, which has no trigger behind it", async () => {
    const link = `https://t.me/+upd-${Date.now()}`;
    const { membership } = await granted(link);
    await Bun.sleep(25);

    await repository().recordPlatformMemberIdByInviteLink({
      inviteLink: link,
      externalMemberId: "987654321",
    });

    const found = await row(membership.id);
    expect(found.updatedAt.getTime()).toBeGreaterThan(found.grantedAt.getTime());
  });

  it("is idempotent: the same id twice is already_recorded, not an error", async () => {
    const link = `https://t.me/+idem-${Date.now()}`;
    const { membership } = await granted(link);
    const input = { inviteLink: link, externalMemberId: "987654321" };

    expect((await repository().recordPlatformMemberIdByInviteLink(input)).outcome).toBe("recorded");
    const after = await row(membership.id);

    expect(await repository().recordPlatformMemberIdByInviteLink(input)).toEqual({
      outcome: "already_recorded",
      membershipId: membership.id,
    });
    // Byte-identical, including updated_at: a redelivery must not even touch it.
    expect(await row(membership.id)).toEqual(after);
  });

  it("keeps the recorded id when a DIFFERENT one arrives for the same link", async () => {
    // The link is single-use, so this means our record and Telegram's disagree.
    // Overwriting would aim a later banChatMember at whichever account reported last.
    const link = `https://t.me/+conflict-${Date.now()}`;
    const { membership } = await granted(link);
    await repository().recordPlatformMemberIdByInviteLink({
      inviteLink: link,
      externalMemberId: "111",
    });

    expect(
      await repository().recordPlatformMemberIdByInviteLink({
        inviteLink: link,
        externalMemberId: "222",
      })
    ).toEqual({ outcome: "conflicting_member_id", membershipId: membership.id });
    expect((await row(membership.id)).externalMemberId).toBe("111");
  });

  it("reports an unknown link as a miss, and touches nothing", async () => {
    const { membership } = await granted(`https://t.me/+known-${Date.now()}`);

    expect(
      await repository().recordPlatformMemberIdByInviteLink({
        inviteLink: "https://t.me/+never-issued",
        externalMemberId: "987654321",
      })
    ).toEqual({ outcome: "unknown_invite_link" });
    expect((await row(membership.id)).externalMemberId).toBeNull();
  });

  it("treats an empty link or an empty member id as a miss, not a match", async () => {
    // `invite_link` is nullable so `= ''` matches nothing today — but an empty member
    // id would satisfy the `is null` predicate while being useless to banChatMember,
    // and an empty link must never be able to match a row that somehow holds one.
    const { membership } = await granted(`https://t.me/+empty-${Date.now()}`);

    expect(
      await repository().recordPlatformMemberIdByInviteLink({
        inviteLink: "",
        externalMemberId: "1",
      })
    ).toEqual({ outcome: "unknown_invite_link" });
    expect(
      await repository().recordPlatformMemberIdByInviteLink({
        inviteLink: `https://t.me/+empty-${Date.now()}`,
        externalMemberId: "",
      })
    ).toEqual({ outcome: "unknown_invite_link" });
    expect((await row(membership.id)).externalMemberId).toBeNull();
  });

  it("lets exactly ONE of several concurrent updates record the id", async () => {
    // Telegram can redeliver an update before the first delivery has finished, so
    // the conditional UPDATE — not a preceding read — has to arbitrate.
    const link = `https://t.me/+race-${Date.now()}`;
    const { membership } = await granted(link);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repository().recordPlatformMemberIdByInviteLink({
          inviteLink: link,
          externalMemberId: String(100 + i),
        })
      )
    );

    expect(outcomes.filter((o) => o.outcome === "recorded")).toHaveLength(1);
    const winner = outcomes.findIndex((o) => o.outcome === "recorded");
    expect((await row(membership.id)).externalMemberId).toBe(String(100 + winner));
  });

  it("finds nothing once the membership has been revoked", async () => {
    // `revoke` nulls the link — it is a bearer credential and a revoked row must not
    // keep one — so a late join update for it is simply unknown.
    const link = `https://t.me/+revoked-${Date.now()}`;
    const { membership } = await granted(link);
    await repository().revoke(membership.id);

    expect(
      await repository().recordPlatformMemberIdByInviteLink({
        inviteLink: link,
        externalMemberId: "987654321",
      })
    ).toEqual({ outcome: "unknown_invite_link" });
  });

  it("keeps the recorded id across a revoke and a re-grant, so a re-payer can be unbanned", async () => {
    // `claim`'s reactivation clears the LINK but deliberately leaves
    // `external_member_id`: TelegramBotAdapter needs it to `unbanChatMember` before
    // a churned member who re-pays can use a new link at all.
    const link = `https://t.me/+regrant-${Date.now()}`;
    const { membership, member, channel } = await granted(link);
    await repository().recordPlatformMemberIdByInviteLink({
      inviteLink: link,
      externalMemberId: "987654321",
    });
    await repository().revoke(membership.id);

    const reclaimed = await repository().claim({ memberId: member.id, channelId: channel.id });

    expect(reclaimed.won).toBe(true);
    expect(reclaimed.membership.inviteLink).toBeNull();
    expect(reclaimed.membership.externalMemberId).toBe("987654321");
  });
});

describe("channel_membership_invite_link_unique", () => {
  it("refuses two memberships carrying the same invite link", async () => {
    // The link is the lookup key for recording a platform member id, and ambiguity
    // in a lookup keyed on a CREDENTIAL would attach a Telegram user id to an
    // arbitrary one of two rows.
    const link = `https://t.me/+dup-${Date.now()}`;
    const first = await seed();
    const second = await seed();
    const a = await repository().claim({
      memberId: first.member.id,
      channelId: first.channel.id,
    });
    const b = await repository().claim({
      memberId: second.member.id,
      channelId: second.channel.id,
    });
    await repository().recordGrant(a.membership.id, link);

    let violation: { constraint_name?: string } | undefined;
    try {
      await repository().recordGrant(b.membership.id, link);
    } catch (err) {
      violation = (err as { cause?: { constraint_name?: string } }).cause;
    }

    expect(violation?.constraint_name).toBe("channel_membership_invite_link_unique");
  });

  it("permits many rows with NO link — it is partial on purpose", async () => {
    // The column is null until a grant completes and null again after a revoke, so
    // a total unique index would make the second unrevoked membership impossible.
    const first = await seed();
    const second = await seed();
    await repository().claim({ memberId: first.member.id, channelId: first.channel.id });
    await repository().claim({ memberId: second.member.id, channelId: second.channel.id });

    const rows = await db.select().from(channelMemberships);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.inviteLink === null)).toBe(true);
  });
});
