import { and, asc, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import {
  activityLogs,
  communities,
  members,
  membershipTiers,
  subscriptions,
  transactions,
} from "../../db/schema";
import { CREATOR_VISIBLE_EVENTS } from "../../domain/activity-feed";
import type {
  ActivityLogRow,
  ActivityPageRequest,
  AnalyticsRepositoryPort,
  MemberPageRequest,
  MemberRosterRow,
  CommunityMemberCounts,
  CommunityMetrics,
  TierDistributionEntry,
} from "../../application/ports/analytics-repository.port";

/**
 * The transaction status that means MONEY ARRIVED, and the only one that counts
 * toward revenue.
 *
 * Phase 5 leaves three other states in this table and none of them is income:
 * `pending` is an invoice nobody paid, `failed` a payment that did not go through,
 * and a `subscription_churned` settlement rolls the whole statement back — see
 * `DrizzleSubscriptionRepository.markPaid` — so what survives that path is a
 * `pending` row against a `churned` subscription. All three are excluded by this
 * one predicate, which is why the predicate is a constant rather than inline: a
 * creator seeing revenue they never received is worse than seeing none.
 */
const SUCCESSFUL_TRANSACTION = "success";

/** Subscription statuses the member counts report on, in the order they are reported. */
const ACTIVE_SUBSCRIPTION = "active";
const PAST_DUE_SUBSCRIPTION = "past_due";
const CHURNED_SUBSCRIPTION = "churned";

/**
 * The statuses that put somebody ON THE ROSTER, and they are the same three the
 * member counts report — on purpose, so a creator who counts the exported rows gets
 * the numbers on the overview screen. Two screens that disagree about how many
 * members a community has is a bug a creator finds and cannot explain.
 *
 * A non-empty tuple so `inArray` cannot be handed an empty list, which would match
 * nothing and empty every roster.
 */
const ROSTER_STATUSES: readonly [string, ...string[]] = [
  ACTIVE_SUBSCRIPTION,
  PAST_DUE_SUBSCRIPTION,
  CHURNED_SUBSCRIPTION,
];

/**
 * The creator dashboard's reads, all creator-scoped, none of them optional about
 * it. See `AnalyticsRepositoryPort` for why there is no unscoped variant.
 */
export class DrizzleAnalyticsRepository implements AnalyticsRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * THE SCOPING QUERY, and the only place `creatorId` is compared.
   *
   * Every aggregate below keys on `community_id` alone, which is sound BECAUSE
   * this ran first and returned a row: a community has exactly one owner, so
   * "this community's tiers" and "this creator's tiers in this community" are the
   * same set. Doing it in one place rather than repeating the join in four
   * aggregates means there is exactly one predicate to delete, and deleting it
   * fails `drizzle-analytics.repository.test.ts`'s scoping tests immediately —
   * mutation-checked, not assumed.
   *
   * Returns `null` for "not yours" and "does not exist" alike; the caller turns
   * both into the same 404 (see the port docstring).
   */
  private async findOwnedCommunity(
    communityId: string,
    creatorId: string
  ): Promise<{ id: string; slug: string } | null> {
    const [row] = await this.db
      .select({ id: communities.id, slug: communities.slug })
      .from(communities)
      .where(and(eq(communities.id, communityId), eq(communities.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async getMetricsForCreator(
    communityId: string,
    creatorId: string
  ): Promise<CommunityMetrics | null> {
    const community = await this.findOwnedCommunity(communityId, creatorId);
    if (!community) return null;

    const [members, grossRevenueAmount, tierDistribution] = await Promise.all([
      this.countMembers(community.id),
      this.sumGrossRevenue(community.id),
      this.distributionByTier(community.id),
    ]);

    return { members, grossRevenueAmount, tierDistribution };
  }

  /**
   * Member counts by subscription status, in ONE grouped query.
   *
   * A community's members are reached through its tiers — `subscription` has no
   * `community_id` — so the join is the scope. Statuses outside the three reported
   * ones are read and discarded rather than filtered in SQL, because the filter
   * would have to enumerate them anyway and an unrecognised status silently
   * vanishing is how `superseded` once read as a live membership.
   */
  private async countMembers(communityId: string): Promise<CommunityMemberCounts> {
    const rows = await this.db
      .select({ status: subscriptions.status, total: count() })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .where(eq(membershipTiers.communityId, communityId))
      .groupBy(subscriptions.status);

    const byStatus = new Map(rows.map((row) => [row.status, row.total]));
    return {
      active: byStatus.get(ACTIVE_SUBSCRIPTION) ?? 0,
      pastDue: byStatus.get(PAST_DUE_SUBSCRIPTION) ?? 0,
      churned: byStatus.get(CHURNED_SUBSCRIPTION) ?? 0,
    };
  }

  /**
   * Gross revenue: `sum(amount)` over this community's SUCCESSFUL transactions.
   *
   * `coalesce(..., 0)` because `sum` over no rows is NULL, and a brand-new
   * community must report 0 rather than null — Task 7 formats this into
   * `Rp 1.250.000`, and `Rp NaN` on a creator's first day reads as broken.
   *
   * `::bigint` then `Number`: Postgres widens `sum(integer)` to bigint, which the
   * driver hands back as a STRING, and a string here would concatenate rather
   * than add in every caller downstream. Safe for money because the column is an
   * INTEGER count of Rupiah — the sum is exact in Postgres, and
   * `Number.MAX_SAFE_INTEGER` is ~9 × 10^15 Rupiah, several thousand times
   * Indonesia's annual GDP. Never `parseFloat` on money.
   */
  private async sumGrossRevenue(communityId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${transactions.amount}), 0)::bigint`.mapWith(Number),
      })
      .from(transactions)
      .innerJoin(subscriptions, eq(transactions.subscriptionId, subscriptions.id))
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .where(
        and(
          eq(membershipTiers.communityId, communityId),
          eq(transactions.status, SUCCESSFUL_TRANSACTION)
        )
      );
    return row?.total ?? 0;
  }

  /**
   * Active members per tier, INCLUDING TIERS NOBODY HAS BOUGHT.
   *
   * A LEFT join, and the `status = 'active'` test is in the JOIN condition rather
   * than the WHERE clause — that difference is the whole feature. In a WHERE
   * clause it would discard the null-extended row a zero-member tier produces, and
   * the tier would silently disappear from the dashboard. A tier with no members
   * is exactly what a creator needs to see: it is either priced wrong or never
   * advertised, and hiding the row hides the problem.
   *
   * `count(subscriptions.id)` rather than `count()`: the latter counts the
   * null-extended row and reports 1 member for a tier that has none.
   *
   * Ordered by price then name then id so the dashboard's list is stable across
   * requests and two identically-priced, identically-named tiers still have a
   * fixed order.
   */
  private async distributionByTier(communityId: string): Promise<TierDistributionEntry[]> {
    return this.db
      .select({
        tierId: membershipTiers.id,
        tierName: membershipTiers.name,
        priceAmount: membershipTiers.priceAmount,
        activeMembers: count(subscriptions.id),
      })
      .from(membershipTiers)
      .leftJoin(
        subscriptions,
        and(
          eq(subscriptions.tierId, membershipTiers.id),
          eq(subscriptions.status, ACTIVE_SUBSCRIPTION)
        )
      )
      .where(eq(membershipTiers.communityId, communityId))
      .groupBy(membershipTiers.id, membershipTiers.name, membershipTiers.priceAmount)
      .orderBy(asc(membershipTiers.priceAmount), asc(membershipTiers.name), asc(membershipTiers.id));
  }

  /**
   * One page of the activity feed: this community's creator-facing events, newest
   * first, windowed by a `(created_at, id)` keyset cursor.
   *
   * READS THROUGH `activity_log_community_created_idx` — `(community_id,
   * created_at)`, and NOT the wider `(community_id, event_type, created_at)` that an
   * earlier version of this comment named. Getting that wrong here is how the next
   * person removes the index the feed actually depends on, so state it precisely:
   * one equality on `community_id`, then `created_at` as both the keyset range and
   * the sort key, which Postgres serves as an Index Scan Backward that STOPS after
   * one page (0.12 ms / 5 buffers, against 15 ms / 1277 with only the single-column
   * indexes).
   *
   * The `event_type in (…)` allowlist below is a FILTER on the ~26 rows a page
   * touches, not something an index leads with. A composite index carrying
   * `event_type` in the middle cannot help it at all — a btree with a ScalarArrayOp
   * on a middle column cannot deliver rows ordered by the trailing one — and the one
   * that used to exist made this query 145 ms / 3676 buffers by luring the planner
   * into a bitmap scan. It was dropped in migration 0015; the measurements and the
   * full reasoning are in `db/schema.ts` above `activity_log`'s index list.
   *
   * THE ALLOWLIST IS IN THE SQL, not applied afterwards, and that matters for more
   * than tidiness: filtering in JS would make `limit` count HIDDEN rows, so a
   * community whose recent history is all diagnostics would return a page of two
   * entries — or none — and the reader would conclude the feed had ended.
   *
   * THE TIE-BREAKING PREDICATE is the reason this is a keyset and not a
   * `created_at < cursor`. `created_at` defaults to `now()`, the TRANSACTION
   * timestamp, so rows written together share it exactly; `<` alone drops the
   * boundary row's ties and `<=` repeats them. `(created_at, id) < (cursor, id)`
   * expanded into `or(lt(created_at), and(eq(created_at), lt(id)))` is strictly
   * ordered, so a page boundary may fall anywhere — including in the middle of a
   * group of rows sharing one timestamp.
   */
  async listActivityForCreator(
    communityId: string,
    creatorId: string,
    page: ActivityPageRequest
  ): Promise<ActivityLogRow[] | null> {
    const community = await this.findOwnedCommunity(communityId, creatorId);
    if (!community) return null;

    const before = page.before;
    const keyset =
      before === undefined
        ? undefined
        : or(
            lt(activityLogs.createdAt, before.timestamp),
            and(eq(activityLogs.createdAt, before.timestamp), lt(activityLogs.id, before.id))
          );

    return this.db
      .select({
        id: activityLogs.id,
        eventType: activityLogs.eventType,
        metadata: activityLogs.metadata,
        createdAt: activityLogs.createdAt,
        memberId: activityLogs.memberId,
        // A LEFT join: `activity_log.member_id` is nullable (community-scoped
        // events have no member), and an inner join would silently drop those rows.
        // Only the NAME is selected — never `member.whatsapp_number`, which has one
        // legitimate destination in this product and it is not a screen left open
        // all day.
        memberName: members.name,
      })
      .from(activityLogs)
      .leftJoin(members, eq(activityLogs.memberId, members.id))
      .where(
        and(
          eq(activityLogs.communityId, community.id),
          inArray(activityLogs.eventType, [...CREATOR_VISIBLE_EVENTS]),
          ...(keyset === undefined ? [] : [keyset])
        )
      )
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(page.limit);
  }

  /**
   * One page of the member roster, most recently joined first.
   *
   * ORDERED AND WINDOWED ON `(member.joined_at, subscription.id)`. The subscription
   * id is the tiebreaker and NOT the member id, for two independent reasons: a member
   * may hold subscriptions to two tiers of one community, so `member.id` repeats; and
   * `member.joined_at` defaults to `now()` — the TRANSACTION timestamp — so several
   * members created together share it exactly. Either alone would make a
   * timestamp-only cursor drop or repeat rows at a page boundary.
   *
   * `inArray(status, ROSTER_STATUSES)` is IN THE SQL rather than applied afterwards,
   * for the same reason the activity feed's allowlist is: filtering in JS would make
   * `limit` count rows that are never returned, so a community with many abandoned
   * checkouts would hand back a short page and the reader would take it for the end
   * of the roster.
   */
  async listMembersForCreator(
    communityId: string,
    creatorId: string,
    page: MemberPageRequest
  ): Promise<MemberRosterRow[] | null> {
    const community = await this.findOwnedCommunity(communityId, creatorId);
    if (!community) return null;

    const before = page.before;
    const keyset =
      before === undefined
        ? undefined
        : or(
            lt(members.joinedAt, before.timestamp),
            and(eq(members.joinedAt, before.timestamp), lt(subscriptions.id, before.id))
          );

    return this.db
      .select({
        memberId: members.id,
        subscriptionId: subscriptions.id,
        name: members.name,
        whatsappNumber: members.whatsappNumber,
        tierName: membershipTiers.name,
        status: subscriptions.status,
        joinedAt: members.joinedAt,
        nextBillingDate: subscriptions.nextBillingDate,
      })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .innerJoin(members, eq(subscriptions.memberId, members.id))
      .where(
        and(
          eq(membershipTiers.communityId, community.id),
          inArray(subscriptions.status, [...ROSTER_STATUSES]),
          ...(keyset === undefined ? [] : [keyset])
        )
      )
      .orderBy(desc(members.joinedAt), desc(subscriptions.id))
      .limit(page.limit);
  }
}
