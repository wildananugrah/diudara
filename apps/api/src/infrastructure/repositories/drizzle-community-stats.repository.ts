import { and, count, desc, eq, gte, inArray, lt, sql, sum } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import {
  appUsers,
  communityMembers,
  userSubscriptions,
  userTiers,
  userTransactions,
} from "../../db/schema";
import type { CommunityStatsRepositoryPort } from "../../application/ports/community-stats-repository.port";

/**
 * The WIB offset, spelled the same way `domain/wib-month.ts` spells it.
 * Grouping revenue by month has to happen in Postgres — six months of rows
 * summed in the app would mean reading every transaction — so the shift is
 * applied inside the query rather than by that module.
 */
const WIB_INTERVAL = sql`interval '7 hours'`;

export class DrizzleCommunityStatsRepository implements CommunityStatsRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Every query here joins `user_subscription` to reach the community, because
   * `user_transaction` has no community of its own — it hangs off the
   * subscription, which is where Phase 5's `community_id` lives.
   */
  async totalRevenue(communityId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(userTransactions.amount) })
      .from(userTransactions)
      .innerJoin(userSubscriptions, eq(userSubscriptions.id, userTransactions.userSubscriptionId))
      .where(
        and(
          eq(userSubscriptions.communityId, communityId),
          eq(userTransactions.status, "paid")
        )
      );
    // `SUM` over no rows is SQL NULL, not 0 — and drizzle hands sums back as
    // strings because a bigint can outrun a JS number. A community with no
    // revenue has zero revenue, which is a fact rather than an absence, so
    // this is the one ratio-adjacent number that is 0 rather than null.
    return Number(row?.total ?? 0);
  }

  async terminalTransactionCounts(
    communityId: string
  ): Promise<{ paid: number; expired: number }> {
    const rows = await this.db
      .select({ status: userTransactions.status, total: count() })
      .from(userTransactions)
      .innerJoin(userSubscriptions, eq(userSubscriptions.id, userTransactions.userSubscriptionId))
      .where(
        and(
          eq(userSubscriptions.communityId, communityId),
          // TERMINAL only. `pending` is excluded here rather than subtracted
          // later, so no caller can accidentally put it on either side.
          inArray(userTransactions.status, ["paid", "expired"])
        )
      )
      .groupBy(userTransactions.status);

    const by = new Map(rows.map((row) => [row.status, Number(row.total)]));
    return { paid: by.get("paid") ?? 0, expired: by.get("expired") ?? 0 };
  }

  async subscriptionLifecycleCounts(
    communityId: string
  ): Promise<{ everActive: number; ended: number }> {
    const rows = await this.db
      .select({ status: userSubscriptions.status, total: count() })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.communityId, communityId))
      .groupBy(userSubscriptions.status);

    const by = new Map(rows.map((row) => [row.status, Number(row.total)]));
    const ended = (by.get("cancelled") ?? 0) + (by.get("expired") ?? 0);
    // `pending` is excluded from BOTH sides: a subscription that never
    // activated never had a chance to churn, and counting it in the
    // denominator would flatter the rate.
    return { everActive: (by.get("active") ?? 0) + ended, ended };
  }

  async revenueByWibMonth(
    communityId: string,
    from: Date,
    to: Date
  ): Promise<Map<string, number>> {
    // Grouped on the WIB month, not the UTC one — the shift happens before
    // `date_trunc`, so a payment at 00:30 WIB on the 1st lands in the month
    // that owns it rather than the one before.
    const month = sql<string>`to_char(date_trunc('month', ${userTransactions.paidAt} + ${WIB_INTERVAL}), 'YYYY-MM')`;
    const rows = await this.db
      .select({ month, total: sum(userTransactions.amount) })
      .from(userTransactions)
      .innerJoin(userSubscriptions, eq(userSubscriptions.id, userTransactions.userSubscriptionId))
      .where(
        and(
          eq(userSubscriptions.communityId, communityId),
          eq(userTransactions.status, "paid"),
          // On `paid_at` and not `created_at`: an invoice raised in June and
          // settled in July is July's revenue.
          gte(userTransactions.paidAt, from),
          lt(userTransactions.paidAt, to)
        )
      )
      .groupBy(month);

    // SPARSE. Zero-filling is the use case's job, so "a gap means zero"
    // is decided in one place rather than half here and half there.
    return new Map(rows.map((row) => [row.month, Number(row.total ?? 0)]));
  }

  async tierDistribution(
    communityId: string
  ): Promise<{ tierId: string; name: string; subscriberCount: number }[]> {
    // LEFT JOIN so a tier nobody has bought still appears with a count of
    // zero — an owner needs to see the tier that is not selling, and an INNER
    // join would hide exactly that one. The `status = 'active'` predicate sits
    // in the JOIN's ON rather than the WHERE for the same reason: in the WHERE
    // it would filter those rows back out.
    const rows = await this.db
      .select({ tierId: userTiers.id, name: userTiers.name, subscriberCount: count(userSubscriptions.id) })
      .from(userTiers)
      .leftJoin(
        userSubscriptions,
        and(
          eq(userSubscriptions.tierId, userTiers.id),
          eq(userSubscriptions.status, "active")
        )
      )
      .where(eq(userTiers.communityId, communityId))
      .groupBy(userTiers.id, userTiers.name)
      .orderBy(userTiers.createdAt);

    return rows.map((row) => ({ ...row, subscriberCount: Number(row.subscriberCount) }));
  }

  /**
   * ONE query: members joined to their user row for the public fields, and
   * LEFT-joined to an ACTIVE subscription of THIS community for the standing.
   *
   * The subscription join is LEFT and its predicates sit in the ON rather
   * than the WHERE — a member with no subscription is the common case (joining
   * is free), and in the WHERE those predicates would filter exactly those
   * members out of their own roster.
   */
  async recentMembers(communityId: string, limit: number) {
    return this.db
      .select({
        handle: appUsers.handle,
        displayName: appUsers.displayName,
        joinedAt: communityMembers.joinedAt,
        subscriptionStatus: userSubscriptions.status,
        subscriptionKind: userSubscriptions.kind,
        currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      })
      .from(communityMembers)
      .innerJoin(appUsers, eq(appUsers.id, communityMembers.userId))
      .leftJoin(
        userSubscriptions,
        and(
          eq(userSubscriptions.subscriberId, communityMembers.userId),
          // Scoped to THIS community, never to the owner — the conflation
          // `findActiveForCommunity` exists to avoid, in its query form.
          eq(userSubscriptions.communityId, communityId),
          eq(userSubscriptions.status, "active")
        )
      )
      .where(eq(communityMembers.communityId, communityId))
      .orderBy(desc(communityMembers.joinedAt))
      .limit(limit);
  }

  async membersJoinedBetween(communityId: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          gte(communityMembers.joinedAt, from),
          lt(communityMembers.joinedAt, to)
        )
      );
    return Number(row?.total ?? 0);
  }
}
