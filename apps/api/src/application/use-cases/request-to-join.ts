import { ConflictError, NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { JoinRequestRepositoryPort } from "../ports/join-request-repository.port";
import type { JoinRequestUnitOfWorkPort } from "../ports/join-request-unit-of-work.port";
import { OUTBOX_NOTIFY_JOIN_REQUEST } from "../ports/outbox-repository.port";
import { VISIBLE_STATUSES } from "./get-public-community";

/** `community.access_mode` value that accepts a free join request. */
const REQUEST_ACCESS_MODE = "request";

/**
 * `POST /c/:slug/join-request` — the free-community counterpart to
 * `StartCheckout`. A member asks to join instead of paying; the owner decides
 * later (Task 4).
 *
 * Re-checks EVERYTHING server-side that a client could have used to decide
 * whether to show this form at all — `community.status`, `accessMode`, tier
 * activeness — the same discipline `StartCheckout` already applies against
 * `GetPublicCommunity`'s own `VISIBLE_STATUSES` allowlist.
 */
export class RequestToJoin {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly unitOfWork: JoinRequestUnitOfWorkPort
  ) {}

  async execute(input: {
    slug: string;
    tierId: string;
    payerName: string;
    payerWhatsappNumber: string;
  }): Promise<{ joinRequestId: string }> {
    const community = await this.communities.findBySlug(input.slug);
    if (!community || !VISIBLE_STATUSES.has(community.status)) {
      throw new NotFoundError("community not found");
    }
    // Spec §9.1, same rule StartCheckout applies: a paused community still
    // RENDERS (an already-broadcast link keeps working) but accepts nobody.
    if (community.status !== "active") {
      throw new ConflictError("komunitas ini sedang tidak menerima anggota baru");
    }

    // THE guard this phase exists for. A `paid` community never accepts a
    // free join, whatever this deployment's payment configuration happens to
    // be — see the design spec §2 and §9. This must be 404, not a fallback to
    // the request path: a `paid` community with payments disabled (no Xendit
    // keys on this box) has NO join route at all, exactly like a paused
    // community, and a "helpful" fallback here would hand out — for free —
    // memberships the owner priced, triggered by nothing more than a missing
    // environment variable.
    if (community.accessMode !== REQUEST_ACCESS_MODE) {
      throw new NotFoundError("community not found");
    }

    const allTiers = await this.tiers.listByCommunity(community.id);
    const tier = allTiers.find((t) => t.id === input.tierId && t.isActive);
    if (!tier) {
      throw new NotFoundError("tier not found");
    }

    const member = await this.members.findOrCreateByWhatsappNumber({
      whatsappNumber: input.payerWhatsappNumber,
      name: input.payerName,
    });

    // Refused BEFORE the request row exists, not caught later by Task 4's
    // approval. The partial unique index (`join_request_community_member_
    // pending_unique`) only covers PENDING rows, so an already-approved
    // member could otherwise file a fresh request that Task 4's approval
    // would then try to activate — hitting `subscription_member_tier_active_
    // unique` and surfacing to the owner as an unexplained 500. Closing it
    // here closes it at the source.
    if (await this.subscriptions.hasLiveSubscriptionInCommunity(member.id, community.id)) {
      throw new ConflictError(
        "Anda sudah menjadi anggota komunitas ini. Cek WhatsApp Anda untuk tautan undangan grup."
      );
    }

    // ONE transaction: the request and its notification commit together or
    // not at all. See `JoinRequestUnitOfWorkPort` for why — the short version
    // is that a request nobody was ever told about, or a notification for a
    // request that does not exist, are both failures with no recovery path.
    return this.unitOfWork.run(async (repositories) => {
      const request = await repositories.joinRequests.createPending({
        communityId: community.id,
        tierId: tier.id,
        memberId: member.id,
      });
      if (!request) {
        // The unique index refused it — a pending request from this member
        // in this community already exists. NO outbox row may be enqueued:
        // an orphaned notification for a request that was never created
        // would tell the owner about a request they can never find, since
        // nothing else references this event's payload.
        throw new ConflictError("permintaan Anda sudah menunggu persetujuan pemilik komunitas");
      }

      await repositories.outbox.enqueue({
        eventType: OUTBOX_NOTIFY_JOIN_REQUEST,
        payload: { joinRequestId: request.id },
      });

      return { joinRequestId: request.id };
    });
  }
}

/** What `GET /c/:slug/request/:joinRequestId` returns. See its own docstring below. */
export interface JoinRequestStatus {
  status: string;
  communitySlug: string;
  /**
   * Non-null only once `status === "approved"` AND the member still holds a
   * current subscription for the tier they requested — resolved fresh on
   * every call via `findCurrentSubscriptionForTier`, never stored on the
   * join request itself. That is deliberate: a join request records a
   * DECISION, and the subscription it produced can later be revoked without
   * that decision changing, so re-deriving this at read time is what keeps
   * "approved with a link" and "approved but no longer live" distinguishable.
   */
  subscriptionId: string | null;
}

/**
 * Backs the public, unauthenticated `GET /c/:slug/request/:joinRequestId`
 * route. A member lands here straight off the redirect `RequestToJoin`'s
 * caller sends them to, so — exactly like `GetSubscriptionStatus` — the id
 * travels in a URL that may sit in browser history or be shared, and must be
 * treated as guessable.
 *
 * Returns ONLY `status`, `communitySlug` and `subscriptionId`. Never the
 * member's name or WhatsApp number: this URL must not become a lookup for
 * who joined what, the same shape `GetSubscriptionStatus`'s own docstring
 * warns about and the same shape a previous phase shipped a Critical by
 * getting wrong.
 */
export class GetJoinRequestStatus {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly joinRequests: JoinRequestRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort
  ) {}

  async execute(slug: string, joinRequestId: string): Promise<JoinRequestStatus> {
    const community = await this.communities.findBySlug(slug);
    if (!community) {
      throw new NotFoundError("community not found");
    }

    const request = await this.joinRequests.findById(joinRequestId);
    // Scoped to THIS community, not just "does the id exist" — a valid
    // joinRequestId paired with an unrelated slug must read as not found
    // rather than confirming the id belongs to some other community.
    if (!request || request.communityId !== community.id) {
      throw new NotFoundError("join request not found");
    }

    let subscriptionId: string | null = null;
    if (request.status === "approved") {
      const subscription = await this.subscriptions.findCurrentSubscriptionForTier(
        request.memberId,
        request.tierId
      );
      subscriptionId = subscription?.id ?? null;
    }

    // Explicit projection, never a spread: `request` carries `memberId`,
    // which resolves straight back to a name and a WhatsApp number through
    // `MemberRepositoryPort`, and must never reach this response.
    return {
      status: request.status,
      communitySlug: community.slug,
      subscriptionId,
    };
  }
}
