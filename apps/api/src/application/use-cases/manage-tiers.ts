import { assertValidTier, type BillingCycle } from "../../domain/membership-tier";
import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  MembershipTierRepositoryPort,
  TierPatch,
  TierRecord,
} from "../ports/membership-tier-repository.port";

/** Throws unless `creatorId` owns `communityId`. */
async function assertOwnsCommunity(
  communities: CommunityRepositoryPort,
  communityId: string,
  creatorId: string
): Promise<void> {
  const community = await communities.findByIdForCreator(communityId, creatorId);
  if (!community) {
    throw new NotFoundError("community not found");
  }
}

export class DefineMembershipTier {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    name: string;
    priceAmount: number;
    billingCycle: BillingCycle;
  }): Promise<TierRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);

    // Enforces the invariants (non-negative price, known cycle, non-empty name)
    // before anything reaches the database, independently of the Zod layer.
    assertValidTier({
      name: input.name,
      priceAmount: input.priceAmount,
      billingCycle: input.billingCycle,
    });

    return this.tiers.create({
      communityId: input.communityId,
      name: input.name,
      priceAmount: input.priceAmount,
      billingCycle: input.billingCycle,
    });
  }
}

export class ListTiers {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<TierRecord[]> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);
    return this.tiers.listByCommunity(input.communityId);
  }
}

export class UpdateTier {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    tierId: string;
    patch: TierPatch;
  }): Promise<TierRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);

    const updated = await this.tiers.updateForCommunity(
      input.tierId,
      input.communityId,
      input.patch
    );
    if (!updated) {
      throw new NotFoundError("tier not found");
    }
    return updated;
  }
}
