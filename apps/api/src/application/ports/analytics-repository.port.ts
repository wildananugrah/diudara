/**
 * The creator dashboard's reads.
 *
 * EVERY METHOD TAKES `creatorId` AND SCOPES ON IT, AND THERE IS NO UNSCOPED
 * VARIANT. That is the whole design, not a convention: Phase 4's review singled
 * out `CommunityRepositoryPort` for having no unscoped lookup, because the
 * ABSENCE of the dangerous method is what makes the vulnerable query hard to
 * write by accident. Phase 3's one sanctioned exception — `findBySlug`, for the
 * public checkout page, which has no authenticated caller — is documented at its
 * own declaration there. Nothing here has that excuse: every one of these reads
 * serves an authenticated dashboard request.
 *
 * So do not add `getMetrics(communityId)` "for internal use". A worker that needs
 * unscoped access is not this port's caller, and the moment an unscoped read
 * exists, one route handler forgetting to pass `creatorId` becomes a cross-tenant
 * data leak instead of a compile error.
 *
 * A method returns `null` — never throws, never returns empty data — when the
 * community does not exist OR belongs to somebody else. THE TWO CASES ARE
 * DELIBERATELY INDISTINGUISHABLE. Use-cases turn `null` into `NotFoundError`, so
 * the wire answer is 404 and never 403: a 403 would confirm that another
 * creator's community exists, which is exactly what a stranger probing ids wants
 * to learn.
 *
 * These are also the first creator-scoped reads of tables the WORKER writes
 * unscoped (`activity_log` in particular), so the scoping has nowhere else it
 * could live.
 */

/**
 * How many members a community has, by subscription status.
 *
 * THREE FIGURES RATHER THAN ONE, AND `past_due` IS NOT FOLDED INTO `active`.
 * A `past_due` member is inside their grace period and STILL HAS CHANNEL ACCESS
 * (see `subscription.graceEndsAt`), so:
 *
 *   "how many people can currently see my group" -> active + pastDue
 *   "how many people are paid up"                -> active
 *
 * Those are two different questions a creator asks, and any single "members"
 * number answers one of them wrongly. Rather than pick, this reports what it
 * knows and Task 7 labels each figure — `past_due` still having access is the
 * non-obvious one, so the UI has to say so.
 *
 * Statuses that are NOT a membership are counted nowhere: `pending` is an unpaid
 * checkout, `cancelled` a subscription that never activated, `superseded` a
 * double-submit folded into an existing membership. Counting any of them would
 * tell a creator they have subscribers they do not have.
 */
export interface CommunityMemberCounts {
  active: number;
  pastDue: number;
  churned: number;
}

/** One row of "who bought which tier", including tiers nobody bought. */
export interface TierDistributionEntry {
  tierId: string;
  tierName: string;
  /** Integer Rupiah, as stored. Never a float — see the plan's Global Constraints. */
  priceAmount: number;
  /** `active` subscriptions only; `past_due` and `churned` are excluded. */
  activeMembers: number;
}

export interface CommunityMetrics {
  members: CommunityMemberCounts;
  /**
   * Integer Rupiah, summed over `transaction.status = 'success'` ONLY.
   *
   * GROSS, and named so it cannot be mislabelled. Xendit's split rule deducts
   * DIUDARA's platform fee before the creator receives anything, so this is not
   * their income — a field called `revenue` would invite Task 7 presenting it as
   * such, which misstates what a creator earned.
   */
  grossRevenueAmount: number;
  tierDistribution: TierDistributionEntry[];
}

export interface AnalyticsRepositoryPort {
  /**
   * Every figure the dashboard's overview screen shows, or `null` when
   * `creatorId` does not own `communityId` (including when it does not exist).
   */
  getMetricsForCreator(communityId: string, creatorId: string): Promise<CommunityMetrics | null>;
}
