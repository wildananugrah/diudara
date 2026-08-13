import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import CommunityOverviewPage from "./CommunityOverviewPage";
import { renderPage, stubFetch, TEST_COMMUNITY, type StubRoute } from "../testing";

const METRICS_PATH = `/communities/${TEST_COMMUNITY.id}/metrics`;

/** `CommunityMetrics` as `GET /communities/:id/metrics` sends it. */
const METRICS = {
  members: { active: 12, pastDue: 3, churned: 5 },
  grossRevenueAmount: 1250000,
  tierDistribution: [
    { tierId: "t1", tierName: "Paket Bulanan", priceAmount: 50000, activeMembers: 12 },
    // A tier NOBODY BOUGHT is exactly what a creator needs to see.
    { tierId: "t2", tierName: "Paket Tahunan", priceAmount: 500000, activeMembers: 0 },
  ],
};

const COMMUNITY_PATH = `/communities/${TEST_COMMUNITY.id}`;

/** Every overview render also loads the metrics, so every stub set needs them. */
function stub(routes: StubRoute[] = []) {
  return stubFetch([
    { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
    { path: METRICS_PATH, body: METRICS },
    ...routes,
  ]);
}

function render() {
  return renderPage(<CommunityOverviewPage />, {
    path: "/dashboard/c/:communityId",
    at: `/dashboard/c/${TEST_COMMUNITY.id}`,
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("CommunityOverviewPage", () => {
  it("shows the community's name and its status with what the status MEANS", async () => {
    stub();

    render();

    expect(await screen.findByText("Kelas Bimbel Budi")).toBeTruthy();
    expect(screen.getByTestId("status-explanation").textContent).toMatch(/bisa dibeli|menerima pembayaran/);
  });

  it("explains a paused community keeps its checkout page but refuses purchases", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: { ...TEST_COMMUNITY, status: "paused" } },
      { path: METRICS_PATH, body: METRICS },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    const explanation = screen.getByTestId("status-explanation").textContent ?? "";
    expect(explanation).toMatch(/tetap terbuka|tetap tampil/);
    expect(explanation).toMatch(/ditolak|tidak bisa membeli/);
  });

  it("explains an archived community's page is gone", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: { ...TEST_COMMUNITY, status: "archived" } },
      { path: METRICS_PATH, body: METRICS },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect(screen.getByTestId("status-explanation").textContent).toMatch(/tidak dapat dibuka|404|hilang/);
  });

  it("shows the public checkout link in full and copyable", async () => {
    stub();

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect(screen.getByText(new RegExp("/c/kelas-bimbel-budi"))).toBeTruthy();
    expect(screen.getByRole("button", { name: /Salin/ })).toBeTruthy();
  });

  it("changes the status with a PATCH", async () => {
    const stubbed = stub([
      { method: "PATCH", path: `/communities/${TEST_COMMUNITY.id}`, body: { ...TEST_COMMUNITY, status: "paused" } },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "paused" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan status" }));

    await waitFor(() => expect(stubbed.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = stubbed.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/communities/${TEST_COMMUNITY.id}`);
    expect(patch.body).toEqual({ status: "paused" });
    expect((await screen.findByTestId("status-explanation")).textContent).toMatch(/tetap terbuka|tetap tampil/);
  });

  it("renders a 409 on a slug rename inline, keeping the slug the creator typed", async () => {
    stub([
      {
        method: "PATCH",
        path: `/communities/${TEST_COMMUNITY.id}`,
        status: 409,
        body: { error: "slug is already taken" },
      },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.change(screen.getByLabelText(/Alamat tautan/), { target: { value: "kelas-sore" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan tautan" }));

    expect(await screen.findByText(/sudah dipakai/)).toBeTruthy();
    expect((screen.getByLabelText(/Alamat tautan/) as HTMLInputElement).value).toBe("kelas-sore");
  });

  it("says the community was not found when the id is not one of the creator's", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, status: 404, body: { error: "community not found" } },
    ]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });

  it("links to the community's other screens", async () => {
    stub();

    render();
    await screen.findByText("Kelas Bimbel Budi");

    for (const label of ["Ringkasan", "Paket", "Grup", "Anggota", "Aktivitas"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------- metrics

  it("LABELS REVENUE AS GROSS and says the platform fee comes out of it first", async () => {
    stub();

    render();

    const revenue = await screen.findByTestId("metric-gross-revenue");
    expect(revenue.textContent).toMatch(/Rp 1\.250\.000/);
    // "Pendapatan" alone would be a claim about what the creator RECEIVED, and
    // Xendit's split rule takes DIUDARA's fee before any of it reaches them.
    expect(revenue.textContent).toMatch(/kotor|bruto/i);
    expect(revenue.textContent).toMatch(/biaya platform|potong/i);
  });

  it("never presents the gross figure as the creator's own earnings", async () => {
    stub();

    render();
    await screen.findByTestId("metric-gross-revenue");

    expect(screen.queryAllByText(/Pendapatan Anda/i).length).toBe(0);
    expect(screen.queryAllByText(/Penghasilan bersih/i).length).toBe(0);
  });

  it("shows the three member figures SEPARATELY, each with what it means", async () => {
    stub();

    render();

    expect((await screen.findByTestId("metric-active")).textContent).toMatch(/12/);
    expect(screen.getByTestId("metric-past-due").textContent).toMatch(/3/);
    expect(screen.getByTestId("metric-churned").textContent).toMatch(/5/);

    // The non-obvious one: past-due members are still inside the group.
    expect(screen.getByTestId("metric-past-due").textContent).toMatch(
      /MASIH punya akses|masih punya akses/
    );
    expect(screen.getByTestId("metric-active").textContent).toMatch(/akses grup aktif|lancar/i);
    expect(screen.getByTestId("metric-churned").textContent).toMatch(/dicabut/);
  });

  it("answers 'how many people can see my group' as active + past due", async () => {
    stub();

    render();

    // 12 active + 3 past due. Different question from "who is paid up", which is 12.
    expect((await screen.findByTestId("metric-with-access")).textContent).toMatch(/15/);
  });

  it("lists the tier distribution INCLUDING tiers nobody has bought", async () => {
    stub();

    render();

    await screen.findByTestId("tier-distribution");
    expect(screen.getByText("Paket Tahunan")).toBeTruthy();
    const zeroRow = screen.getByTestId("tier-row-t2");
    expect(zeroRow.textContent).toMatch(/0/);
    expect(zeroRow.textContent).toMatch(/Rp 500\.000/);
  });

  it("shows an empty state for the tier distribution when there are no tiers", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
      { path: METRICS_PATH, body: { ...METRICS, tierDistribution: [] } },
    ]);

    render();

    expect(await screen.findByText(/Belum ada paket/)).toBeTruthy();
  });

  it("shows a day-one empty state instead of a wall of zeroes for a brand-new community", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
      {
        path: METRICS_PATH,
        body: {
          members: { active: 0, pastDue: 0, churned: 0 },
          grossRevenueAmount: 0,
          tierDistribution: [],
        },
      },
    ]);

    render();

    expect(await screen.findByTestId("metrics-empty")).toBeTruthy();
    expect(screen.getByTestId("metrics-empty").textContent).toMatch(/sebarkan|tautan checkout/i);
  });

  it("still lists the tiers on a day-one community, so a new creator sees what they defined", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
      {
        path: METRICS_PATH,
        body: {
          members: { active: 0, pastDue: 0, churned: 0 },
          grossRevenueAmount: 0,
          // Tiers defined, nobody has bought one yet — the most common day-two state.
          tierDistribution: METRICS.tierDistribution.map((t) => ({ ...t, activeMembers: 0 })),
        },
      },
    ]);

    render();

    expect(await screen.findByTestId("metrics-empty")).toBeTruthy();
    expect(screen.getByTestId("tier-row-t1")).toBeTruthy();
    expect(screen.getByTestId("tier-row-t2")).toBeTruthy();
  });

  it("renders a failed metrics load with a retry rather than a blank panel", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: TEST_COMMUNITY },
      { path: METRICS_PATH, status: 500, body: { error: "boom" } },
    ]);

    render();

    expect(await screen.findByText(/Gagal memuat data/)).toBeTruthy();
    // The rest of the screen still works — a broken metrics panel must not take
    // the checkout link and the settings form down with it.
    expect(screen.getByText("Kelas Bimbel Budi")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Simpan status" })).toBeTruthy();
  });
});

/**
 * Task 8 (the phase gate) found the free-communities feature UNREACHABLE from
 * the product's own UI: `accessMode` was wired end to end through the API
 * (Task 2), read by the public checkout page (Task 6) and by the owner's
 * join-request queue (Task 7) — but NOTHING in `apps/web` ever WROTE it. The
 * create form takes only a name and a niche, and this settings card offered
 * only Status and Slug, so no creator could put a community into `request`
 * mode and the whole phase was dead code behind a column nobody could set.
 *
 * These tests pin the control that closes that gap.
 */
describe("CommunityOverviewPage — access mode (free communities, Task 8)", () => {
  it("shows the community's current access mode", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: { ...TEST_COMMUNITY, accessMode: "request" } },
      { path: METRICS_PATH, body: METRICS },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect((screen.getByLabelText("Cara bergabung") as HTMLSelectElement).value).toBe("request");
  });

  it("switches a paid community to request mode with a PATCH", async () => {
    const stubbed = stub([
      {
        method: "PATCH",
        path: `/communities/${TEST_COMMUNITY.id}`,
        body: { ...TEST_COMMUNITY, accessMode: "request" },
      },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.change(screen.getByLabelText("Cara bergabung"), { target: { value: "request" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan cara bergabung" }));

    await waitFor(() => expect(stubbed.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = stubbed.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/communities/${TEST_COMMUNITY.id}`);
    // ONLY the field being changed, never the whole record — the same
    // discipline `StatusForm` and `SlugForm` already follow.
    expect(patch.body).toEqual({ accessMode: "request" });
  });

  it("says what each mode MEANS, not just its name", async () => {
    stub();

    render();
    await screen.findByText("Kelas Bimbel Budi");

    const explanation = screen.getByTestId("access-mode-explanation").textContent ?? "";
    expect(explanation).toMatch(/membayar|dibeli/);

    fireEvent.change(screen.getByLabelText("Cara bergabung"), { target: { value: "request" } });

    const next = screen.getByTestId("access-mode-explanation").textContent ?? "";
    expect(next).toMatch(/menyetujui|persetujuan|permintaan/);
    expect(next).not.toBe(explanation);
  });

  it("renders the 409 a payments-disabled server answers with, in Indonesian", async () => {
    stubFetch([
      { path: COMMUNITY_PATH, body: { ...TEST_COMMUNITY, accessMode: "request" } },
      { path: METRICS_PATH, body: METRICS },
      {
        method: "PATCH",
        path: `/communities/${TEST_COMMUNITY.id}`,
        status: 409,
        body: {
          error:
            "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat",
        },
      },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.change(screen.getByLabelText("Cara bergabung"), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan cara bergabung" }));

    expect(await screen.findByText(/pembayaran belum dikonfigurasi/)).toBeTruthy();
    // The creator's choice is NOT reverted: they have to change something to
    // get past this, and resetting the select hides what they just tried.
    expect((screen.getByLabelText("Cara bergabung") as HTMLSelectElement).value).toBe("paid");
  });
});
