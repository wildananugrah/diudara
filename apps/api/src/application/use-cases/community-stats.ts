import { ForbiddenError, NotFoundError } from "../errors";
import { lastWibMonths, wibMonthRange } from "../../domain/wib-month";
import type { ClockPort } from "../ports/clock.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { CommunityStatsRepositoryPort } from "../ports/community-stats-repository.port";
import { membershipStanding, type MembershipStanding } from "./is-member-of";

/** How many months the revenue series covers. Six, as the reference shows. */
const REVENUE_MONTHS = 6;

/** The five newest members. A sample, not a roster — `/members` is the roster. */
const RECENT_MEMBER_LIMIT = 5;

export interface CommunityStatsView {
  /** Whole rupiah. Formatting is the client's — `formatRupiah` owns it. */
  totalRevenue: number;
  memberCount: number;
  /** Joined inside the CURRENT WIB month. */
  newMembersThisMonth: number;
  /**
   * `paid / (paid + expired)` across TERMINAL transactions, 0–1.
   *
   * **`null` when there are none at all, never `0`.** A brand-new community
   * has no success rate; reporting `0` would tell its owner every payment is
   * failing.
   */
  paymentSuccessRate: number | null;
  /**
   * Ended subscriptions over every subscription that was ever active, 0–1.
   *
   * **LIFETIME churn, not monthly** — nothing records when a status changed,
   * only what it is now, so a monthly rate is not a number this data can
   * support. The client labels which one it is. `null` on an empty
   * denominator, same reason as above.
   */
  churnRate: number | null;
  /** The last six WIB months, oldest first, ZERO-FILLED. */
  revenueByMonth: { month: string; amount: number }[];
  /** Every tier, including ones nobody has bought. Counts, never percentages. */
  tierDistribution: { tierId: string; name: string; subscriberCount: number }[];
  recentMembers: {
    handle: string;
    displayName: string;
    joinedAt: string;
    standing: MembershipStanding;
  }[];
}

/**
 * `GET /communities/:slug/stats` — the owner's dashboard, in one response.
 *
 * ONE endpoint for four panels because it is one screen: four would be four
 * round trips and four chances to render half a dashboard. The panels are not
 * independently useful either — "revenue" without "over what period" is a
 * number nobody can act on.
 *
 * **OWNER ONLY, and a non-owner gets `ForbiddenError`, not `NotFoundError`.**
 * That reverses the rule the rest of this codebase follows, deliberately: a
 * 404 elsewhere hides whether something exists, but this community's
 * existence is already public — its page, feed and calendar are all open — so
 * there is nothing left to conceal, and a 403 tells an owner signed into the
 * wrong account what is actually wrong.
 */
export class GetCommunityStats {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly stats: CommunityStatsRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { slug: string; viewerId: string }): Promise<CommunityStatsView> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");
    if (community.ownerId !== input.viewerId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh melihat statistik");
    }

    const now = this.clock.now();
    const thisMonth = wibMonthRange(undefined, now);
    const months = lastWibMonths(now, REVENUE_MONTHS);
    // The whole span in ONE query: the first month's start to this month's
    // end. Six queries, one per month, would be six round trips for a chart.
    const span = wibMonthRange(months[0]!, now);

    const [revenue, terminal, lifecycle, byMonth, tiers, memberCount, joinedThisMonth, members] =
      await Promise.all([
        this.stats.totalRevenue(community.id),
        this.stats.terminalTransactionCounts(community.id),
        this.stats.subscriptionLifecycleCounts(community.id),
        this.stats.revenueByWibMonth(community.id, span.from, thisMonth.to),
        this.stats.tierDistribution(community.id),
        this.communities.memberCountFor(community.id),
        this.stats.membersJoinedBetween(community.id, thisMonth.from, thisMonth.to),
        this.stats.recentMembers(community.id, RECENT_MEMBER_LIMIT),
      ]);

    return {
      totalRevenue: revenue,
      memberCount,
      newMembersThisMonth: joinedThisMonth,
      paymentSuccessRate: ratio(terminal.paid, terminal.paid + terminal.expired),
      churnRate: ratio(lifecycle.ended, lifecycle.everActive),
      // ZERO-FILLED here, from the sparse map the repository returns. A month
      // simply missing from a chart reads as "unknown", not as "nothing
      // happened" — the difference between a quiet June and a broken one.
      revenueByMonth: months.map((month) => ({ month, amount: byMonth.get(month) ?? 0 })),
      tierDistribution: tiers,
      // Decided HERE from the raw lifecycle fields, through the same
      // `membershipStanding` the document gate and `IsMemberOf` use — so
      // "active" means exactly one thing across the app.
      recentMembers: members.map((member) => ({
        handle: member.handle,
        displayName: member.displayName,
        joinedAt: member.joinedAt.toISOString(),
        standing: membershipStanding(
          member.subscriptionStatus === null
            ? null
            : {
                id: "",
                subscriberId: "",
                tierId: "",
                ownerId: "",
                communityId: community.id,
                status: member.subscriptionStatus,
                kind: member.subscriptionKind ?? "paid",
                currentPeriodEnd: member.currentPeriodEnd,
                createdAt: now,
              },
          now
        ),
      })),
    };
  }

}

/**
 * `null` on an empty denominator, never `0`. The distinction is the whole
 * point: `0` is a measurement, `null` is the absence of one, and a dashboard
 * that confuses them tells a new owner their payments are all failing.
 */
function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}
