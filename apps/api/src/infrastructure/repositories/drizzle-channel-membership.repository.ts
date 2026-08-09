import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { channelMemberships, channels } from "../../db/schema";
import type {
  ChannelMembershipClaim,
  ChannelMembershipRecord,
  ChannelMembershipRepositoryPort,
  ChannelMembershipWithChannel,
  RecordPlatformMemberIdOutcome,
} from "../../application/ports/channel-membership-repository.port";

/** Same guard, and the same reason, as `DrizzleSubscriptionRepository`. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIVE = "active";
const REVOKED = "revoked";

export class DrizzleChannelMembershipRepository implements ChannelMembershipRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * ONE conditional write, arbitrated by `channel_membership_member_channel_unique`.
   *
   * The `DO UPDATE ... WHERE status <> 'active'` is the whole design:
   *
   *   - no row yet            -> the INSERT wins        -> `won: true`
   *   - a REVOKED row exists  -> the DO UPDATE fires    -> `won: true` (reactivated)
   *   - an ACTIVE row exists  -> the WHERE excludes it  -> no row returned
   *
   * That third case is the one that matters: it returns nothing, so we read the
   * existing row and report `won: false`, and the caller does NOT issue a second
   * invite link. An unconditional DO UPDATE would instead clear a live
   * membership's link on every retry, and a pre-check ("does a row exist?") would
   * be a TOCTOU — two workers reading "no" at the same instant both mint a
   * credential.
   *
   * Reactivation clears `invite_link` and `revoked_at` and resets `granted_at`:
   * the old link was revoked with the membership, and leaving it in place would
   * make an unfinished re-grant look finished.
   */
  async claim(input: {
    memberId: string;
    channelId: string;
  }): Promise<ChannelMembershipClaim> {
    const [claimed] = await this.db
      .insert(channelMemberships)
      .values({ memberId: input.memberId, channelId: input.channelId })
      .onConflictDoUpdate({
        target: [channelMemberships.memberId, channelMemberships.channelId],
        set: {
          status: ACTIVE,
          inviteLink: null,
          revokedAt: null,
          grantedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
        setWhere: ne(channelMemberships.status, ACTIVE),
      })
      .returning();

    if (claimed) {
      return { won: true, membership: claimed };
    }

    const [existing] = await this.db
      .select()
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.memberId, input.memberId),
          eq(channelMemberships.channelId, input.channelId)
        )
      )
      .limit(1);
    if (!existing) {
      // The conflict fired, so a row was there a moment ago. Nothing in this
      // codebase deletes memberships, so this is unreachable — and silently
      // reporting `won: true` here would issue a second link.
      throw new Error(
        "channel membership claim conflicted but the conflicting row could not be read " +
          `(member=${input.memberId} channel=${input.channelId})`
      );
    }
    return { won: false, membership: existing };
  }

  async recordGrant(membershipId: string, inviteLink: string): Promise<void> {
    await this.db
      .update(channelMemberships)
      .set({ inviteLink, status: ACTIVE, updatedAt: new Date() })
      .where(eq(channelMemberships.id, membershipId));
  }

  /**
   * ONE conditional UPDATE, then a read only to classify the conflict — see the
   * port docstring. `external_member_id is null` in the predicate is what makes
   * this idempotent under Telegram's redelivery without a pre-check.
   *
   * The empty-string guards matter: `invite_link` is nullable, so `= ''` would
   * normally match nothing, but a row that somehow carried `''` would otherwise be
   * matched by a caller sending no link at all. And an empty
   * `external_member_id` would satisfy the "recorded" predicate while being
   * useless to `banChatMember`.
   */
  async recordPlatformMemberIdByInviteLink(input: {
    inviteLink: string;
    externalMemberId: string;
  }): Promise<RecordPlatformMemberIdOutcome> {
    if (input.inviteLink.length === 0 || input.externalMemberId.length === 0) {
      return { outcome: "unknown_invite_link" };
    }

    const [claimed] = await this.db
      .update(channelMemberships)
      .set({ externalMemberId: input.externalMemberId, updatedAt: new Date() })
      .where(
        and(
          eq(channelMemberships.inviteLink, input.inviteLink),
          isNull(channelMemberships.externalMemberId)
        )
      )
      .returning({ id: channelMemberships.id });
    if (claimed) {
      return { outcome: "recorded", membershipId: claimed.id };
    }

    // Either no row carries this link, or one does and already has an id. Only a
    // read can tell them apart, and it is safe to do it AFTER the write: the write
    // already lost, so nothing it learns can change what was written.
    const [existing] = await this.db
      .select({
        id: channelMemberships.id,
        externalMemberId: channelMemberships.externalMemberId,
      })
      .from(channelMemberships)
      .where(eq(channelMemberships.inviteLink, input.inviteLink))
      .limit(1);
    if (!existing) {
      return { outcome: "unknown_invite_link" };
    }
    return existing.externalMemberId === input.externalMemberId
      ? { outcome: "already_recorded", membershipId: existing.id }
      : { outcome: "conflicting_member_id", membershipId: existing.id };
  }

  /** Conditional on the row still being active — see the port docstring. */
  async revoke(membershipId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(membershipId)) {
      return false;
    }
    const revoked = await this.db
      .update(channelMemberships)
      .set({
        status: REVOKED,
        revokedAt: new Date(),
        updatedAt: new Date(),
        // The link dies with the membership. Keeping it would leave a live
        // bearer credential on a row that says access was removed.
        inviteLink: null,
      })
      .where(
        and(eq(channelMemberships.id, membershipId), eq(channelMemberships.status, ACTIVE))
      )
      .returning({ id: channelMemberships.id });
    return revoked.length > 0;
  }

  async listActiveForMemberInCommunity(
    memberId: string,
    communityId: string
  ): Promise<ChannelMembershipWithChannel[]> {
    if (!UUID_PATTERN.test(memberId) || !UUID_PATTERN.test(communityId)) {
      return [];
    }
    const rows = await this.db
      .select({
        membership: channelMemberships,
        channel: {
          id: channels.id,
          communityId: channels.communityId,
          platform: channels.platform,
          externalGroupId: channels.externalGroupId,
        },
      })
      .from(channelMemberships)
      .innerJoin(channels, eq(channelMemberships.channelId, channels.id))
      .where(
        and(
          eq(channelMemberships.memberId, memberId),
          eq(channels.communityId, communityId),
          eq(channelMemberships.status, ACTIVE)
        )
      );

    return rows.map((row) => ({ ...row.membership, channel: row.channel }));
  }
}
