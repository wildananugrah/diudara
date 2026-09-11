/** One membership tier a user offers on their own profile. */
export interface UserTierRow {
  id: string;
  ownerId: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
  isActive: boolean;
  createdAt: Date;
  /**
   * Phase 5. `null` on a PERSONAL tier — one offered on somebody's profile,
   * which is every row predating that phase. Non-null on a COMMUNITY tier.
   *
   * Present on EVERY row rather than only community ones, so the key set is
   * stable — the reasoning `PostView` records for `membersOnly` and `type`.
   */
  communityId: string | null;
}

export interface UserTierRepositoryPort {
  create(input: {
    /**
     * The PAYOUT destination, always — a person, never a community. For a
     * community tier this is the community's owner, which is what keeps
     * `user_subscription_tier_owner_fk` holding unchanged.
     */
    ownerId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
    /** Omitted for a personal tier, which leaves the column at its NULL default. */
    communityId?: string;
  }): Promise<UserTierRow>;
  findById(id: string): Promise<UserTierRow | null>;
  /**
   * Every PERSONAL tier this owner has ever defined, active before
   * deactivated.
   *
   * EXCLUDES community tiers (Phase 5). A community tier surfacing on its
   * owner's profile would offer a stranger membership of a community whose
   * page they are not looking at — and the owner's own tier management would
   * show tiers they cannot edit from there.
   */
  listByOwner(ownerId: string): Promise<UserTierRow[]>;
  /** Only the PERSONAL tiers this owner is currently offering — what a visitor's profile shows. Excludes community tiers, same reason. */
  listActiveByOwner(ownerId: string): Promise<UserTierRow[]>;
  /** Only the tiers this COMMUNITY is currently offering — what its page shows. */
  listActiveByCommunity(communityId: string): Promise<UserTierRow[]>;
  /**
   * Flips `is_active` to `false`. Does NOT delete the row — the spec's §4
   * requires existing subscriptions to a deactivated tier to keep working,
   * and a subscription's foreign key to `user_tier` would have nothing to
   * point at if this deleted instead.
   */
  deactivate(id: string): Promise<UserTierRow | null>;
}
