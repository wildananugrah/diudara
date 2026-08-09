import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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

/**
 * How long a caller holds the mint window.
 *
 * It must comfortably exceed one `grantAccess`, which is up to TWO Telegram calls
 * (`unbanChatMember` then `createChatInviteLink`) at a 15s adapter timeout each,
 * plus the `recordGrant` write. 60s covers that with room to spare.
 *
 * Erring long is the safe direction. A lease that outlives its holder delays a
 * legitimate retry by up to a minute; a lease that expires UNDER its holder makes the
 * next caller report `mint_lost` and ask for a manual reissue. Neither mints a second
 * credential — that is the property the lease exists for, and it does not depend on
 * this number being well tuned.
 */
const DEFAULT_MINT_LEASE_SECONDS = 60;

export class DrizzleChannelMembershipRepository implements ChannelMembershipRepositoryPort {
  private readonly mintLeaseSeconds: number;

  constructor(
    private readonly db: DatabaseExecutor,
    /**
     * `mintLeaseSeconds` is overridable for ONE reason: the lapsed-lease branch
     * (`mint_lost`) is a real production state that a test cannot otherwise reach
     * without sleeping for the default minute. Nothing in the application passes it.
     */
    config: { mintLeaseSeconds?: number } = {}
  ) {
    this.mintLeaseSeconds = config.mintLeaseSeconds ?? DEFAULT_MINT_LEASE_SECONDS;
  }

  /**
   * ONE conditional write, arbitrated by `channel_membership_member_channel_unique`,
   * that both claims the membership AND takes the mint window.
   *
   * The `DO UPDATE ... WHERE` predicate is the whole design:
   *
   *     status <> 'active'  OR  (invite_link is null AND link_minted_at is null)
   *
   *   - no row yet                     -> the INSERT wins     -> `mint`
   *   - a REVOKED row exists           -> the DO UPDATE fires -> `mint` (reactivated)
   *   - ACTIVE, no link, no marker     -> the DO UPDATE fires -> `mint` (takes over)
   *   - ACTIVE with a link             -> excluded, returns nothing
   *   - ACTIVE, no link, marker SET    -> excluded, returns nothing
   *
   * RETURNING A ROW IS THE PERMISSION TO MINT, and it comes with `link_minted_at` and
   * `mint_lease_until` already written — in this statement, not a following one.
   * That atomicity is the fix for the measured leak: two callers that each read "no
   * mint in progress" and then each wrote the marker both minted a link (two live
   * credentials for one member). Here the second one's DO UPDATE finds
   * `link_minted_at` non-null — Postgres re-evaluates the predicate against the
   * locked, updated tuple — so it returns nothing and is classified below.
   *
   * The two excluded cases are then told apart by a read, which is safe because it
   * happens AFTER a write that already lost:
   *
   *   - a link          -> `already_granted`
   *   - marker + live lease   -> `mint_in_progress` (retry; the winner is mid-flight)
   *   - marker + lapsed lease -> `mint_lost` (a credential may be live and unrecorded)
   *
   * `mint_lost` FAILS CLOSED, and that is deliberate: Telegram's
   * `revokeChatInviteLink` takes the link's VALUE and no Bot API method enumerates a
   * bot's links, so a link we minted and did not record can never be killed. Minting
   * a replacement would add a second live credential to an unkillable first one. A
   * caller that crashed between this statement and the provider call is caught by the
   * same branch and reported as manual — a spurious manual reissue is the correct
   * price for never leaking a second key.
   *
   * Reactivation clears `invite_link` and `revoked_at` and resets `granted_at`:
   * the old link was revoked with the membership, and leaving it in place would
   * make an unfinished re-grant look finished.
   */
  async claim(input: {
    memberId: string;
    channelId: string;
  }): Promise<ChannelMembershipClaim> {
    // `sql.raw` on a NUMBER this class owns — never on caller input. Postgres will
    // not accept a bound parameter as an interval qualifier.
    const leaseUntil = sql`now() + ${sql.raw(
      `interval '${Number(this.mintLeaseSeconds)} seconds'`
    )}`;
    const [claimed] = await this.db
      .insert(channelMemberships)
      .values({
        memberId: input.memberId,
        channelId: input.channelId,
        linkMintedAt: sql`now()`,
        mintLeaseUntil: leaseUntil,
      })
      .onConflictDoUpdate({
        target: [channelMemberships.memberId, channelMemberships.channelId],
        set: {
          status: ACTIVE,
          inviteLink: null,
          revokedAt: null,
          grantedAt: sql`now()`,
          updatedAt: sql`now()`,
          linkMintedAt: sql`now()`,
          mintLeaseUntil: leaseUntil,
        },
        setWhere: or(
          ne(channelMemberships.status, ACTIVE),
          and(
            isNull(channelMemberships.inviteLink),
            isNull(channelMemberships.linkMintedAt)
          )
        ),
      })
      .returning();

    if (claimed) {
      return { outcome: "mint", membership: claimed };
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
      // reporting `mint` here would issue a second link.
      throw new Error(
        "channel membership claim conflicted but the conflicting row could not be read " +
          `(member=${input.memberId} channel=${input.channelId})`
      );
    }

    if (existing.inviteLink !== null) {
      return { outcome: "already_granted", membership: existing };
    }

    // No link and the DO UPDATE was excluded, so the marker is set. `?? true` for
    // the impossible null lease: it resolves to "in progress", which retries — the
    // safe direction, since the alternative reports a lost credential that may not
    // exist.
    const leaseIsLive =
      existing.mintLeaseUntil === null ? true : existing.mintLeaseUntil.getTime() > Date.now();
    return leaseIsLive
      ? { outcome: "mint_in_progress", membership: existing }
      : { outcome: "mint_lost", membership: existing };
  }

  /**
   * Closes the mint window by recording the link, and refuses to overwrite one.
   *
   * `invite_link is null` in the predicate is what makes the refusal real. Without
   * it, two callers that both minted (before the lease existed) both recorded, and
   * the second silently ORPHANED the first's link — a live credential, already
   * delivered to the member, that no longer appeared in any row. The caller turns a
   * `false` here into a provider-side revoke of the link it is holding.
   */
  async recordGrant(membershipId: string, inviteLink: string): Promise<boolean> {
    const recorded = await this.db
      .update(channelMemberships)
      .set({
        inviteLink,
        status: ACTIVE,
        // The window is closed: the credential is recorded, so it is revocable.
        linkMintedAt: null,
        mintLeaseUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(channelMemberships.id, membershipId), isNull(channelMemberships.inviteLink))
      )
      .returning({ id: channelMemberships.id });
    return recorded.length > 0;
  }

  /** See the port docstring — only ever after a SUCCESSFUL provider-side revoke. */
  async releaseMintWindow(membershipId: string): Promise<void> {
    await this.db
      .update(channelMemberships)
      .set({ linkMintedAt: null, mintLeaseUntil: null, updatedAt: new Date() })
      .where(
        and(eq(channelMemberships.id, membershipId), isNull(channelMemberships.inviteLink))
      );
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
    externalGroupId: string;
    externalMemberId: string;
  }): Promise<RecordPlatformMemberIdOutcome> {
    if (
      input.inviteLink.length === 0 ||
      input.externalMemberId.length === 0 ||
      input.externalGroupId.length === 0
    ) {
      return { outcome: "unknown_invite_link" };
    }

    // The membership must belong to the chat the update came FROM, not merely carry
    // the link it quotes. Defence in depth on the write that decides who
    // `banChatMember` targets: the link alone is a single unique key, so a bug or a
    // forged update that got a real link from another community would otherwise
    // write an attacker-chosen member id onto that community's membership. Cheap —
    // it is an index lookup on a column the join needs anyway.
    const membershipsInChat = inArray(
      channelMemberships.channelId,
      this.db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.externalGroupId, input.externalGroupId))
    );

    const [claimed] = await this.db
      .update(channelMemberships)
      .set({ externalMemberId: input.externalMemberId, updatedAt: new Date() })
      .where(
        and(
          eq(channelMemberships.inviteLink, input.inviteLink),
          membershipsInChat,
          isNull(channelMemberships.externalMemberId)
        )
      )
      .returning({ id: channelMemberships.id });
    if (claimed) {
      return { outcome: "recorded", membershipId: claimed.id };
    }

    // Either no row carries this link IN THIS CHAT, or one does and already has an
    // id. Only a read can tell them apart, and it is safe to do it AFTER the write:
    // the write already lost, so nothing it learns can change what was written.
    const [existing] = await this.db
      .select({
        id: channelMemberships.id,
        externalMemberId: channelMemberships.externalMemberId,
      })
      .from(channelMemberships)
      .where(and(eq(channelMemberships.inviteLink, input.inviteLink), membershipsInChat))
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

  /** See the port docstring: any status, by id, for the revoke retry handler. */
  async findByIdWithChannel(membershipId: string): Promise<ChannelMembershipWithChannel | null> {
    if (!UUID_PATTERN.test(membershipId)) {
      return null;
    }
    const [row] = await this.db
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
      .where(eq(channelMemberships.id, membershipId))
      .limit(1);
    return row ? { ...row.membership, channel: row.channel } : null;
  }
}
