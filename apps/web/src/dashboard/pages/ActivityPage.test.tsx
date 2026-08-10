import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import ActivityPage from "./ActivityPage";
import { renderPage, stubFetch, TEST_COMMUNITY, type StubRoute } from "../testing";

const FEED = `/communities/${TEST_COMMUNITY.id}/activity`;

/**
 * Entries as the API sends them: the label and the severity are decided in
 * `apps/api/src/domain/activity-feed.ts`, NOT here. This page renders what it is
 * given — which is also why `renewal_reminder_queued` never appears in any fixture:
 * the API's allowlist already drops it, and re-filtering here would be a second
 * place for that rule to drift.
 */
const JOINED = {
  id: "e1",
  eventType: "joined",
  label: "Anggota baru bergabung",
  severity: "info" as const,
  memberId: "m1",
  memberName: "Siti Rahayu",
  createdAt: "2026-08-09T04:00:00.000Z",
};

const REMINDER = {
  id: "e2",
  eventType: "renewal_reminder_sent",
  label: "Pengingat perpanjangan terkirim (jatuh tempo hari ini)",
  severity: "info" as const,
  memberId: "m1",
  memberName: "Siti Rahayu",
  createdAt: "2026-08-08T04:00:00.000Z",
};

const REVOCATION_MANUAL = {
  id: "e3",
  eventType: "revocation_manual_required",
  label: "PERLU TINDAKAN: anggota harus dikeluarkan dari grup secara manual",
  severity: "warning" as const,
  memberId: "m2",
  memberName: "Agus Pratama",
  createdAt: "2026-08-07T04:00:00.000Z",
};

const ACCESS_MANUAL = {
  id: "e4",
  eventType: "access_manual_required",
  label: "PERLU TINDAKAN: anggota harus ditambahkan ke grup secara manual",
  severity: "warning" as const,
  memberId: "m3",
  memberName: "Dewi Lestari",
  createdAt: "2026-08-06T04:00:00.000Z",
};

function render() {
  return renderPage(<ActivityPage />, {
    path: "/dashboard/c/:communityId/activity",
    at: `/dashboard/c/${TEST_COMMUNITY.id}/activity`,
  });
}

function stub(routes: StubRoute[]) {
  return stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }, ...routes]);
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  localStorage.setItem("diudara.dashboard.payments.creator-1", "connected");
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("ActivityPage", () => {
  it("renders the feed newest first, in the order the API sends", async () => {
    stub([{ path: FEED, body: { entries: [JOINED, REMINDER], nextCursor: null } }]);

    render();

    await screen.findByText("Anggota baru bergabung");
    const labels = screen.getAllByTestId("feed-label").map((n) => n.textContent);
    expect(labels).toEqual([
      "Anggota baru bergabung",
      "Pengingat perpanjangan terkirim (jatuh tempo hari ini)",
    ]);
  });

  it("shows one entry per reminder — it does not invent a second row", async () => {
    stub([{ path: FEED, body: { entries: [REMINDER], nextCursor: null } }]);

    render();

    await screen.findByText(/Pengingat perpanjangan terkirim/);
    expect(screen.getAllByTestId("feed-item")).toHaveLength(1);
  });

  it("RENDERS *_manual_required AS A WARNING, visually distinct from ordinary events", async () => {
    stub([{ path: FEED, body: { entries: [JOINED, REVOCATION_MANUAL], nextCursor: null } }]);

    render();
    await screen.findByText("Anggota baru bergabung");

    const items = screen.getAllByTestId("feed-item");
    const ordinary = items[0]!;
    const warning = items[1]!;

    expect(warning.className).toMatch(/feed-item-warning/);
    expect(ordinary.className).not.toMatch(/feed-item-warning/);
    // A creator must not scroll past it, so it is announced as well as coloured.
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toMatch(/PERLU TINDAKAN/);
  });

  it("treats access_manual_required as a warning too", async () => {
    stub([{ path: FEED, body: { entries: [ACCESS_MANUAL], nextCursor: null } }]);

    render();
    await screen.findByText(/ditambahkan ke grup secara manual/);

    expect(screen.getAllByTestId("feed-item")[0]!.className).toMatch(/feed-item-warning/);
  });

  it("summarises how many loaded entries need action, and says nothing when none do", async () => {
    stub([
      { path: FEED, body: { entries: [JOINED, REVOCATION_MANUAL, ACCESS_MANUAL], nextCursor: null } },
    ]);

    render();
    await screen.findByText("Anggota baru bergabung");

    expect(screen.getByTestId("action-required-summary").textContent).toMatch(/2/);
  });

  it("has no action-required banner when every loaded entry is ordinary", async () => {
    stub([{ path: FEED, body: { entries: [JOINED, REMINDER], nextCursor: null } }]);

    render();
    await screen.findByText("Anggota baru bergabung");

    expect(screen.queryAllByTestId("action-required-summary").length).toBe(0);
  });

  it("names the member an entry is about", async () => {
    stub([{ path: FEED, body: { entries: [JOINED], nextCursor: null } }]);

    render();

    expect(await screen.findByText(/Siti Rahayu/)).toBeTruthy();
  });

  it("shows an empty state that says what to do next when there is no activity", async () => {
    stub([{ path: FEED, body: { entries: [], nextCursor: null } }]);

    render();

    expect(await screen.findByText(/Belum ada aktivitas/)).toBeTruthy();
    expect(screen.getByText(/tautan checkout|sebarkan/i)).toBeTruthy();
  });

  it("loads the next page with the keyset cursor and APPENDS to the feed", async () => {
    const stubbed = stub([
      { path: FEED, body: { entries: [JOINED], nextCursor: "Y3Vyc29yLTI" } },
      {
        path: `${FEED}?limit=25&before=Y3Vyc29yLTI`,
        body: { entries: [REMINDER], nextCursor: null },
      },
    ]);

    render();
    await screen.findByText("Anggota baru bergabung");

    fireEvent.click(screen.getByRole("button", { name: /Muat lebih banyak/ }));

    expect(await screen.findByText(/Pengingat perpanjangan terkirim/)).toBeTruthy();
    expect(screen.getByText("Anggota baru bergabung")).toBeTruthy();
    expect(stubbed.calls.some((c) => c.url.includes("before=Y3Vyc29yLTI"))).toBe(true);
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: /Muat lebih banyak/ }).length).toBe(0)
    );
  });

  it("does not offer 'load more' when the first page is the last one", async () => {
    stub([{ path: FEED, body: { entries: [JOINED], nextCursor: null } }]);

    render();
    await screen.findByText("Anggota baru bergabung");

    expect(screen.queryAllByRole("button", { name: /Muat lebih banyak/ }).length).toBe(0);
  });

  it("renders a failed load with the reason and a retry, never a blank panel", async () => {
    stub([{ path: FEED, status: 500, body: { error: "boom" } }]);

    render();

    expect(await screen.findByText(/Gagal memuat data/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Coba lagi/ })).toBeTruthy();
  });

  it("says the community was not found when the id is not one of the creator's", async () => {
    stubFetch([{ path: "/communities", body: [] }]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });
});
