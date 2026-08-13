import { ConflictError, NotFoundError, UniqueRule, UniqueViolationError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type {
  JoinRequestRepositoryPort,
  PendingJoinRequestRow,
} from "../ports/join-request-repository.port";
import type { JoinRequestUnitOfWorkPort } from "../ports/join-request-unit-of-work.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import { OUTBOX_GRANT_ACCESS } from "../ports/outbox-repository.port";

/** The message surfaced whenever a member turns out to already hold this tier actively. */
const ALREADY_ACTIVE_MEMBER_MESSAGE = "anggota ini sudah menjadi member aktif di tier tersebut.";

/**
 * `activity_log.event_type` for each outcome `DecideJoinRequest` can record.
 * Exported so `domain/activity-feed.ts`'s allowlist test can pin against the
 * same string this use-case writes, the same trick every other event-type
 * constant in this codebase uses (`RENEWED`, `CHURNED`, `STREAM_LIVE_EVENT`, …).
 */
export const JOIN_REQUEST_APPROVED_EVENT = "join_request_approved";
export const JOIN_REQUEST_REJECTED_EVENT = "join_request_rejected";

/**
 * The owner's decision on a free-community join request — approve or reject.
 *
 * ONE use case with two outcomes, not two use cases: the ownership check, the
 * already-decided check and the `activity_log` write are identical between
 * `"approved"` and `"rejected"`, and duplicating them across two classes is
 * how they drift apart from each other over time.
 */
export class DecideJoinRequest {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    private readonly joinRequests: JoinRequestRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly unitOfWork: JoinRequestUnitOfWorkPort
  ) {}

  async execute(input: {
    creatorId: string;
    communityId: string;
    requestId: string;
    decision: "approved" | "rejected";
  }): Promise<{ subscriptionId: string | null }> {
    // Ownership is 404, never 403 — a stranger must not learn the community
    // exists. `id` FIRST: `findByIdForCreator(id, creatorId)`.
    const community = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!community) {
      throw new NotFoundError("community not found");
    }

    // Never trust the id alone — a request whose OWN communityId differs from
    // the path's community is a 404 too, because the path's community is the
    // authority, not whatever the row happens to carry.
    const request = await this.joinRequests.findById(input.requestId);
    if (!request || request.communityId !== community.id) {
      throw new NotFoundError("join request not found");
    }

    // BOTH checks below are scoped to `"approved"` only, and both run OUTSIDE
    // the transaction, before it opens. Fix round 1: the tier-active check
    // used to run unconditionally, ahead of this branch — which meant a
    // request for a deactivated tier could be neither approved (409, correct)
    // NOR rejected (409, a genuine deadlock: the message tells the owner to
    // reject, and rejecting hits the same wall). Rejecting a pending request
    // never touches the tier — it only flips `join_request.status` — so
    // nothing about a deactivated tier is this decision's business.
    if (input.decision === "approved") {
      const tiers = await this.tiers.listByCommunity(community.id);
      const tier = tiers.find((t) => t.id === request.tierId);
      if (!tier || !tier.isActive) {
        throw new ConflictError(
          "tier ini sudah tidak aktif. Aktifkan kembali tier tersebut atau tolak permintaan ini."
        );
      }

      // The graceful pre-check, beside the tier-active check above — the same
      // division of labour `markPaid` uses for its own "already active" case.
      // Cheap, and it answers the ordinary (non-racing) case with a clear 409
      // before any write is attempted. It is NOT the guarantee — see the
      // try/catch inside the transaction below for that — because this is a
      // plain read and two decisions racing each other could both pass it.
      const existing = await this.subscriptions.findCurrentSubscriptionForTier(
        request.memberId,
        request.tierId
      );
      if (existing) {
        throw new ConflictError(ALREADY_ACTIVE_MEMBER_MESSAGE);
      }
    }

    return this.unitOfWork.run(async (repositories) => {
      const decided = await repositories.joinRequests.decide({
        id: request.id,
        status: input.decision,
        decidedBy: input.creatorId,
        decidedAt: new Date(),
      });
      // The row was already decided — `decide`'s UPDATE is conditional on
      // `status = 'pending'`, so this is the database arbitrating a race
      // between two clicks (or two tabs), not a read-then-write check.
      if (!decided) {
        throw new ConflictError("permintaan ini sudah diproses");
      }

      let subscriptionId: string | null = null;
      if (input.decision === "approved") {
        let subscription;
        try {
          subscription = await repositories.subscriptions.createActiveWithoutBilling({
            memberId: request.memberId,
            tierId: request.tierId,
          });
        } catch (err) {
          // THE guarantee. The pre-check above is a plain read and cannot close
          // a race between two decisions for the same (member, tier); this
          // catch is what actually enforces "at most one active subscription
          // per tier" — `subscription_member_tier_active_unique`, raised by the
          // INSERT itself. Caught and rethrown IMMEDIATELY, inside this same
          // transaction: a raw unique violation aborts the enclosing Postgres
          // transaction (see `createPending`'s docstring in
          // drizzle-join-request.repository.ts for the same hazard), so there
          // is no safe way to keep working in this transaction after catching
          // it — only to let the rollback happen, which is exactly what is
          // wanted here. The rollback undoes `decide` above too, so the
          // request reverts to `pending` and the owner can still reject it.
          if (
            err instanceof UniqueViolationError &&
            err.rule === UniqueRule.subscriptionMemberTierActive
          ) {
            throw new ConflictError(ALREADY_ACTIVE_MEMBER_MESSAGE);
          }
          throw err;
        }
        subscriptionId = subscription.id;

        // The SAME event type a payment enqueues — `GrantChannelAccess`
        // (apps/worker) does not know or care whether a member paid or was
        // approved for free.
        await repositories.outbox.enqueue({
          eventType: OUTBOX_GRANT_ACCESS,
          payload: { subscriptionId },
        });
      }

      // Written for BOTH outcomes — this is the one write that is genuinely
      // identical between "approved" and "rejected", which is the whole reason
      // this is one use case and not two.
      await repositories.activityLog.record({
        memberId: request.memberId,
        communityId: community.id,
        eventType:
          input.decision === "approved" ? JOIN_REQUEST_APPROVED_EVENT : JOIN_REQUEST_REJECTED_EVENT,
        metadata: { joinRequestId: request.id, tierId: request.tierId },
      });

      return { subscriptionId };
    });
  }
}

/**
 * The owner's dashboard list of open requests for a community — `assertOwnsCommunity`'s
 * shape (see `manage-channels.ts`), inlined here rather than shared because it is a
 * two-line check and a shared helper across files buys nothing but an import.
 */
export class ListJoinRequests {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly joinRequests: JoinRequestRepositoryPort
  ) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<PendingJoinRequestRow[]> {
    const community = await this.communities.findByIdForCreator(input.communityId, input.creatorId);
    if (!community) {
      throw new NotFoundError("community not found");
    }
    return this.joinRequests.listPendingForCommunity(community.id);
  }
}
