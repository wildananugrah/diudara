import { NotFoundError } from "../errors";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { ChannelMembershipRepositoryPort } from "../ports/channel-membership-repository.port";
import type { ChannelRepositoryPort } from "../ports/channel-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/** The one subscription status that entitles a member to access. */
const ACTIVE = "active";

/**
 * The sentence a member sees when no channel of theirs can be gated
 * automatically. Exported so tests assert the member is actually TOLD, rather
 * than asserting on a log line nobody reads.
 */
export const MANUAL_ADDITION_NOTICE =
  "Untuk grup di bawah ini, pemilik komunitas akan menambahkan Anda secara manual";

export interface GrantChannelAccessInput {
  subscriptionId: string;
}

export interface GrantChannelAccessResult {
  /** Channels gated by this call — one new invite link each. */
  granted: number;
  /** Channels that already had an active membership with a link. */
  alreadyGranted: number;
  /** Channels whose provider cannot gate access, or that are misconfigured. */
  manual: number;
  /**
   * Whether ANY channel was actually gated. False is the honest answer for a
   * notify-only community, and the caller must be able to tell it apart from a
   * real grant — a silent success is the worst failure mode in this phase.
   */
  automated: boolean;
  /** Set when nothing was attempted at all, saying why. */
  skippedReason?: string;
}

/**
 * Turns an activated subscription into actual access.
 *
 * Called by the outbox worker, never inside the payment transaction: issuing an
 * invite is an external HTTP call, and a Telegram outage must delay an invite,
 * never roll back a payment (plan, Global Constraints).
 *
 * Three rules shape every line below:
 *
 *  1. IDEMPOTENCY IS THE DATABASE'S JOB. `channel_membership` is unique on
 *     `(member_id, channel_id)`, so the row is CLAIMED before the provider is
 *     called and a losing claim means "someone already did this". An invite link
 *     is a bearer credential: a second one for the same member is a second key,
 *     which could be forwarded to somebody who never paid.
 *  2. NOTHING MAY SILENTLY LOOK LIKE SUCCESS. A provider that cannot gate access
 *     is reported as `manual`, told to the member, and written to `activity_log`.
 *     A platform with no adapter at all THROWS.
 *  3. THE LINK GOES TO THE MEMBER AND NOWHERE ELSE. It is never put in an
 *     `activity_log` entry, an error message, or a log line — only in the
 *     WhatsApp message to the member who bought it.
 */
export class GrantChannelAccess {
  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly channels: ChannelRepositoryPort,
    private readonly memberships: ChannelMembershipRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * Gating providers by `channel.platform`. A map rather than a list so an
     * unknown platform is a lookup miss with a name to report, and rather than a
     * single provider so a community can have channels on several platforms.
     */
    private readonly providers: ReadonlyMap<string, MessagingProviderPort>,
    /**
     * How the MEMBER is reached: WhatsApp, always. It is separate from
     * `providers` because notification and gating are different capabilities on
     * purpose — `TelegramBotAdapter.notify` throws, since it addresses a WhatsApp
     * number it has no way to reach. Wiring the gating provider in here would
     * mean a member who paid is never told anything.
     */
    private readonly notifier: MessagingProviderPort
  ) {}

  async execute(input: GrantChannelAccessInput): Promise<GrantChannelAccessResult> {
    const context = await this.subscriptions.findByIdWithCommunity(input.subscriptionId);
    if (!context) {
      throw new NotFoundError(`subscription ${input.subscriptionId} not found`);
    }
    const { subscription, communityId } = context;

    if (subscription.status !== ACTIVE) {
      // An outbox row can sit for a long time — a provider outage, a stopped
      // worker, a reclaimed row — and access must reflect the subscription as it
      // is NOW. Phase 5 revokes on churn; granting a cancelled subscription here
      // would fight it. Recorded rather than thrown: a retry cannot fix it.
      console.warn(
        `[gating] not granting access: subscription=${subscription.id} is ` +
          `'${subscription.status}', not '${ACTIVE}'`
      );
      await this.activityLog.record({
        memberId: subscription.memberId,
        communityId,
        eventType: "access_not_granted",
        metadata: {
          reason: "subscription_not_active",
          subscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
        },
      });
      return {
        granted: 0,
        alreadyGranted: 0,
        manual: 0,
        automated: false,
        skippedReason: "subscription_not_active",
      };
    }

    const member = await this.members.findById(subscription.memberId);
    if (!member) {
      // A subscription's member_id is a foreign key, so this cannot happen
      // without the database having been edited by hand. Throwing beats
      // notifying nobody.
      throw new NotFoundError(
        `member ${subscription.memberId} for subscription ${subscription.id} not found`
      );
    }

    const channelList = await this.channels.listByCommunity(communityId);

    const links: { platform: string; inviteLink: string }[] = [];
    const manualPlatforms: string[] = [];
    const failures: string[] = [];
    let granted = 0;
    let alreadyGranted = 0;

    for (const channel of channelList) {
      const provider = this.providers.get(channel.platform);
      if (!provider) {
        // Collected, not thrown on the spot: the community's OTHER channels must
        // still be granted, and the member must still be told. Rethrown below.
        failures.push(
          `channel ${channel.id} is on platform "${channel.platform}", which has no messaging ` +
            "provider wired in this deployment"
        );
        continue;
      }

      if (!provider.capabilities().canGateAccess) {
        // A WhatsApp-only community is a real configuration (spec §2.1). This is
        // the branch that makes it honest instead of invisible.
        manualPlatforms.push(channel.platform);
        await this.recordManual(member.id, communityId, subscription.id, {
          reason: "provider_cannot_gate_access",
          platform: channel.platform,
          channelId: channel.id,
        });
        continue;
      }

      if (channel.externalGroupId === null) {
        // The connect route requires a group id, but the column is nullable, so a
        // row can exist without one. Nothing can be gated without it, and
        // pretending otherwise is the failure mode this phase is shaped around.
        manualPlatforms.push(channel.platform);
        await this.recordManual(member.id, communityId, subscription.id, {
          reason: "channel_missing_external_group_id",
          platform: channel.platform,
          channelId: channel.id,
        });
        continue;
      }

      const claim = await this.memberships.claim({
        memberId: member.id,
        channelId: channel.id,
      });

      if (!claim.won && claim.membership.inviteLink !== null) {
        // Already granted. No second provider call, so no second credential —
        // this is the idempotency the unique index buys. The member is still
        // told below, with the link they already have: this path is only reached
        // after a failure or a reclaim, and a duplicate message beats a member
        // who paid and was never sent anything.
        alreadyGranted += 1;
        links.push({ platform: channel.platform, inviteLink: claim.membership.inviteLink });
        continue;
      }

      // Either we won the claim, or a previous attempt claimed the row and died
      // before the provider answered (`won: false` with no link). Both need a
      // link issued; neither can produce a second one, because the row is
      // already ours.
      //
      // `previousExternalMemberId` carries the id from the LAST time this member
      // had access, when there is one. Task 7b made that possible: the
      // `chat_member` webhook records a joining member's platform user id, and
      // neither `revoke` nor `claim`'s reactivation clears the column — only the
      // link dies with the membership.
      //
      // It matters because of a Telegram rule with a silent failure mode:
      // `banChatMember` (how `revokeAccess` removes someone) also blocks the user
      // from joining via ANY invite link, so a churned member who re-pays gets a
      // fresh link that does nothing until they are unbanned. The adapter owns the
      // ordering (`unbanChatMember` with `only_if_banned` first); this use-case
      // just hands over the id it has. ABSENT rather than null when we never
      // learned one — the adapter treats presence as "call unbanChatMember".
      const previousExternalMemberId = claim.membership.externalMemberId;
      const { inviteLink } = await provider.grantAccess({
        externalGroupId: channel.externalGroupId,
        memberWhatsappNumber: member.whatsappNumber,
        ...(previousExternalMemberId === null ? {} : { previousExternalMemberId }),
      });
      await this.memberships.recordGrant(claim.membership.id, inviteLink);
      granted += 1;
      links.push({ platform: channel.platform, inviteLink });

      await this.activityLog.record({
        memberId: member.id,
        communityId,
        eventType: "channel_access_granted",
        // Ids and platform names only. NEVER the invite link: activity_log is
        // read by creator-facing dashboards, and the link is a bearer credential
        // that belongs to the member alone.
        metadata: {
          platform: channel.platform,
          channelId: channel.id,
          subscriptionId: subscription.id,
        },
      });
    }

    const noChannels = channelList.length === 0;
    if (noChannels) {
      // A paid community with no channel connected. Nothing to gate, and no
      // retry can change that — only the creator can — so it is recorded and
      // reported rather than failed.
      console.warn(
        `[gating] community=${communityId} has no channels connected, so subscription=` +
          `${subscription.id} cannot be granted automated access`
      );
      await this.recordManual(member.id, communityId, subscription.id, {
        reason: "no_channels_configured",
      });
    }

    const needsManual = manualPlatforms.length > 0 || noChannels;
    if (links.length > 0 || needsManual) {
      // ONE message, whatever it took to get here. Sent BEFORE the failure check
      // below on purpose: if one platform is unwired, the member should still
      // receive the links that do exist rather than nothing at all.
      await this.notifier.notify({
        toWhatsappNumber: member.whatsappNumber,
        message: buildMemberMessage({ links, manualPlatforms, noChannels }),
      });
    }

    if (failures.length > 0) {
      // The outbox row retries and then fails permanently with this text, which
      // is where an operator finds out. It names ids and platforms only.
      throw new Error(
        `grant_access for subscription ${subscription.id} could not be completed: ` +
          failures.join("; ")
      );
    }

    return {
      granted,
      alreadyGranted,
      manual: manualPlatforms.length,
      automated: granted + alreadyGranted > 0,
    };
  }

  private async recordManual(
    memberId: string,
    communityId: string,
    subscriptionId: string,
    detail: Record<string, string>
  ): Promise<void> {
    await this.activityLog.record({
      memberId,
      communityId,
      eventType: "access_manual_required",
      metadata: { ...detail, subscriptionId },
    });
  }
}

/**
 * Adapts the use-case to `ProcessOutbox`'s handler signature, and is the ONE
 * place the `grant_access` payload contract is checked.
 *
 * The payload comes back out of a jsonb column as `unknown`. It was written by
 * `HandlePaymentWebhook` — ids only, no provider payload — but a row can outlive
 * a deploy that changed the shape, and `undefined` reaching `execute` would
 * become a confusing "subscription undefined not found" five attempts in a row.
 */
export function grantAccessOutboxHandler(useCase: GrantChannelAccess) {
  return async (payload: unknown): Promise<void> => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("subscriptionId" in payload) ||
      typeof payload.subscriptionId !== "string" ||
      payload.subscriptionId === ""
    ) {
      // Says what is wrong WITHOUT echoing the payload: the worker logs this, and
      // Phase 3 found payer PII in provider payloads.
      throw new Error(
        "grant_access outbox payload carries no usable string subscriptionId " +
          "(the payload itself is deliberately not repeated here)"
      );
    }
    await useCase.execute({ subscriptionId: payload.subscriptionId });
  };
}

/**
 * The one message the member receives. In Indonesian, because members are.
 *
 * This is the ONLY place an invite link is allowed to appear (plan, Global
 * Constraints), which is also why the message is built here and not assembled
 * from pieces scattered across the use-case.
 */
function buildMemberMessage(input: {
  links: { platform: string; inviteLink: string }[];
  manualPlatforms: string[];
  noChannels: boolean;
}): string {
  const lines = ["Pembayaran Anda sudah kami terima. Terima kasih!"];

  if (input.links.length > 0) {
    lines.push("");
    lines.push("Silakan gabung ke grup komunitas melalui tautan berikut:");
    for (const link of input.links) {
      lines.push(`- ${link.platform}: ${link.inviteLink}`);
    }
    lines.push("");
    // Said plainly, because it is true and because a member who forwards the
    // link will otherwise blame us when it stops working.
    lines.push(
      "Tautan ini hanya bisa dipakai satu kali dan akan kedaluwarsa, jadi jangan dibagikan."
    );
  }

  if (input.manualPlatforms.length > 0) {
    lines.push("");
    lines.push(`${MANUAL_ADDITION_NOTICE}: ${input.manualPlatforms.join(", ")}.`);
  }

  if (input.noChannels) {
    lines.push("");
    lines.push(`${MANUAL_ADDITION_NOTICE}: belum ada grup yang terhubung.`);
  }

  return lines.join("\n");
}
