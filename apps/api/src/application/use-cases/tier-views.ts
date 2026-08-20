import type { UserTierRow } from "../ports/user-tier-repository.port";

/**
 * A membership tier as a VISITOR sees it on a creator's public profile.
 * EXACTLY four fields: `UserTierRow` also carries `ownerId`, `isActive` and
 * `createdAt`, and none of those is a visitor's business — `ownerId` would
 * identify the seller independently of the profile the visitor is already
 * looking at, `isActive` only matters to the owner's own tier editor
 * (`ManageUserTiers.list`, never this file), and `createdAt` is bookkeeping.
 *
 * Its own file rather than a widening of `post-views.ts`: a tier is not a
 * post, and `post-views.ts` exists specifically so the post projection has
 * exactly one owner (Task 5 pre-flight ruling, memberships-5a spec §6).
 */
export interface TierView {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

/**
 * `membership` on `PublicUserProfile`. `tiers` is REQUIRED, never optional —
 * see `toMembershipView`'s own docstring for why an empty list is not the
 * same as an absent field.
 */
export interface MembershipView {
  tiers: TierView[];
}

export function toTierView(row: UserTierRow): TierView {
  return {
    id: row.id,
    name: row.name,
    priceAmount: row.priceAmount,
    billingCycle: row.billingCycle,
  };
}

/**
 * `rows` is whatever `UserTierRepositoryPort.listActiveByOwner` returned —
 * already scoped to one owner and already filtered to `is_active = true` by
 * that single query (its own port docstring and
 * `DrizzleUserTierRepository.listActiveByOwner`). This function does not
 * re-filter; it only reshapes what it is given.
 *
 * `tiers` is always an array, even when `rows` is empty — a profile with no
 * tiers (or, equivalently, no connected payout account, since
 * `ManageUserTiers.create` refuses to publish a tier without one) reports
 * `{ tiers: [] }`, never an omitted `membership` key. The web must never
 * branch on `undefined` here: Phase 4 shipped a version of that mistake and
 * it produced a white screen during a deploy (memberships-5a spec, Task 5
 * brief).
 */
export function toMembershipView(rows: UserTierRow[]): MembershipView {
  return { tiers: rows.map(toTierView) };
}
