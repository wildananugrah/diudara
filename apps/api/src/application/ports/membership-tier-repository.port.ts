export interface TierRecord {
  id: string;
  communityId: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
  isActive: boolean;
}

export interface TierPatch {
  name?: string;
  priceAmount?: number;
  billingCycle?: string;
  isActive?: boolean;
}

export interface MembershipTierRepositoryPort {
  create(input: {
    communityId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
  }): Promise<TierRecord>;
  listByCommunity(communityId: string): Promise<TierRecord[]>;
  updateForCommunity(
    tierId: string,
    communityId: string,
    patch: TierPatch
  ): Promise<TierRecord | null>;
}
