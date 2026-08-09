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

import type { KeysetCursor } from "../../domain/keyset-cursor";

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

/**
 * One `activity_log` row, as the feed reads it.
 *
 * `memberName` comes from a LEFT join — the column is nullable and the row's
 * `member_id` is itself nullable (community-scoped events have no member). The
 * member's WHATSAPP NUMBER IS DELIBERATELY NOT HERE: the feed is a screen a creator
 * leaves open all day, and a phone number has exactly one legitimate destination
 * in this product (the CSV export, which a creator asks for on purpose).
 *
 * `metadata` stays inside this layer and never reaches the wire. It is `unknown`
 * because it comes out of a jsonb column, and it exists so `describeActivityEvent`
 * can turn a stage or a platform into a label — see that function for why every
 * value is looked up rather than interpolated.
 */
export interface ActivityLogRow {
  id: string;
  eventType: string;
  metadata: unknown;
  createdAt: Date;
  memberId: string | null;
  memberName: string | null;
}

/**
 * WHERE A PAGE STARTS, keyed on `(created_at, id)` and never on an OFFSET.
 *
 * The feed is append-heavy — a payment, a reminder or a revocation can land
 * between two "load more" clicks — and an offset drifts as rows arrive: a single
 * newly-prepended row makes page 2 repeat page 1's last entry and drop one of the
 * originals. A cursor anchored on the row itself cannot drift. See
 * `KeysetCursor` in `domain/keyset-cursor.ts` for why the id is in it.
 */
export interface ActivityPageRequest {
  /** Maximum rows to return. The caller may ask for one extra to detect a next page. */
  limit: number;
  /** Return only rows strictly OLDER than this row. Omitted for the first page. */
  before?: KeysetCursor;
}

/**
 * One row of the member roster — the screen a creator manages people from, and the
 * CSV they export.
 *
 * SUBSCRIPTION-GRAINED, NOT MEMBER-GRAINED. `subscription_member_tier_active_unique`
 * forbids two active subscriptions on the SAME tier, but a member may hold one on
 * two different tiers of one community; collapsing those into a single row would hide
 * what they actually pay for. That is also why `subscriptionId` is here: it is the
 * keyset cursor's tiebreaker, and `memberId` cannot be, precisely because it repeats.
 *
 * `whatsappNumber` IS here, and it is the reason this port method exists as its own
 * thing rather than being folded into the activity feed. It is members' PERSONAL DATA
 * (Indonesia's UU PDP 27/2022 applies), so it travels only to the two endpoints a
 * creator asks for deliberately, is never logged, and never appears in the feed.
 */
export interface MemberRosterRow {
  memberId: string;
  subscriptionId: string;
  /** Nullable: checkout can create a member without one. */
  name: string | null;
  whatsappNumber: string;
  tierName: string;
  /** One of `active`, `past_due`, `churned` — see `listMembersForCreator`. */
  status: string;
  joinedAt: Date;
  /** A calendar date (`YYYY-MM-DD`), or null when there is no next period. */
  nextBillingDate: string | null;
}

/** Keyed on `(member.joined_at, subscription.id)`. See `KeysetCursor`. */
export interface MemberPageRequest {
  limit: number;
  before?: KeysetCursor;
}

export interface AnalyticsRepositoryPort {
  /**
   * Every figure the dashboard's overview screen shows, or `null` when
   * `creatorId` does not own `communityId` (including when it does not exist).
   */
  getMetricsForCreator(communityId: string, creatorId: string): Promise<CommunityMetrics | null>;

  /**
   * One page of the activity feed, newest first, filtered to
   * `CREATOR_VISIBLE_EVENTS` — or `null` when `creatorId` does not own
   * `communityId`.
   *
   * `null` and `[]` MEAN DIFFERENT THINGS and callers must keep them apart: `null`
   * is "not your community" and becomes a 404, `[]` is "you have reached the end"
   * and must not turn the last "load more" click into one.
   */
  listActivityForCreator(
    communityId: string,
    creatorId: string,
    page: ActivityPageRequest
  ): Promise<ActivityLogRow[] | null>;

  /**
   * One page of the member roster, most recently joined first — or `null` when
   * `creatorId` does not own `communityId`.
   *
   * Includes EXACTLY the three subscription statuses the metrics report (`active`,
   * `past_due`, `churned`) so the roster and the counts cannot disagree: a creator
   * who counts the rows gets the numbers on the overview screen. `pending` is an
   * unpaid checkout — a name and a phone number belonging to somebody who never
   * bought anything, which has no business on an exported contact list — `cancelled`
   * never activated, and `superseded` is a duplicate folded into an existing
   * membership rather than a person.
   *
   * `null` and `[]` mean different things, as above.
   */
  listMembersForCreator(
    communityId: string,
    creatorId: string,
    page: MemberPageRequest
  ): Promise<MemberRosterRow[] | null>;
}
