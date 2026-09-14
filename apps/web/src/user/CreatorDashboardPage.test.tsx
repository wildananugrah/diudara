import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CreatorDashboardPage from "./CreatorDashboardPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DETAIL = {
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: "Belajar desain dari nol.",
  memberCount: 4,
  tags: [],
  live: null,
  price: null,
  ownerHandle: "wildan",
  ownerDisplayName: "Wildan",
  viewerIsMember: true,
  viewerIsOwner: true,
  createdAt: "2026-02-01T00:00:00.000Z",
};

const STATS = {
  totalRevenue: 42850000,
  memberCount: 1240,
  newMembersThisMonth: 86,
  paymentSuccessRate: 0.946,
  churnRate: 0.032,
  revenueByMonth: [
    { month: "2026-04", amount: 28000000 },
    { month: "2026-05", amount: 34000000 },
  ],
  tierDistribution: [{ tierId: "t1", name: "Pro", subscriberCount: 10 }],
  recentMembers: [
    { handle: "sari", displayName: "Sari Wulandari", joinedAt: "2026-09-13T00:00:00.000Z", standing: "member" },
  ],
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function stubFetch(overrides: Partial<typeof DETAIL> = {}) {
  global.fetch = mock(async (url: string) => {
    if (url.includes("/stats")) return jsonResponse(STATS);
    return jsonResponse({ ...DETAIL, ...overrides });
  }) as unknown as typeof fetch;
}

function renderPage(initialEntry = "/komunitas/kelas-desain/dashboard") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/komunitas/:slug/dashboard" element={<CreatorDashboardPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("CreatorDashboardPage", () => {
  it("titles the page Dashboard Creator, subtitled with the community's name", async () => {
    stubFetch();
    renderPage();

    await screen.findByText("Dashboard Creator");
    expect(await screen.findByText("Ringkasan performa Kelas Desain")).toBeTruthy();
  });

  it("breadcrumbs through Komunitas and the community's own page", async () => {
    stubFetch();
    renderPage();

    await screen.findByText("Ringkasan performa Kelas Desain");
    const discoverCrumb = screen.getByRole("link", { name: "Komunitas" });
    expect(discoverCrumb.getAttribute("href")).toBe("/discover");
    const communityCrumb = screen.getByRole("link", { name: "Kelas Desain" });
    expect(communityCrumb.getAttribute("href")).toBe("/komunitas/kelas-desain");
  });

  it("shows the owner the real stats — the same panel the Statistik tab renders", async () => {
    stubFetch({ viewerIsOwner: true });
    renderPage();

    expect(await screen.findByText("Rp 42.850.000")).toBeTruthy();
    expect(screen.getByText("1240")).toBeTruthy();
  });

  it("tells a non-owner this is not their dashboard, and never asks for the stats", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (url.includes("/stats")) return jsonResponse(STATS);
      return jsonResponse({ ...DETAIL, viewerIsOwner: false });
    }) as unknown as typeof fetch;
    renderPage();

    expect(
      await screen.findByText("Hanya pemilik komunitas yang dapat melihat dashboard ini.")
    ).toBeTruthy();
    expect(calls.some((call) => call.includes("/stats"))).toBe(false);
  });

  it("renders the shared not-found page for a slug nobody holds", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "community not found" }, 404)
    ) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Halaman tidak ditemukan")).toBeTruthy();
  });
});
