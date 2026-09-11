import { ForbiddenError, NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type {
  StartUserSubscription,
  StartUserSubscriptionResult,
} from "./start-user-subscription";

/**
 * `POST /communities/:slug/subscribe` — **an authorisation wrapper around
 * `StartUserSubscription`, and nothing more**, the shape
 * `CreateCommunityPost` established over `CreatePost`.
 *
 * Every part of taking money — the invoice, the pending-slot dance, the
 * transaction row, the lapsed-row retirement, the free-tier branch — stays in
 * `StartUserSubscription`, reached through its `communityId`. This class adds
 * only what a community asks that a profile does not.
 */
export class StartCommunitySubscription {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly users: UserRepositoryPort,
    private readonly startSubscription: StartUserSubscription
  ) {}

  async execute(input: {
    slug: string;
    subscriberId: string;
    tierId: string;
  }): Promise<StartUserSubscriptionResult> {
    // The slug resolves FIRST, so an unknown one is always a 404 and never a
    // 403 — a 403 on a slug that does not exist confirms to a probe which
    // slugs do.
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    // **MEMBERSHIP FIRST, and it is not ceremony.** Joining is free and one
    // click, so this costs a buyer nothing — and it keeps one rule true
    // everywhere else: every subscriber is a member, so the document gate
    // never has to handle "paid but not joined". A row in that state would
    // be a person who paid and can open nothing.
    if (!(await this.communities.isMember(community.id, input.subscriberId))) {
      throw new ForbiddenError(
        "Gabung ke komunitas ini dulu sebelum memilih tingkatan keanggotaan."
      );
    }

    // **THE PAYOUT DESTINATION, resolved from the COMMUNITY.**
    //
    // `user_tier.owner_id` is where the money goes, and
    // `user_subscription_tier_owner_fk` pins a subscription to it. So a tier
    // whose owner had drifted from the community's owner would route this
    // purchase to a former owner.
    //
    // The guard against that is TRANSITIVE rather than a second explicit
    // comparison here, and that is deliberate: the delegate resolves the
    // seller from this handle and then refuses any tier whose `ownerId` is not
    // that seller's. Since this handle comes off `community.ownerId`, a tier
    // owned by anyone else is already a 404. Re-asserting it here would be a
    // second copy of a rule the delegate enforces, which is how two copies
    // drift.
    //
    // Nothing transfers community ownership today, so the drift cannot happen
    // yet — the value of the arrangement is that it fails loudly if a transfer
    // feature ever ships without migrating that community's tiers.
    const owner = await this.users.findById(community.ownerId);
    if (owner === null) {
      // The community's owner row is gone. Not reachable through any current
      // path; answered as a missing community rather than a 500, because a
      // community nobody owns is not one a buyer can pay.
      throw new NotFoundError("komunitas tidak ditemukan");
    }

    const result = await this.startSubscription.execute({
      subscriberId: input.subscriberId,
      // `StartUserSubscription` resolves the seller by handle; the community's
      // OWNER is that seller. Taken off the community rather than passed in,
      // so a caller cannot name a different one.
      handle: owner.handle,
      tierId: input.tierId,
      communityId: community.id,
    });
    return result;
  }
}
