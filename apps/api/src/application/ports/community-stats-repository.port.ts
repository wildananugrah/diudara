/**
 * The aggregates behind `GET /communities/:slug/stats`.
 *
 * **No new tables.** Every number here comes from `user_transaction`,
 * `user_subscription` and `community_member`, and it only comes cheaply
 * because Phase 5 put `community_id` on the subscription — without it,
 * attributing revenue to a community would join transaction → subscription →
 * tier → community on every aggregate.
 *
 * Each method is scoped to ONE community. There is no cross-community or
 * platform-wide read here, and adding one is not a small change: every query
 * below leans on that scope for its index.
 */
export interface CommunityStatsRepositoryPort {
  /**
   * Sum of `paid` transaction amounts for this community, in whole rupiah.
   *
   * `paid` ONLY. A `pending` invoice is money that has not arrived, and an
   * `expired` one is money that never will.
   */
  totalRevenue(communityId: string): Promise<number>;
  /**
   * Paid and expired transaction counts — the two TERMINAL states, which is
   * what the success rate is a ratio of. `pending` is deliberately absent:
   * an invoice in flight is neither, and the use case needs to know the
   * denominator is empty rather than be handed a zero it cannot distinguish
   * from "all failed".
   */
  terminalTransactionCounts(communityId: string): Promise<{ paid: number; expired: number }>;
  /**
   * Subscription counts by lifecycle, for the churn ratio. `everActive` is
   * every row that is not still pending — a subscription that never activated
   * never had a chance to churn, so counting it would flatter the number.
   */
  subscriptionLifecycleCounts(
    communityId: string
  ): Promise<{ everActive: number; ended: number }>;
  /**
   * Paid revenue per WIB month inside `[from, to)`, as a sparse map keyed
   * `YYYY-MM`. SPARSE on purpose: months with no revenue are absent here and
   * the use case zero-fills them, so the "a gap means zero, not unknown"
   * decision lives in one place rather than being half-made by a query.
   */
  revenueByWibMonth(communityId: string, from: Date, to: Date): Promise<Map<string, number>>;
  /**
   * Every tier of this community with its ACTIVE subscriber count, including
   * tiers nobody has bought — an owner needs to see the tier that is not
   * selling.
   */
  tierDistribution(
    communityId: string
  ): Promise<{ tierId: string; name: string; subscriberCount: number }[]>;
  /** How many members joined inside `[from, to)` — the current WIB month. */
  membersJoinedBetween(communityId: string, from: Date, to: Date): Promise<number>;
  /**
   * The newest members with the standing fields the dashboard shows beside
   * them, in ONE query.
   *
   * **Not `CommunityRepositoryPort.listMembers` plus a lookup per row.** That
   * projection is the public roster's and carries no user id — only a handle
   * — so resolving each member's subscription from it is not merely slow, it
   * is impossible without widening a closed public type. A first attempt
   * passed the handle where a subscriber id was wanted: it typechecked, and
   * every member would have silently read as having no subscription.
   *
   * Returns the raw lifecycle fields rather than a decided standing, so
   * `membershipStanding` — the one function `IsMemberOf` and the document
   * gate also use — stays the single definition of member vs lapsed.
   */
  recentMembers(
    communityId: string,
    limit: number
  ): Promise<
    {
      handle: string;
      displayName: string;
      joinedAt: Date;
      subscriptionStatus: string | null;
      subscriptionKind: string | null;
      currentPeriodEnd: Date | null;
    }[]
  >;
}
