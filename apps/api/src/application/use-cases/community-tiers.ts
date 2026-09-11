import { ForbiddenError, NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";
import type { ManageUserTiers } from "./manage-user-tiers";

/**
 * **An authorisation wrapper around `ManageUserTiers`, and nothing more** —
 * the shape `CreateCommunityPost` established over `CreatePost`.
 *
 * Every rule about what a tier may be (a non-empty name, a non-negative
 * price, a supported billing cycle, and the CONNECTED payout account a paid
 * tier needs) stays in `ManageUserTiers`, reached through `communityId`. This
 * class adds only the two questions a community asks that a profile does not:
 * does the slug exist, and does this caller own it.
 *
 * ORDER MATTERS, the same order every community use case keeps: the slug
 * resolves FIRST, so an unknown one is always a `NotFoundError` and never a
 * `ForbiddenError` — a 403 on a slug that does not exist confirms to a probe
 * which slugs do.
 */
export class ManageCommunityTiers {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: UserTierRepositoryPort,
    private readonly manageTiers: ManageUserTiers
  ) {}

  /** The public offer — anyone may read it, which is what makes a paid community evaluable. */
  async list(input: { slug: string }): Promise<UserTierRow[]> {
    const community = await this.requireCommunity(input.slug);
    return this.tiers.listActiveByCommunity(community.id);
  }

  async create(input: {
    slug: string;
    ownerId: string;
    name: string;
    priceAmount: number;
    billingCycle?: string;
  }): Promise<UserTierRow> {
    const community = await this.requireOwner(input.slug, input.ownerId);
    return this.manageTiers.create({
      // THE PAYOUT DESTINATION is the community's owner, not merely the
      // caller — they are the same person here because `requireOwner` just
      // said so, and taking it off the COMMUNITY is what keeps
      // `user_subscription_tier_owner_fk` meaningful if that ever stops being
      // true.
      ownerId: community.ownerId,
      name: input.name,
      priceAmount: input.priceAmount,
      billingCycle: input.billingCycle,
      communityId: community.id,
    });
  }

  /**
   * Stops the tier being offered. Existing subscriptions to it keep working —
   * `deactivate` flips a flag rather than deleting, because a subscription's
   * foreign key would otherwise point at nothing.
   */
  async deactivate(input: { slug: string; ownerId: string; tierId: string }): Promise<UserTierRow> {
    const community = await this.requireOwner(input.slug, input.ownerId);
    const tier = await this.tiers.findById(input.tierId);
    // A tier belonging to another community is a 404, not a 403 — the same
    // choice `ManageUserTiers.deactivate` makes for another owner's tier, so
    // probing ids teaches a caller nothing. It is also a correctness gate:
    // deactivating somebody else's tier is exactly what this refuses.
    if (tier === null || tier.communityId !== community.id) {
      throw new NotFoundError("tingkatan tidak ditemukan");
    }
    const updated = await this.tiers.deactivate(tier.id);
    if (updated === null) throw new NotFoundError("tingkatan tidak ditemukan");
    return updated;
  }

  private async requireCommunity(slug: string) {
    const community = await this.communities.findBySlug(slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");
    return community;
  }

  private async requireOwner(slug: string, ownerId: string) {
    const community = await this.requireCommunity(slug);
    if (community.ownerId !== ownerId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh mengelola tingkatan");
    }
    return community;
  }
}
