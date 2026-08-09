import { NotFoundError } from "../errors";
import { redactLinks, safeErrorSummary, safeLabel } from "../log-safety";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type {
  ChannelMembershipRepositoryPort,
  ChannelMembershipWithChannel,
} from "../ports/channel-membership-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import {
  OUTBOX_REVOKE_ACCESS,
  type OutboxRepositoryPort,
} from "../ports/outbox-repository.port";

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
  /**
   * We never learned the member's id on the platform, so there is nothing to aim
   * `banChatMember` at. Populated by `POST /webhooks/telegram` when the member
   * joins, so this now means "invited but never joined" — see the
   * `external_member_id` comment in db/schema.ts.
   */
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
 * The `automated: false` reasons worth another attempt, and the two the review named.
 *
 * `provider_error` is the obvious one: Telegram was unreachable or refused, and that
 * is exactly what a bounded retry is for.
 *
 * `no_provider_member_id_recorded` is here because it can become satisfiable: the
 * member may have been joining at the moment of revocation, so a `chat_member` update
 * recording their user id can land between the failure and the retry. When it has
 * not, the handler does NOT spin — it writes a manual-action entry and completes, so
 * there is a durable record without a doomed row retrying five times.
 *
 * `provider_cannot_gate_access` and `no_provider_for_platform` are deliberately
 * ABSENT: WhatsApp will never be able to remove anyone, and an unwired platform needs
 * a deploy, not a retry.
 */
const RETRYABLE_REASONS: ReadonlySet<RevokeNotAutomatedReason> = new Set([
  "provider_error",
  "no_provider_member_id_recorded",
]);

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
    private readonly providers: ReadonlyMap<string, MessagingProviderPort>,
    /**
     * Where an OUTSTANDING removal is recorded when the provider could not perform
     * it. See the `RETRYABLE_REASONS` enqueue below; the worker handles the row with
     * the same bounded retries every other outbox event gets.
     */
    private readonly outbox: OutboxRepositoryPort
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

      if (outcome.reason !== undefined && RETRYABLE_REASONS.has(outcome.reason)) {
        // A DURABLE RECORD THAT A REMOVAL IS OUTSTANDING, and the retry that acts on
        // it. Before this, the membership was revoked, `automated: false` was
        // returned, and nothing ever tried again — so a churned member stayed in the
        // paid group forever with nothing anywhere saying a removal was owed. For a
        // creator clicking a button, being told is enough; for Phase 5's churn job,
        // which is built on this use-case, it is not.
        //
        // Enqueued AFTER the audit entry and outside any transaction: this use-case
        // is synchronous by design and an outbox failure must not undo a revocation
        // the creator has already been told about.
        await this.outbox.enqueue({
          eventType: OUTBOX_REVOKE_ACCESS,
          // Ids only, as every payload in this codebase is. `membershipId` is enough
          // to find the channel and the recorded member id at retry time — reading
          // them fresh matters, because `external_member_id` may have been recorded
          // between the failure and the retry.
          payload: {
            membershipId: membership.id,
            communityId: input.communityId,
            memberId: input.memberId,
          },
        });
      }
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
    // KILL THE INVITE LINK FIRST, and whatever else happens below.
    //
    // Part of the credential-lifecycle invariant (see GrantChannelAccess): every link
    // that exists at the provider must be recorded. `memberships.revoke` NULLS
    // `invite_link` — correctly, a revoked row must not carry a live credential — so
    // without this the link goes on admitting whoever holds it, unrecorded, until it
    // expires. `member_limit: 1` does not help an UNUSED link, and this branch runs
    // precisely when the member never joined.
    //
    // Best-effort: `banChatMember` is what decides `automated`, and a creator must not
    // be told a removal failed because a link cleanup did.
    if (membership.inviteLink !== null) {
      try {
        await provider.revokeInviteLink({
          externalGroupId: membership.channel.externalGroupId,
          inviteLink: membership.inviteLink,
        });
      } catch (err) {
        console.warn(
          `[gating] could not revoke the invite link while removing access: membership=` +
            `${membership.id} channel=${membership.channel.id} — the member is still being ` +
            "removed. The link stays usable until it expires (the link itself is " +
            `deliberately not logged): ${redactLinks(safeErrorSummary(err))}`
        );
      }
    }

    if (membership.externalMemberId === null) {
      // The member was invited but never JOINED, so no `chat_member` update ever
      // arrived to record their platform user id — and `banChatMember` addresses
      // one. This was every revocation's outcome before `POST /webhooks/telegram`
      // existed; it is now the exception rather than the rule, and it is still
      // reported honestly rather than claimed as a removal.
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
          // `redactLinks(safeErrorSummary(err))`, the same pairing ProcessOutbox and
          // the HTTP error handler use. `err.message` alone kept a wrapped driver
          // error's multi-line, parameter-bearing text — the drift class Task 8 found.
          redactLinks(safeErrorSummary(err))
      );
      return { automated: false, reason: "provider_error" };
    }
  }
}

/** What one attempt at an outstanding removal concluded. */
export type RetryRevocationOutcome =
  /** The provider removed the member. The row is done. */
  | "removed"
  /** The membership is gone or active again, so nothing is outstanding. */
  | "no_longer_outstanding"
  /**
   * It cannot be automated and never will be — no member id was ever recorded, the
   * platform cannot gate, or the channel has no group id. Recorded for a person and
   * NOT retried: `revoke` nulls the invite link, so once it is gone no `chat_member`
   * update can resolve back to this row and no later attempt can learn the id.
   */
  | "manual_action_required";

/**
 * Retries a platform removal that `RevokeChannelAccess` could not perform.
 *
 * It exists because the entitlement and the platform state are separate facts.
 * Revoking the row is a local decision the creator has made and it always succeeds;
 * removing the person from a Telegram group is an external call that can fail. Before
 * this, the second half simply did not happen — `automated: false` was returned and
 * nothing retried — which Phase 5's churn job would have turned into "churned members
 * accumulate in the paid group forever".
 *
 * It THROWS only for a failure another attempt could fix, because a throw is how the
 * outbox schedules one. Everything terminal is recorded and reported, so a doomed row
 * does not burn five attempts to reach the same conclusion.
 */
export class RetryChannelAccessRevocation {
  constructor(
    private readonly memberships: ChannelMembershipRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    private readonly providers: ReadonlyMap<string, MessagingProviderPort>
  ) {}

  async execute(input: {
    membershipId: string;
    communityId: string;
    memberId: string;
  }): Promise<RetryRevocationOutcome> {
    const membership = await this.memberships.findByIdWithChannel(input.membershipId);
    if (!membership || membership.status !== "revoked") {
      // Gone, or ACTIVE again because the member re-paid and was re-granted. Either
      // way there is no outstanding removal, and removing them now would eject
      // somebody who is currently entitled to be there.
      console.warn(
        `[gating] outstanding removal no longer applies: membership=` +
          `${safeLabel(input.membershipId)} is ` +
          `${membership === null ? "gone" : `'${safeLabel(membership.status)}'`} — nothing to do`
      );
      return "no_longer_outstanding";
    }

    const provider = this.providers.get(membership.channel.platform);
    if (
      !provider ||
      !provider.capabilities().canGateAccess ||
      membership.channel.externalGroupId === null
    ) {
      await this.recordManualAction(input, membership.channel.id, "no_provider_for_platform");
      return "manual_action_required";
    }

    if (membership.externalMemberId === null) {
      // Read FRESH, which is the point of carrying only ids in the payload: a
      // `chat_member` update may have recorded the id between the failure and now. It
      // has not, and it never will — `revoke` nulled the invite link, so no update can
      // resolve back to this row. Recorded for a person rather than retried into a
      // permanent failure.
      await this.recordManualAction(
        input,
        membership.channel.id,
        "no_provider_member_id_recorded"
      );
      return "manual_action_required";
    }

    // No try/catch: a provider failure MUST propagate. That is what sends the row back
    // for another attempt with backoff, and what eventually fails it permanently with
    // `last_error` for an operator — a bounded retry, never an unbounded one.
    await provider.revokeAccess({
      externalGroupId: membership.channel.externalGroupId,
      externalMemberId: membership.externalMemberId,
    });

    await this.activityLog.record({
      memberId: input.memberId,
      communityId: input.communityId,
      eventType: "channel_access_revoked",
      metadata: {
        channelId: membership.channel.id,
        platform: membership.channel.platform,
        automated: true,
        // Distinguishes this from the entry the synchronous revoke already wrote, so
        // an audit trail shows the removal was completed LATE rather than twice.
        retried: true,
      },
    });
    return "removed";
  }

  /**
   * Records that a human has to remove this member by hand. The durable record the
   * review asked for, and the reason this handler completes instead of retrying.
   */
  private async recordManualAction(
    input: { communityId: string; memberId: string },
    channelId: string,
    reason: RevokeNotAutomatedReason
  ): Promise<void> {
    console.warn(
      `[gating] a removal cannot be automated and will not be retried: channel=${channelId} ` +
        `reason=${reason} — recorded for manual action`
    );
    await this.activityLog.record({
      memberId: input.memberId,
      communityId: input.communityId,
      eventType: "revocation_manual_required",
      metadata: { channelId, reason },
    });
  }
}

/**
 * Adapts the retry to `ProcessOutbox`'s handler signature, and is the ONE place the
 * `revoke_access` payload contract is checked — the same shape, and the same
 * reasoning, as `grantAccessOutboxHandler`.
 */
export function revokeAccessOutboxHandler(useCase: RetryChannelAccessRevocation) {
  return async (payload: unknown): Promise<void> => {
    if (typeof payload !== "object" || payload === null) {
      throw new Error(
        "revoke_access outbox payload is not an object (the payload itself is " +
          "deliberately not repeated here)"
      );
    }
    const { membershipId, communityId, memberId } = payload as Record<string, unknown>;
    if (
      typeof membershipId !== "string" ||
      membershipId === "" ||
      typeof communityId !== "string" ||
      communityId === "" ||
      typeof memberId !== "string" ||
      memberId === ""
    ) {
      throw new Error(
        "revoke_access outbox payload needs a string membershipId, communityId and " +
          "memberId (the payload itself is deliberately not repeated here)"
      );
    }
    await useCase.execute({ membershipId, communityId, memberId });
  };
}
