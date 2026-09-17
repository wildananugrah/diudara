import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { communityMembers, payments, subscriptions, tiers, users } from "../db/schema.ts";
import type { CreatorStats, DocumentRepository, StatsRepository } from "../../domain/ports.ts";

const TIER_COLORS = ["var(--kabut)", "var(--langit)", "var(--sinyal)"];

/**
 * Every figure here is derived by SQL from real rows. The two that could not be
 * derived from the original mock without inventing a source are handled as:
 *   - successRate    -> failed payments are persisted, so paid/(paid+failed) is real
 *   - topDocuments   -> document_downloads table exists, so the count is real
 * See SPEC.md §6.3 for what remains genuinely fabricated (the hardcoded JSX deltas).
 */
export class DrizzleStatsRepository implements StatsRepository {
  constructor(private readonly db: Db, private readonly documents: DocumentRepository) {}

  async forCommunity(communityId: string): Promise<CreatorStats> {
    const [summary] = await this.db.select({
      totalMembers: sql<number>`COUNT(*) FILTER (WHERE ${communityMembers.status} = 'active')::int`,
      newThisMonth: sql<number>`COUNT(*) FILTER (
        WHERE ${communityMembers.status} = 'active'
          AND ${communityMembers.joinedAt} >= date_trunc('month', NOW())
      )::int`,
      churned: sql<number>`COUNT(*) FILTER (WHERE ${communityMembers.status} = 'churned')::int`,
      total: sql<number>`COUNT(*)::int`,
    }).from(communityMembers).where(eq(communityMembers.communityId, communityId));

    const [revenue] = await this.db.select({
      totalRevenue: sql<number>`COALESCE(SUM(${payments.amountCents}) FILTER (WHERE ${payments.status} = 'paid'), 0)::bigint`,
      paid: sql<number>`COUNT(*) FILTER (WHERE ${payments.status} = 'paid')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${payments.status} = 'failed')::int`,
    })
      .from(payments)
      .innerJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
      .where(eq(subscriptions.communityId, communityId));

    const revenueByMonth = await this.db.select({
      month: sql<string>`to_char(${payments.paidAt}, 'Mon')`,
      monthKey: sql<string>`to_char(${payments.paidAt}, 'YYYY-MM')`,
      value: sql<number>`(SUM(${payments.amountCents}) / 100000)::int`,
    })
      .from(payments)
      .innerJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
      .where(and(
        eq(subscriptions.communityId, communityId),
        eq(payments.status, "paid"),
        sql`${payments.paidAt} >= date_trunc('month', NOW()) - INTERVAL '5 months'`,
      ))
      .groupBy(sql`to_char(${payments.paidAt}, 'Mon')`, sql`to_char(${payments.paidAt}, 'YYYY-MM')`)
      .orderBy(asc(sql`to_char(${payments.paidAt}, 'YYYY-MM')`));

    const tierRows = await this.db.select({
      name: tiers.name,
      n: sql<number>`COUNT(${communityMembers.userId})::int`,
      sortOrder: tiers.sortOrder,
    })
      .from(tiers)
      .leftJoin(communityMembers, and(
        eq(communityMembers.tierId, tiers.id),
        eq(communityMembers.status, "active"),
      ))
      .where(eq(tiers.communityId, communityId))
      .groupBy(tiers.id, tiers.name, tiers.sortOrder)
      .orderBy(asc(tiers.sortOrder));

    const tierTotal = tierRows.reduce((sum, r) => sum + r.n, 0);

    const recentMembers = await this.db.select({
      name: users.name, status: communityMembers.status,
      joined: communityMembers.joinedAt, endedAt: communityMembers.endedAt,
    })
      .from(communityMembers)
      .innerJoin(users, eq(users.id, communityMembers.userId))
      .where(eq(communityMembers.communityId, communityId))
      .orderBy(desc(communityMembers.joinedAt))
      .limit(5);

    // activityLog is assembled from the same rows the other figures come from —
    // joins and payment outcomes — rather than a separate audit table.
    const joinActivity = recentMembers.map((m) => ({
      name: m.name,
      action: m.status === "churned" ? "keluar dari komunitas (churn)" : "bergabung sebagai member",
      time: m.status === "churned" ? (m.endedAt ?? m.joined) : m.joined,
      type: m.status === "churned" ? "churn" : "join",
    }));

    const paymentActivity = await this.db.select({
      name: users.name, status: payments.status, time: payments.createdAt,
    })
      .from(payments)
      .innerJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(eq(subscriptions.communityId, communityId))
      .orderBy(desc(payments.createdAt))
      .limit(5);

    const activityLog = [
      ...joinActivity,
      ...paymentActivity.map((p) => ({
        name: p.name,
        action: p.status === "failed" ? "gagal pembayaran recurring" : "pembayaran berhasil",
        time: p.time,
        type: p.status === "failed" ? "failed" : "purchase",
      })),
    ].sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 6);

    const attempted = (revenue?.paid ?? 0) + (revenue?.failed ?? 0);

    return {
      salesSummary: {
        totalRevenue: Number(revenue?.totalRevenue ?? 0),
        totalMembers: summary?.totalMembers ?? 0,
        newMembersThisMonth: summary?.newThisMonth ?? 0,
        churnRate: summary?.total ? ((summary.churned / summary.total) * 100) : 0,
        successRate: attempted ? (((revenue?.paid ?? 0) / attempted) * 100) : 0,
      },
      revenueByMonth: revenueByMonth.map((r) => ({ month: r.month, value: r.value })),
      tierDistribution: tierRows.map((r, i) => ({
        name: r.name,
        pct: tierTotal ? Math.round((r.n / tierTotal) * 100) : 0,
        color: TIER_COLORS[i % TIER_COLORS.length]!,
      })),
      activityLog,
      recentMembers: recentMembers.map((m) => ({ name: m.name, status: m.status, joined: m.joined })),
      topDocuments: await this.documents.topDownloaded(communityId, 3),
    };
  }
}
