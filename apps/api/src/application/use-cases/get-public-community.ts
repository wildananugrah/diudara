import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";

export interface PublicTier {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

export interface PublicCommunity {
  id: string;
  name: string;
  niche: string | null;
  slug: string;
  tiers: PublicTier[];
}

export class GetPublicCommunity {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(slug: string): Promise<PublicCommunity> {
    const community = await this.communities.findBySlug(slug);
    if (!community || community.status !== "active") {
      throw new NotFoundError("community not found");
    }

    const all = await this.tiers.listByCommunity(community.id);

    // Explicit projection: never spread the record. Buyers must not see
    // creatorId, and later columns added to `community` must not leak by default.
    return {
      id: community.id,
      name: community.name,
      niche: community.niche,
      slug: community.slug,
      tiers: all
        .filter((t) => t.isActive)
        .map((t) => ({
          id: t.id,
          name: t.name,
          priceAmount: t.priceAmount,
          billingCycle: t.billingCycle,
        })),
    };
  }
}
