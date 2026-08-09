import { NotFoundError, providerCallOutcome } from "../errors";
import { redactLinks, safeErrorSummary } from "../log-safety";
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
   * Channels where a link was minted by an earlier attempt and never recorded, so
   * this call REFUSED to mint another. Counted in `manual` too, because that is what
   * it needs from a person; separate here so a caller can tell a WhatsApp-only
   * community apart from a credential that has to be reissued by hand.
   */
  mintLost: number;
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
 * ==========================================================================
 * THE CREDENTIAL-LIFECYCLE INVARIANT
 *
 *   At most one live invite link per (member, channel) may exist at the
 *   provider at any time, and every link that exists is recorded in
 *   `channel_membership.invite_link`.
 *
 * Both halves matter, and the second is the one that was missing. A link is a
 * bearer credential; an UNRECORDED link is a credential the system cannot
 * revoke, cannot attribute to a joiner (`recordPlatformMemberIdByInviteLink`
 * resolves it to `unknown_invite_link`, so no `external_member_id` is ever
 * captured) and therefore cannot ever remove from the group. It is strictly
 * worse than a duplicate we know about.
 *
 * It is enforced by three things acting together, none sufficient alone:
 *
 *   (a) `revokeInviteLink` on the provider port, so a link that cannot be
 *       recorded can be UNMINTED instead of dropped. Without it there is
 *       nowhere to put a fix.
 *   (b) `link_minted_at`, written in the SAME statement as the claim. This is the
 *       MUTUAL EXCLUSION: a second caller's `DO UPDATE` finds the marker already
 *       set against the locked tuple and is excluded, so only one caller ever
 *       holds the window. Marker set + no link means a link MAY be live and
 *       unrecorded, and no replacement is minted while that holds: Telegram cannot
 *       enumerate a bot's links, so an orphan whose value we lost is unkillable and
 *       a replacement would only add a second live key.
 *   (c) `mint_lease_until`, which CLASSIFIES the excluded caller — a live lease is
 *       a retryable `mint_in_progress`, a lapsed one is a fail-closed `mint_lost`.
 *       It does not provide the exclusion; (b) does.
 *
 * The marker is held only while a link may actually exist. A `grantAccess` failure
 * that came back AS A RESPONSE minted nothing, and releases the window — see `mint`.
 * Keeping it in that case traded a credential leak for a paying member who could
 * never be granted access again.
 *
 * Measured before these existed, with `recordGrant` failing after a successful
 * mint: FIVE live single-use links at the provider, one membership row,
 * `invite_link = NULL`, and the count grew with `maxAttempts`. Two concurrent
 * `execute` calls produced two live links, both delivered. The full suite passed
 * throughout — it counted membership ROWS, which were never what was at risk.
 * Tests for this invariant must count links AT THE PROVIDER.
 * ==========================================================================
 *
 * Three further rules shape every line below:
 *
 *  1. IDEMPOTENCY IS THE DATABASE'S JOB. `channel_membership` is unique on
 *     `(member_id, channel_id)`, so the row is CLAIMED before the provider is
 *     called and the claim's outcome — never a pre-check — decides whether this
 *     caller may mint. It was specified as a SEQUENTIAL property (retry the same
 *     payload twice, get one link) and had to become a CONCURRENT one.
 *  2. NOTHING MAY SILENTLY LOOK LIKE SUCCESS. A provider that cannot gate access
 *     is reported as `manual`, told to the member, and written to `activity_log`.
 *     A platform with no adapter at all THROWS. So does a lost mint, as `manual`
 *     plus an `activity_log` reason, so a person reissues deliberately.
 *  3. THE LINK GOES TO THE MEMBER AND NOWHERE ELSE. It is never put in an
 *     `activity_log` entry, an error message, or a log line — only in the
 *     WhatsApp message to the member who bought it. That includes the "leaked
 *     link" error: it names the membership, never the link.
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
        mintLost: 0,
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
    /**
     * Channels a concurrent caller is mid-grant on. RETRYABLE, unlike `failures`:
     * the retry finds a recorded link and succeeds.
     */
    const inProgress: string[] = [];
    let granted = 0;
    let alreadyGranted = 0;
    let mintLost = 0;

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

      if (claim.outcome === "already_granted" && claim.membership.inviteLink !== null) {
        // Already granted. No second provider call, so no second credential —
        // this is the idempotency the unique index buys. The member is still
        // told below, with the link they already have: this path is only reached
        // after a failure or a reclaim, and a duplicate message beats a member
        // who paid and was never sent anything.
        alreadyGranted += 1;
        links.push({ platform: channel.platform, inviteLink: claim.membership.inviteLink });
        continue;
      }

      if (claim.outcome === "mint_in_progress") {
        // Another caller holds the mint window RIGHT NOW. Reported and retried,
        // never minted alongside: two callers minting for one (member, channel)
        // was measured at two live links, and this is the reachable path — one
        // member buying two tiers of the same community enqueues two grants that
        // resolve the same channel list.
        //
        // Collected rather than thrown on the spot, exactly like `failures`: the
        // community's other channels must still be granted. The throw at the end
        // sends the outbox row back for a bounded retry, and by then the winner
        // has recorded its link, so the retry takes the `already_granted` branch
        // and the member is told with the link that actually works.
        inProgress.push(
          `channel ${channel.id}: another grant for this member is already in progress ` +
            "(a concurrent worker holds the mint lease), so no second invite link was issued"
        );
        continue;
      }

      if (claim.outcome === "mint_lost") {
        // A link was minted and never recorded, and the lease has lapsed. There
        // may be a LIVE credential at the provider whose value nobody holds:
        // Telegram's revokeChatInviteLink needs the link itself and no Bot API
        // method enumerates a bot's links, so it can never be killed.
        //
        // FAIL CLOSED. Minting a replacement is what turned one lost link into
        // five, and every one of them was a key to a paid group with no record
        // and no way to revoke it. Reported to the creator and told to the member
        // as manual addition, so a person reissues deliberately. NOT thrown: no
        // retry can fix it, and an unbounded retry would just re-report it.
        console.warn(
          `[gating] refusing to mint a replacement invite link: membership=` +
            `${claim.membership.id} channel=${channel.id} was left with a minted-but-` +
            "unrecorded link. A second link would be a second live credential with no " +
            "record of the first. Reissue deliberately after checking the group."
        );
        mintLost += 1;
        manualPlatforms.push(channel.platform);
        await this.recordManual(member.id, communityId, subscription.id, {
          reason: "invite_link_minted_but_not_recorded",
          platform: channel.platform,
          channelId: channel.id,
        });
        continue;
      }

      // `claim.outcome === "mint"`: this caller, and only this caller, holds the
      // mint window — `link_minted_at` and `mint_lease_until` were written in the
      // same statement that decided it. See ChannelMembershipClaim.
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
      // just hands over the id it has.
      //
      // `mint` owns what happens if the provider throws — see its docstring for why
      // that is not a one-liner.
      const previousExternalMemberId = claim.membership.externalMemberId;
      const inviteLink = await this.mint({
        provider,
        membershipId: claim.membership.id,
        channelId: channel.id,
        externalGroupId: channel.externalGroupId,
        memberWhatsappNumber: member.whatsappNumber,
        previousExternalMemberId,
      });

      // FROM HERE UNTIL recordGrant RETURNS TRUE, a live credential exists that the
      // database does not know about. Every exit from this stretch has to either
      // record the link or kill it — see `discardMintedLink`.
      const recorded = await this.recordMintedLink({
        provider,
        membershipId: claim.membership.id,
        externalGroupId: channel.externalGroupId,
        inviteLink,
        channelId: channel.id,
      });
      if (!recorded) {
        // `recordGrant` refused because the row already carries a link — a
        // concurrent caller won. Ours has been revoked at the provider by
        // `recordMintedLink`, so there is still exactly one live link, and it is
        // the recorded one. Retry to pick it up.
        inProgress.push(
          `channel ${channel.id}: a concurrent grant recorded its invite link first, so ` +
            "the link minted here was revoked at the provider rather than replacing it"
        );
        continue;
      }

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

    if (failures.length > 0 || inProgress.length > 0) {
      // The outbox row retries and then fails permanently with this text, which
      // is where an operator finds out. It names ids and platforms only.
      //
      // `inProgress` is in here so the row COMES BACK: reporting a concurrent grant
      // as success would leave that channel's outbox row marked sent while the
      // member has been told nothing about it.
      throw new Error(
        `grant_access for subscription ${subscription.id} could not be completed: ` +
          [...failures, ...inProgress].join("; ")
      );
    }

    return {
      granted,
      alreadyGranted,
      manual: manualPlatforms.length,
      mintLost,
      automated: granted + alreadyGranted > 0,
    };
  }

  /**
   * Calls the provider inside the mint window this caller already holds, and — on
   * failure — decides whether the window may be handed back.
   *
   * THE MINT WINDOW IS OPENED BY `claim`, BEFORE ANY OF THIS RUNS. That ordering is
   * what makes (b) of the invariant work, and it means a `grantAccess` that throws
   * leaves `link_minted_at` set with ZERO links minted. Left alone, every later
   * attempt reads that as `mint_in_progress` and then `mint_lost` and refuses to mint,
   * so the pair can never be granted again except through a `revoke` — and there is no
   * reissue tool. Measured: one transient provider failure followed by a perfectly
   * healthy provider produced 5 retries with `minted=0`, a `failed` outbox row, ZERO
   * WhatsApp notifications and ZERO `activity_log` rows, then three further `execute`
   * calls that each minted nothing. A silent, permanent lockout of someone who paid.
   *
   * The earlier justification for leaving the marker set — "that window is a few
   * milliseconds wide" — was simply wrong. The window spans the ENTIRE provider
   * round-trip (up to two Telegram calls at a 15s timeout each) and covers every
   * provider error, not just a process death between the claim and the call.
   *
   * So the two cases are told apart, and the adapter is the one that tells them apart
   * because it is the only thing that knows (see `ProviderCallError`):
   *
   *   "rejected"      a response WAS received — a non-2xx, or a body saying the method
   *                   failed — or the call never left the process. Nothing was minted,
   *                   demonstrably. Release the window; the next attempt mints cleanly.
   *   "indeterminate" no response, or one we could not read. A link may be live at the
   *                   provider with nobody holding its value. KEEP the marker: this is
   *                   the only state that justifies `mint_lost`.
   *
   * Releasing on `"rejected"` reopens none of the invariant's three paths. (a) is
   * untouched. (b) still gives mutual exclusion, because releasing happens only when
   * this caller minted nothing, so a caller that takes the window afterwards is still
   * the only one holding a credential. (c) still classifies, and the `mint_lost` branch
   * keeps every state that can hide a live link: a `recordGrant` failure whose cleanup
   * revoke also failed, an unreadable success body, a timeout, a process death.
   *
   * Rethrows always. A failed mint is a failed grant, and the outbox row must come back.
   */
  private async mint(input: {
    provider: MessagingProviderPort;
    membershipId: string;
    channelId: string;
    externalGroupId: string;
    memberWhatsappNumber: string;
    previousExternalMemberId: string | null;
  }): Promise<string> {
    try {
      const { inviteLink } = await input.provider.grantAccess({
        externalGroupId: input.externalGroupId,
        memberWhatsappNumber: input.memberWhatsappNumber,
        // ABSENT rather than null when we never learned one — the adapter treats
        // presence as "call unbanChatMember".
        ...(input.previousExternalMemberId === null
          ? {}
          : { previousExternalMemberId: input.previousExternalMemberId }),
      });
      return inviteLink;
    } catch (err) {
      // `providerCallOutcome` defaults to "indeterminate", so an adapter that throws
      // something unclassified still fails closed. Fail-closed by not knowing.
      if (providerCallOutcome(err) === "rejected") {
        await this.memberships.releaseMintWindow(input.membershipId);
        console.warn(
          `[gating] the provider REFUSED to mint an invite link, and answered, so nothing ` +
            `was minted: membership=${input.membershipId} channel=${input.channelId}. The ` +
            "mint window is reopened; the retry will issue a fresh link: " +
            redactLinks(safeErrorSummary(err))
        );
      } else {
        // No response, so a link may exist that we do not hold. The marker stays, which
        // is what makes the next attempt report `mint_lost` instead of stacking a second
        // credential on an unkillable first one.
        console.error(
          `[gating] a mint may or may not have happened: membership=${input.membershipId} ` +
            `channel=${input.channelId} — the provider never answered, so an invite link ` +
            "may be live at the provider with nobody holding its value. The mint marker is " +
            "left SET, so no replacement will be minted and a person must reissue: " +
            redactLinks(safeErrorSummary(err))
        );
      }
      throw err;
    }
  }

  /**
   * Records a link that has ALREADY been minted, and guarantees that a link which
   * cannot be recorded is killed at the provider instead of leaked.
   *
   * THE INVARIANT IS ENFORCED HERE: at most one live invite link per (member,
   * channel) may exist at the provider at any time, and every link that exists is
   * recorded in `channel_membership.invite_link`.
   *
   * Between `grantAccess` returning and `recordGrant` committing, a live bearer
   * credential exists that the database has no record of. If that write fails there
   * are exactly two honest options, and dropping the link is neither of them:
   *
   *  1. KILL IT. Best-effort `revokeInviteLink`. On success the credential is gone,
   *     so `releaseMintWindow` reopens the window and a retry may mint cleanly. This
   *     is what turns the measured five-live-links leak into zero.
   *  2. If the kill ALSO fails, KEEP THE MARKER SET. An orphan is live and
   *     unkillable; the marker is what makes every later attempt report `mint_lost`
   *     instead of stacking a second key on top of it. One leaked link is bad. Five
   *     is what the unfixed code produced, and the number grew with `maxAttempts`.
   *
   * Returns whether the link is now recorded. Never swallows the original failure:
   * it rethrows, so the outbox row retries and an operator sees why.
   */
  private async recordMintedLink(input: {
    provider: MessagingProviderPort;
    membershipId: string;
    externalGroupId: string;
    inviteLink: string;
    channelId: string;
  }): Promise<boolean> {
    let recorded: boolean;
    try {
      recorded = await this.memberships.recordGrant(input.membershipId, input.inviteLink);
    } catch (err) {
      await this.discardMintedLink(input);
      throw err;
    }

    if (!recorded) {
      // The row already carries a link, so ours is an orphan the moment it exists.
      await this.discardMintedLink(input);
    }
    return recorded;
  }

  /**
   * Kills a minted link we could not record, and reopens the mint window ONLY if the
   * kill succeeded. See `recordMintedLink` for why both halves matter.
   *
   * Deliberately swallows its own failure: it always runs while another failure is
   * being handled, and replacing that one would hide the reason the grant failed.
   */
  private async discardMintedLink(input: {
    provider: MessagingProviderPort;
    membershipId: string;
    externalGroupId: string;
    inviteLink: string;
    channelId: string;
  }): Promise<void> {
    try {
      await input.provider.revokeInviteLink({
        externalGroupId: input.externalGroupId,
        inviteLink: input.inviteLink,
      });
    } catch (err) {
      // The orphan is live and cannot be killed. `link_minted_at` stays set, which
      // is what stops any retry minting a second one — so this is loud but not
      // escalating. The link is NOT named: it is still a working credential.
      console.error(
        `[gating] LEAKED INVITE LINK: membership=${input.membershipId} channel=` +
          `${input.channelId} — a link was minted, could not be recorded, and could not be ` +
          "revoked at the provider. It stays live until it expires. No replacement will be " +
          "minted (the mint marker is left set), and the member is told a human will add " +
          `them: ${redactLinks(safeErrorSummary(err))}`
      );
      return;
    }

    // The credential is gone, so nothing is leaked and a retry may mint cleanly.
    await this.memberships.releaseMintWindow(input.membershipId);
    console.warn(
      `[gating] a minted invite link could not be recorded, so it was REVOKED at the ` +
        `provider: membership=${input.membershipId} channel=${input.channelId}. The mint ` +
        "window is reopened; the retry will issue a fresh link."
    );
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
