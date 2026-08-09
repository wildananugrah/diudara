/** A row of `channel_membership`: who currently has access to which channel. */
export interface ChannelMembershipRecord {
  id: string;
  memberId: string;
  channelId: string;
  status: string;
  /**
   * The invite link issued to this member for this channel, or `null` when no
   * grant has completed yet.
   *
   * A BEARER CREDENTIAL (plan, Global Constraints). It may reach the member who
   * bought it and nothing else: never a log line, never an error message, never
   * an API response. It lives here so a retried outbox row can tell "already
   * granted" from "claimed but never finished" without asking the provider.
   */
  inviteLink: string | null;
  /**
   * The member's id ON THE PLATFORM (a Telegram integer user id), or `null` when
   * we never learned it — which is the ordinary case in Phase 4, because access
   * is granted with an invite link and checkout only ever knows a WhatsApp
   * number. Revocation needs it (`banChatMember` addresses a user id), so
   * `RevokeChannelAccess` reports "not automated" rather than claiming a removal
   * it could not perform. See the column comment in db/schema.ts.
   */
  externalMemberId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  updatedAt: Date;
}

/** A membership together with the channel it is for — one query, not two. */
export interface ChannelMembershipWithChannel extends ChannelMembershipRecord {
  channel: {
    id: string;
    communityId: string;
    platform: string;
    externalGroupId: string | null;
  };
}

export interface ChannelMembershipClaim {
  /**
   * True when THIS caller is the one that must issue an invite link: either the
   * row did not exist, or it existed as `revoked` and has been reactivated.
   * False when another caller already holds an active membership — which is how
   * a retried outbox row learns not to mint a second credential.
   *
   * `won: false` with `membership.inviteLink === null` is a THIRD case, and a
   * real one: a previous attempt claimed the row and then died before the
   * provider returned. The caller must finish that grant, or the member never
   * gets a link.
   */
  won: boolean;
  membership: ChannelMembershipRecord;
}

/**
 * The result of attaching a platform member id to the membership its invite link
 * belongs to. Exported so the caller can branch without matching prose.
 *
 * All four cases must be reachable without an exception: the caller is an inbound
 * webhook that Telegram RETRIES until it gets a 2xx, and none of the not-recorded
 * cases becomes valid on a retry.
 */
export type RecordPlatformMemberIdOutcome =
  /** The column was empty and this call filled it. */
  | { outcome: "recorded"; membershipId: string }
  /** Already held exactly this id. The idempotent case — a redelivered update. */
  | { outcome: "already_recorded"; membershipId: string }
  /**
   * Already held a DIFFERENT id, and was left alone. The link is single-use, so
   * this should be impossible; if it happens our record and the platform's
   * disagree, and overwriting would point `banChatMember` at whichever account
   * reported last.
   */
  | { outcome: "conflicting_member_id"; membershipId: string }
  /** No membership carries this link. Nothing to do — see the port method. */
  | { outcome: "unknown_invite_link" };

/**
 * `channel_membership` is UNIQUE on `(member_id, channel_id)`, and that index is
 * this phase's ENTIRE grant-idempotency mechanism (plan, Global Constraints).
 *
 * `claim` must therefore be a single conditional write whose outcome the database
 * decides — never a read followed by a write. The stake is specific: an invite
 * link is a bearer credential, so a second "successful" grant for the same pair
 * hands out a second link that could be forwarded to someone who never paid.
 * Phase 2 and Phase 3 each shipped a TOCTOU from a pre-check; this must not be
 * the fourth.
 */
export interface ChannelMembershipRepositoryPort {
  /** See `ChannelMembershipClaim`. Never throws on a losing claim. */
  claim(input: { memberId: string; channelId: string }): Promise<ChannelMembershipClaim>;
  /** Records the link the provider issued against an already-claimed row. */
  recordGrant(membershipId: string, inviteLink: string): Promise<void>;
  /**
   * Attaches the member's id ON THE PLATFORM to the membership whose invite link
   * this is — the write that makes revocation automatable at all.
   *
   * The invite link is the join key, and it works because Phase 4 issues a
   * SINGLE-USE link per member: `banChatMember` needs a Telegram user id, and the
   * only moment one becomes knowable is when the member joins, which Telegram
   * reports along with the link they used.
   *
   * IDEMPOTENT, and the DATABASE decides — a single conditional UPDATE predicated
   * on `external_member_id is null`, then a read only to CLASSIFY what the
   * conflict was. A pre-check would be a TOCTOU, and the caller is a webhook that
   * gets redelivered.
   *
   * `inviteLink` is a bearer credential: it may be used as a lookup key and
   * nothing else. Never return it, never log it, never put it in an error.
   */
  recordPlatformMemberIdByInviteLink(input: {
    inviteLink: string;
    externalMemberId: string;
  }): Promise<RecordPlatformMemberIdOutcome>;
  /**
   * Marks an ACTIVE membership `revoked` with `revoked_at` set, and reports
   * whether this call is the one that did it. Conditional on the current status,
   * so two concurrent revocations produce one state change and one audit entry.
   */
  revoke(membershipId: string): Promise<boolean>;
  /**
   * The member's active memberships within ONE community, each with its channel.
   * Community-scoped because every authenticated caller is: a creator may only
   * act on their own community's channels.
   *
   * Ids that cannot be uuids are a MISS (`[]`), not a driver error — they arrive
   * from a URL, and SQLSTATE 22P02 would become a 500 instead of a 404.
   */
  listActiveForMemberInCommunity(
    memberId: string,
    communityId: string
  ): Promise<ChannelMembershipWithChannel[]>;
}
