import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type { CommunityStatsRepositoryPort } from "../ports/community-stats-repository.port";
import { GetCommunityStats } from "./community-stats";

const COMMUNITY_ID = "cccccccc-0000-4000-8000-000000000000";
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const MEMBER_ID = "11111111-0000-4000-8000-000000000000";

/** 15 September 2026, 16:00 WIB. */
const NOW = new Date("2026-09-15T09:00:00.000Z");

function community(): CommunityRecord {
  return {
    id: COMMUNITY_ID,
    ownerId: OWNER_ID,
    slug: "kelas-fisika",
    name: "Kelas Fisika",
    category: "Akademik",
    description: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    tags: [],
  };
}

/**
 * Only the two methods this use case reaches are answered; the rest throw so
 * a future call site that starts using one is loud rather than silently
 * handed an empty answer — the shape `community-feed.test.ts` established.
 */
class FakeCommunities implements CommunityRepositoryPort {
  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return slug === "kelas-fisika" ? community() : null;
  }
  async memberCountFor(): Promise<number> {
    return 42;
  }
  private unused(): never {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<never> {
    return this.unused();
  }
  async isMember(): Promise<never> {
    return this.unused();
  }
  async create(): Promise<never> {
    return this.unused();
  }
  async browse(): Promise<never> {
    return this.unused();
  }
  async setTags(): Promise<never> {
    return this.unused();
  }
  async popularTags(): Promise<never> {
    return this.unused();
  }
  async join(): Promise<never> {
    return this.unused();
  }
  async leave(): Promise<never> {
    return this.unused();
  }
  async listMembers(): Promise<never> {
    return this.unused();
  }
  /** Phase 8b. Not reached by these tests — direct messages have their own suite. */
  async sharesCommunityWith() {
    return false;
  }
}

class FakeStats implements CommunityStatsRepositoryPort {
  revenue = 0;
  terminal = { paid: 0, expired: 0 };
  lifecycle = { everActive: 0, ended: 0 };
  byMonth = new Map<string, number>();
  tiers: { tierId: string; name: string; subscriberCount: number }[] = [];
  joined = 0;
  members: Awaited<ReturnType<CommunityStatsRepositoryPort["recentMembers"]>> = [];
  /** Records the span asked for, which is the whole point of the WIB tests. */
  spans: { from: Date; to: Date }[] = [];

  async totalRevenue(): Promise<number> {
    return this.revenue;
  }
  async terminalTransactionCounts() {
    return this.terminal;
  }
  async subscriptionLifecycleCounts() {
    return this.lifecycle;
  }
  async revenueByWibMonth(_id: string, from: Date, to: Date) {
    this.spans.push({ from, to });
    return this.byMonth;
  }
  async tierDistribution() {
    return this.tiers;
  }
  async membersJoinedBetween(_id: string, from: Date, to: Date) {
    this.spans.push({ from, to });
    return this.joined;
  }
  async recentMembers() {
    return this.members;
  }
}

function subject(now = NOW) {
  const stats = new FakeStats();
  const clock: ClockPort = { now: () => now };
  return {
    stats,
    useCase: new GetCommunityStats(
      new FakeCommunities(),
      stats,
      clock
    ),
  };
}

const asOwner = { slug: "kelas-fisika", viewerId: OWNER_ID };

describe("GetCommunityStats — access", () => {
  test("an unknown slug is NotFound", async () => {
    const { useCase } = subject();
    await expect(
      useCase.execute({ slug: "tidak-ada", viewerId: OWNER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * The one place this codebase's 404-not-403 rule reverses, deliberately:
   * the community's existence is already public, so there is nothing left to
   * conceal, and a 403 tells an owner signed into the wrong account what is
   * actually wrong.
   */
  test("a non-owner is Forbidden, not NotFound, and gets no numbers", async () => {
    const { useCase } = subject();

    const attempt = useCase.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.not.toBeInstanceOf(NotFoundError);
  });
});

describe("GetCommunityStats — the ratios", () => {
  test("the success rate counts paid over paid plus expired", async () => {
    const { stats, useCase } = subject();
    stats.terminal = { paid: 3, expired: 1 };

    expect((await useCase.execute(asOwner)).paymentSuccessRate).toBe(0.75);
  });

  /**
   * **`null`, never `0`.** A brand-new community has no success rate;
   * reporting zero would tell its owner every payment is failing, and
   * reporting zero churn would tell them nobody has ever left — one a lie,
   * the other meaningless.
   */
  test("both ratios are null on an empty denominator", async () => {
    const { useCase } = subject();

    const view = await useCase.execute(asOwner);

    expect(view.paymentSuccessRate).toBeNull();
    expect(view.churnRate).toBeNull();
  });

  test("a rate of genuinely zero is 0, not null", async () => {
    const { stats, useCase } = subject();
    // Every transaction expired: a real measurement of total failure, which
    // must be distinguishable from having no measurement at all.
    stats.terminal = { paid: 0, expired: 5 };
    stats.lifecycle = { everActive: 4, ended: 0 };

    const view = await useCase.execute(asOwner);

    expect(view.paymentSuccessRate).toBe(0);
    expect(view.churnRate).toBe(0);
  });

  test("churn is ended over ever-active", async () => {
    const { stats, useCase } = subject();
    stats.lifecycle = { everActive: 10, ended: 2 };

    expect((await useCase.execute(asOwner)).churnRate).toBe(0.2);
  });
});

describe("GetCommunityStats — the revenue series", () => {
  test("is six WIB months, oldest first, ending with now's", async () => {
    const { useCase } = subject();

    const view = await useCase.execute(asOwner);

    expect(view.revenueByMonth.map((point) => point.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  /**
   * A month simply missing from a chart reads as "unknown", not as "nothing
   * happened" — the difference between a quiet June and a broken one.
   */
  test("zero-fills a month with no revenue rather than dropping it", async () => {
    const { stats, useCase } = subject();
    stats.byMonth = new Map([["2026-09", 250_000]]);

    const view = await useCase.execute(asOwner);

    expect(view.revenueByMonth.length).toBe(6);
    expect(view.revenueByMonth.find((point) => point.month === "2026-06")!.amount).toBe(0);
    expect(view.revenueByMonth.find((point) => point.month === "2026-09")!.amount).toBe(250_000);
  });

  test("asks for the whole span in ONE query, not one per month", async () => {
    const { stats, useCase } = subject();

    await useCase.execute(asOwner);

    // One span for the series and one for this month's joiners — never six.
    expect(stats.spans.length).toBe(2);
  });

  /** At the boundary: 1 September 00:30 WIB is August in UTC. */
  test("takes the WIB month at midnight, so the series ends correctly", async () => {
    const { useCase } = subject(new Date("2026-08-31T17:30:00.000Z"));

    const view = await useCase.execute(asOwner);

    expect(view.revenueByMonth[view.revenueByMonth.length - 1]!.month).toBe("2026-09");
  });

  test("this month's joiners are counted over the WIB month", async () => {
    const { stats, useCase } = subject();
    stats.joined = 7;

    const view = await useCase.execute(asOwner);

    expect(view.newMembersThisMonth).toBe(7);
    const monthSpan = stats.spans.find(
      (span) => span.from.toISOString() === "2026-08-31T17:00:00.000Z"
    );
    expect(monthSpan?.to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });
});

describe("GetCommunityStats — the panels", () => {
  test("passes the tier distribution through as counts", async () => {
    const { stats, useCase } = subject();
    stats.tiers = [{ tierId: "t1", name: "Sepi", subscriberCount: 0 }];

    expect((await useCase.execute(asOwner)).tierDistribution).toEqual([
      { tierId: "t1", name: "Sepi", subscriberCount: 0 },
    ]);
  });

  test("decides each recent member's standing from the shared function", async () => {
    const { stats, useCase } = subject();
    stats.members = [
      {
        handle: "aktif",
        displayName: "Aktif",
        joinedAt: new Date("2026-09-10T00:00:00.000Z"),
        subscriptionStatus: "active",
        subscriptionKind: "paid",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      },
      {
        handle: "lewat",
        displayName: "Lewat",
        joinedAt: new Date("2026-09-09T00:00:00.000Z"),
        subscriptionStatus: "active",
        subscriptionKind: "paid",
        // Status still says active until the sweep retires it; the PERIOD is
        // what makes this lapsed, which is exactly what `membershipStanding`
        // is for.
        currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        handle: "gratis",
        displayName: "Gratis",
        joinedAt: new Date("2026-09-08T00:00:00.000Z"),
        subscriptionStatus: null,
        subscriptionKind: null,
        currentPeriodEnd: null,
      },
    ];

    const view = await useCase.execute(asOwner);

    expect(view.recentMembers.map((member) => [member.handle, member.standing])).toEqual([
      ["aktif", "member"],
      ["lewat", "lapsed"],
      // The COMMON case: joining is free, so most members hold no
      // subscription at all.
      ["gratis", "none"],
    ]);
  });

  test("the member count comes from the community, not from the sample", async () => {
    const { stats, useCase } = subject();
    stats.members = [];

    expect((await useCase.execute(asOwner)).memberCount).toBe(42);
  });
});
