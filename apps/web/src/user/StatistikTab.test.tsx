import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import StatistikTab from "./StatistikTab";
import type { CommunityStats } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / arrays of strings.
 */

const NOW = new Date("2026-09-15T09:00:00.000Z");

function someStats(overrides: Partial<CommunityStats> = {}): CommunityStats {
  return {
    totalRevenue: 250_000,
    memberCount: 42,
    newMembersThisMonth: 7,
    paymentSuccessRate: 0.75,
    churnRate: 0.2,
    revenueByMonth: [
      { month: "2026-04", amount: 0 },
      { month: "2026-05", amount: 50_000 },
      { month: "2026-06", amount: 0 },
      { month: "2026-07", amount: 100_000 },
      { month: "2026-08", amount: 0 },
      { month: "2026-09", amount: 100_000 },
    ],
    tierDistribution: [
      { tierId: "t1", name: "Premium", subscriberCount: 3 },
      { tierId: "t2", name: "Sepi", subscriberCount: 0 },
    ],
    recentMembers: [
      {
        handle: "rina",
        displayName: "Rina",
        joinedAt: "2026-09-14T09:00:00.000Z",
        standing: "member",
      },
      {
        handle: "budi",
        displayName: "Budi",
        joinedAt: "2026-09-13T09:00:00.000Z",
        standing: "none",
      },
    ],
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function stubFetch(stats: CommunityStats | null = someStats(), status = 200): void {
  global.fetch = mock(async () =>
    new Response(JSON.stringify(status === 200 ? stats : { error: "nope" }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

function renderTab() {
  return render(
    <MemoryRouter>
      <StatistikTab slug="kelas-fisika" now={NOW} />
    </MemoryRouter>
  );
}

describe("StatistikTab", () => {
  it("shows the headline numbers", async () => {
    stubFetch();
    renderTab();

    await screen.findByText("Pendapatan");
    expect(screen.getByText(/250\.000/).textContent).toContain("250.000");
    expect(screen.getByText("42").textContent).toBe("42");
    expect(screen.getByText("75,0%").textContent).toBe("75,0%");
  });

  /**
   * **The rule this phase turns on.** A brand-new community has no success
   * rate and no churn rate; rendering `0,0%` would tell its owner every
   * payment is failing and nobody has ever left.
   */
  it("renders an em dash for a null rate, never 0%", async () => {
    stubFetch(someStats({ paymentSuccessRate: null, churnRate: null }));
    renderTab();

    await screen.findByText("Pendapatan");
    expect(screen.getAllByText("—").length).toBe(2);
    expect(screen.queryAllByText("0,0%").length).toBe(0);
  });

  it("renders a genuine zero rate as 0,0%, which is a measurement", async () => {
    stubFetch(someStats({ paymentSuccessRate: 0, churnRate: 0 }));
    renderTab();

    await screen.findByText("Pendapatan");
    expect(screen.getAllByText("0,0%").length).toBe(2);
    expect(screen.queryAllByText("—").length).toBe(0);
  });

  /** "Churn" without a period is a number nobody can act on. */
  it("says which churn it is measuring", async () => {
    stubFetch();
    renderTab();

    await screen.findByText(/sepanjang waktu/);
  });

  it("renders every month of the series, zero months included", async () => {
    stubFetch();
    renderTab();

    await screen.findByText(/Pendapatan 6 bulan/);
    // The TABLE is the non-visual reading of the same numbers, and is what a
    // screen reader gets — the bars carry aria-hidden.
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(6);
  });

  /**
   * Six zero-height bars look like a rendering failure. A sentence is honest
   * about there being nothing yet.
   */
  it("says so rather than drawing an empty chart when nothing was earned", async () => {
    stubFetch(
      someStats({
        revenueByMonth: someStats().revenueByMonth.map((point) => ({ ...point, amount: 0 })),
      })
    );
    renderTab();

    await screen.findByText(/Belum ada pendapatan/);
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("shows a tier nobody has bought", async () => {
    stubFetch();
    renderTab();

    // An owner needs to see the tier that is not selling; hiding it is what an
    // INNER join would have done.
    await screen.findByText("Sepi");
    expect(screen.getByText("0").textContent).toBe("0");
  });

  it("labels a member with no subscription as free, not inactive", async () => {
    stubFetch();
    renderTab();

    await screen.findByText("Budi");
    // Joining is free, so this is the common case and a perfectly real member.
    expect(screen.getByText(/gratis/).textContent).toContain("gratis");
  });

  it("a failed load shows an error, not an empty dashboard", async () => {
    stubFetch(null, 500);
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText("Pendapatan").length).toBe(0);
  });
});
