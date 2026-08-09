import { safeLabel } from "../log-safety";
import type {
  ChannelMembershipRepositoryPort,
  RecordPlatformMemberIdOutcome,
} from "../ports/channel-membership-repository.port";

export interface RecordChannelJoinInput {
  /** `channel.platform` this update came from — `"telegram"` today. */
  platform: string;
  /** The platform's own id for the group, for diagnostics only. */
  externalGroupId: string;
  /** The member's id ON THE PLATFORM. What `banChatMember` addresses. */
  externalMemberId: string;
  /**
   * The single-use invite link the member used. THE JOIN KEY, and a bearer
   * credential: this use-case may pass it to the repository as a lookup value and
   * must never log it, return it, or put it in an error.
   */
  inviteLink: string;
}

export type RecordChannelJoinResult = RecordPlatformMemberIdOutcome;

/**
 * Attaches a joining member's platform user id to the membership whose invite link
 * they used — the piece that makes `RevokeChannelAccess` able to act.
 *
 * Why this exists at all: `banChatMember` needs a Telegram integer user id, and
 * Phase 4 grants access with an INVITE LINK precisely because it has none — all
 * checkout knows is a WhatsApp number. So `channel_membership.external_member_id`
 * was NULL for every row, and revocation could only ever report
 * `no_provider_member_id_recorded`. That left the PRD's #2 validated problem ("no
 * systematic way to handle members who stop paying") unsolved, and would have
 * handed Phase 5's churn detection a revoke that cannot remove anybody.
 *
 * The link is the join key because Phase 4 issues a single-use link PER MEMBER
 * (`member_limit: 1`), so it identifies exactly one membership row.
 *
 * Three rules:
 *
 *  1. THE DATABASE ARBITRATES. One conditional UPDATE predicated on
 *     `external_member_id is null`; the read that follows only classifies what the
 *     conflict was. Telegram redelivers updates, so a pre-check would be a TOCTOU.
 *  2. NOTHING IS AN ERROR. An unknown link, a redelivery, a conflicting id — all
 *     are reported, none throws. The caller is a webhook Telegram retries until it
 *     gets a 2xx, and none of these becomes valid on a retry.
 *  3. THE LINK NEVER APPEARS IN A LOG LINE. Not even truncated, not even hashed.
 *     Every diagnostic below names OUR ids (membership, channel) plus the group id,
 *     which is the creator's own group and not member data.
 */
export class RecordChannelJoin {
  constructor(private readonly memberships: ChannelMembershipRepositoryPort) {}

  async execute(input: RecordChannelJoinInput): Promise<RecordChannelJoinResult> {
    const outcome = await this.memberships.recordPlatformMemberIdByInviteLink({
      inviteLink: input.inviteLink,
      externalMemberId: input.externalMemberId,
    });

    if (outcome.outcome === "unknown_invite_link") {
      // Ordinary and not a problem: a member joining a group we do not gate, a link
      // from a previous deploy, or one revoked with its membership (`revoke` nulls
      // the column). Ignored, and the LINK IS NOT LOGGED — only the group it was
      // used on, so an operator can tell which community it concerns.
      console.warn(
        `[gating] telegram join for an invite link we do not recognise: ` +
          `platform=${safeLabel(input.platform)} group=${safeLabel(input.externalGroupId)} — ` +
          "ignored (the link is deliberately not logged: it is a bearer credential)"
      );
      return outcome;
    }

    if (outcome.outcome === "conflicting_member_id") {
      // The link is single-use, so two different users cannot both have used it.
      // Our record and the platform's disagree, and the recorded id is left alone:
      // overwriting it would aim `banChatMember` at whichever account reported last.
      console.warn(
        `[gating] telegram join reports a different member id than the one recorded: ` +
          `platform=${safeLabel(input.platform)} membership=${outcome.membershipId} ` +
          `group=${safeLabel(input.externalGroupId)} — the recorded id was KEPT, and this ` +
          "membership should be checked by hand before it is revoked"
      );
    }

    return outcome;
  }
}
