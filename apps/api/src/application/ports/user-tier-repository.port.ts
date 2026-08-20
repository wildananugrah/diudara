/** One membership tier a user offers on their own profile. */
export interface UserTierRow {
  id: string;
  ownerId: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
  isActive: boolean;
  createdAt: Date;
}

export interface UserTierRepositoryPort {
  create(input: {
    ownerId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
  }): Promise<UserTierRow>;
  findById(id: string): Promise<UserTierRow | null>;
  /** Every tier this owner has ever defined, active tiers before deactivated ones. */
  listByOwner(ownerId: string): Promise<UserTierRow[]>;
  /** Only the tiers this owner is currently offering — what a visitor's profile shows. */
  listActiveByOwner(ownerId: string): Promise<UserTierRow[]>;
  /**
   * Flips `is_active` to `false`. Does NOT delete the row — the spec's §4
   * requires existing subscriptions to a deactivated tier to keep working,
   * and a subscription's foreign key to `user_tier` would have nothing to
   * point at if this deleted instead.
   */
  deactivate(id: string): Promise<UserTierRow | null>;
}
