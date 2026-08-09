import { NotFoundError } from "../errors";
import { redactLinks, safeLabel } from "../log-safety";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type {
  ChannelMembershipRepositoryPort,
  ChannelMembershipWithChannel,
} from "../ports/channel-membership-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";

/**
 * Why a channel's removal could not be performed for us. Exported so a caller can
 * branch on it without matching prose, and so the strings are the same in the API
 * response and in `activity_log`.
 */
export type RevokeNotAutomatedReason =
  /** WhatsApp: it cannot remove anyone from a group (spec §2.1). */
  | "provider_cannot_gate_access"
  /** No adapter is wired for this channel's platform in this deployment. */
  | "no_provider_for_platform"
  /** We never learned the member's id on the platform — see the schema comment. */
  | "no_provider_member_id_recorded"
  /** The provider was called and refused or failed. */
  | "provider_error";

export interface RevokedChannel {
  channelId: string;
  platform: string;
  /** True only when the provider actually removed the member from the group. */
  automated: boolean;
  reason?: RevokeNotAutomatedReason;
}

export interface RevokeChannelAccessResult {
  /** Memberships moved to `revoked`. */
  revoked: number;
  /**
   * True only when EVERY revoked channel was handled by its provider. False means
   * the creator has to remove the member from at least one group by hand, and the
   * per-channel `reason` says which and why.
   */
  automated: boolean;
  channels: RevokedChannel[];
}

export interface RevokeChannelAccessInput {
  communityId: string;
  creatorId: string;
  memberId: string;
}

/**
 * Removes a member's access to a community's channels.
 *
 * SYNCHRONOUS, not outboxed, unlike granting: a creator clicking "remove" expects
 * to be told whether it worked, and there is no transaction whose atomicity an
 * external call could threaten. Nothing in here touches HTTP — Phase 5's churn
 * detection calls the same `execute` with the three ids it already has.
 *
 * Two decisions are worth stating, because both could have gone the other way:
 *
 *  1. THE MEMBERSHIP ROW IS ALWAYS REVOKED when the caller owns the community,
 *     even if the provider could not be called. The row records the ENTITLEMENT,
 *     and the creator has withdrawn it; leaving it `active` because Telegram was
 *     unreachable would mean the creator cannot revoke at all, and Phase 5's churn
 *     job would retry the same member forever.
 *  2. IT NEVER CLAIMS A REMOVAL IT DID NOT PERFORM. `automated: false` plus a
 *     reason is the honest answer, and it is in the result, in the audit trail,
 *     and (via the route) in the response the creator reads. The alternative — a
 *     bare "revoked" — leaves a removed member sitting in the group while the
 *     creator believes they are gone.
 */
export class RevokeChannelAccess {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly memberships: ChannelMembershipRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    private readonly providers: ReadonlyMap<string, MessagingProviderPort>
  ) {}

  async execute(input: RevokeChannelAccessInput): Promise<RevokeChannelAccessResult> {
    // Creator-scoped, and 404 rather than 403: a stranger must not be able to
    // tell an existing community from one that never existed.
    const community = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!community) {
      throw new NotFoundError("community not found");
    }

    const active = await this.memberships.listActiveForMemberInCommunity(
      input.memberId,
      input.communityId
    );
    if (active.length === 0) {
      // Nothing to revoke. 404 rather than a 200 saying "revoked 0", so a
      // creator acting on a stale dashboard is told, and so a second click is
      // not reported as a second removal.
      throw new NotFoundError("member has no active access to this community");
    }

    const channels: RevokedChannel[] = [];
    let revoked = 0;

    for (const membership of active) {
      // The provider first, our record second. If the provider removal fails we
      // still revoke — see the class docstring — but attempting it before the
      // status change means the `externalMemberId` we pass came from a row that
      // was still active.
      const outcome = await this.removeFromProvider(membership);

      const stateChanged = await this.memberships.revoke(membership.id);
      if (!stateChanged) {
        // Something else revoked it between the read and here. Not an error, and
        // deliberately NOT counted or audited: whoever won wrote the entry.
        continue;
      }
      revoked += 1;

      channels.push({
        channelId: membership.channel.id,
        platform: membership.channel.platform,
        ...outcome,
      });

      await this.activityLog.record({
        memberId: input.memberId,
        communityId: input.communityId,
        eventType: "channel_access_revoked",
        // Ids, platform names and the reason. Never the invite link — it is a
        // bearer credential, and this table is read by dashboards.
        metadata: {
          channelId: membership.channel.id,
          platform: membership.channel.platform,
          automated: outcome.automated,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        },
      });
    }

    return {
      revoked,
      automated: channels.length > 0 && channels.every((channel) => channel.automated),
      channels,
    };
  }

  /**
   * Attempts the platform-side removal, turning every way it can fail into a
   * reason rather than a throw. The caller withdraws the entitlement either way,
   * so a throw here would only lose the reason.
   */
  private async removeFromProvider(
    membership: ChannelMembershipWithChannel
  ): Promise<{ automated: boolean; reason?: RevokeNotAutomatedReason }> {
    const provider = this.providers.get(membership.channel.platform);
    if (!provider) {
      return { automated: false, reason: "no_provider_for_platform" };
    }
    if (!provider.capabilities().canGateAccess) {
      return { automated: false, reason: "provider_cannot_gate_access" };
    }
    if (membership.channel.externalGroupId === null) {
      // Nothing to remove them from. Same misconfiguration the grant path reports.
      return { automated: false, reason: "no_provider_for_platform" };
    }
    if (membership.externalMemberId === null) {
      // The ordinary Phase 4 case: access was granted by invite link, so no
      // platform user id was ever recorded, and `banChatMember` addresses one.
      return { automated: false, reason: "no_provider_member_id_recorded" };
    }

    try {
      await provider.revokeAccess({
        externalGroupId: membership.channel.externalGroupId,
        externalMemberId: membership.externalMemberId,
      });
      return { automated: true };
    } catch (err) {
      // Ids and the platform only: an adapter error can carry a response body,
      // and the Telegram bot token is part of every Bot API request path.
      console.warn(
        `[gating] provider removal failed: platform=${safeLabel(membership.channel.platform)} ` +
          `channel=${membership.channel.id} membership=${membership.id} — the membership is ` +
          "still being revoked, and the creator is told it was not automated: " +
          redactLinks(err instanceof Error ? err.message : String(err))
      );
      return { automated: false, reason: "provider_error" };
    }
  }
}
