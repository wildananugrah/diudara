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
   * The member's id ON THE PLATFORM (a Telegram integer user id), or `null` until
   * the member actually JOINS — access is granted with an invite link precisely
   * because checkout only ever knows a WhatsApp number, so no id can exist at grant
   * time. `recordPlatformMemberIdByInviteLink` below is what fills it, from
   * Telegram's `chat_member` update.
   *
   * Revocation needs it (`banChatMember` addresses a user id): while it is null,
   * `RevokeChannelAccess` reports "not automated" rather than claiming a removal it
   * could not perform. See the column comment in db/schema.ts, including why it
   * deliberately survives a revoke.
   */
  externalMemberId: string | null;
  /**
   * When a caller entered the mint window, or `null` when nobody is in it. See the
   * column comment in db/schema.ts for the invariant this enforces: `inviteLink`
   * null WITH this set means a link was minted and lost, and no replacement may be
   * minted.
   */
  linkMintedAt: Date | null;
  /** How long the caller in the mint window holds it. See db/schema.ts. */
  mintLeaseUntil: Date | null;
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

/**
 * What a claim decided, and the ONLY thing that authorises a provider call.
 *
 * This replaced `{ won: boolean }`, which could not express the difference between
 * the three states that all look like "claimed, no link":
 *
 *   - nobody has minted yet                  -> mint
 *   - somebody is minting right now          -> mint_in_progress
 *   - somebody minted and could not record it -> mint_lost
 *
 * `won: false` with a null link meant "finish that grant" for all three, so a
 * failing `recordGrant` re-minted on every bounded retry (five live links behind one
 * row) and two concurrent callers minted one each. Both were measured. An invite
 * link is a bearer credential and Telegram cannot enumerate the ones it minted, so a
 * link whose value we lost can never be revoked: the states have to be distinct, and
 * the two that are not provably safe have to fail closed.
 */
export type ChannelMembershipClaim =
  /**
   * THIS caller holds the mint window and must issue exactly one link: the row did
   * not exist, or it was `revoked` and has been reactivated, or it was claimed with
   * no mint ever started. `linkMintedAt` and `mintLeaseUntil` are set, in the same
   * statement, before this is returned.
   */
  | { outcome: "mint"; membership: ChannelMembershipRecord }
  /** An active membership already carries a link. No provider call. */
  | { outcome: "already_granted"; membership: ChannelMembershipRecord }
  /**
   * Another caller holds a LIVE mint lease. The caller must report this and retry
   * later — by then the winner has recorded its link and the retry sees
   * `already_granted`, so the member is told with the link that actually works.
   */
  | { outcome: "mint_in_progress"; membership: ChannelMembershipRecord }
  /**
   * A link was minted and never recorded, and the lease has lapsed. There may be a
   * live credential at the provider whose value nobody holds. NO replacement may be
   * minted; the caller reports it for a deliberate reissue.
   */
  | { outcome: "mint_lost"; membership: ChannelMembershipRecord };

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
  /**
   * See `ChannelMembershipClaim`. Never throws on a losing claim.
   *
   * `outcome: "mint"` is a GRANT OF PERMISSION to call the provider, and the mint
   * marker plus the lease must be written in the SAME statement that decides it.
   * Two callers that both read "no mint in progress" and then both wrote the marker
   * would each mint a link — the TOCTOU this whole type exists to remove.
   */
  claim(input: { memberId: string; channelId: string }): Promise<ChannelMembershipClaim>;
  /**
   * Records the link the provider issued against an already-claimed row, and closes
   * the mint window.
   *
   * Returns FALSE when the row no longer accepts a link — it already carries one, or
   * it is not the row we claimed. That is not a formality: it is the last guard
   * against writing an orphan over a link that already reached a member. A caller
   * that gets `false` is holding a credential the database will not accept, so it
   * MUST revoke that link at the provider rather than dropping it.
   */
  recordGrant(membershipId: string, inviteLink: string): Promise<boolean>;
  /**
   * Reopens the mint window after a lost link was successfully KILLED at the
   * provider: clears `link_minted_at` and `mint_lease_until` so a retry may mint
   * again.
   *
   * Only ever legitimate once `revokeInviteLink` has SUCCEEDED. Calling it after a
   * failed revoke would clear the one marker that stops a replacement being minted
   * on top of a live orphan — the exact leak the marker exists to prevent.
   *
   * Conditional on `invite_link IS NULL`, so it cannot reopen a finished grant.
   */
  releaseMintWindow(membershipId: string): Promise<void>;
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
   *
   * `externalGroupId` is matched TOO, not just carried for diagnostics: the
   * membership must belong to the chat the update actually came from. The link alone
   * is unique, so this changes nothing on the happy path — it is defence in depth on
   * the write that decides who `banChatMember` will be aimed at, and this is the one
   * write in the codebase an attacker-controlled body reaches.
   */
  recordPlatformMemberIdByInviteLink(input: {
    inviteLink: string;
    externalGroupId: string;
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
  /**
   * ONE membership by id, with its channel, WHATEVER its status.
   *
   * Exists for the `revoke_access` outbox handler, which retries a platform removal
   * that failed. Every other read here is scoped to ACTIVE memberships, and the row
   * this handler needs has already been moved to `revoked` — the entitlement is gone,
   * the person is still in the group. Not creator-scoped because the caller is a
   * worker acting on a row the creator already authorised.
   *
   * A value that cannot be a uuid is a MISS (`null`), for the same reason as
   * everywhere else: it can arrive from a stale outbox payload.
   */
  findByIdWithChannel(membershipId: string): Promise<ChannelMembershipWithChannel | null>;
}
