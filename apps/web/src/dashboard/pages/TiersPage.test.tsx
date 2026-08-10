import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import TiersPage from "./TiersPage";
import { renderPage, stubFetch, TEST_COMMUNITY } from "../testing";

const TIERS_PATH = `/communities/${TEST_COMMUNITY.id}/tiers`;

const BASIC = {
  id: "tier-1",
  communityId: TEST_COMMUNITY.id,
  name: "Basic",
  priceAmount: 1250000,
  billingCycle: "monthly",
  isActive: true,
};

function render() {
  return renderPage(<TiersPage />, {
    path: "/dashboard/c/:communityId/tiers",
    at: `/dashboard/c/${TEST_COMMUNITY.id}/tiers`,
  });
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

describe("TiersPage", () => {
  it("shows prices as integer Rupiah formatted for Indonesian readers", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [BASIC, { ...BASIC, id: "tier-2", name: "Pro", priceAmount: 50000, billingCycle: "yearly" }] },
    ]);

    render();

    // 1250000 -> "Rp 1.250.000". Never a float, never "Rp 1,250,000.00".
    expect(await screen.findByText("Rp 1.250.000")).toBeTruthy();
    expect(screen.getByText("Rp 50.000")).toBeTruthy();
    expect(screen.getByText(/per bulan/)).toBeTruthy();
    expect(screen.getByText(/per tahun/)).toBeTruthy();
  });

  it("shows an empty state that says what to do next when there are no tiers", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [] },
    ]);

    render();

    expect(await screen.findByText(/Belum ada paket/)).toBeTruthy();
  });

  it("creates a tier with an integer price", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [] },
      { method: "POST", path: TIERS_PATH, status: 201, body: BASIC },
    ]);

    render();
    await screen.findByText(/Belum ada paket/);

    fireEvent.change(screen.getByLabelText("Nama paket"), { target: { value: "Basic" } });
    fireEvent.change(screen.getByLabelText(/Harga per siklus/), { target: { value: "1250000" } });
    fireEvent.change(screen.getByLabelText("Siklus penagihan"), { target: { value: "monthly" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah paket" }));

    expect(await screen.findByText("Rp 1.250.000")).toBeTruthy();
    const post = stub.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "Basic", priceAmount: 1250000, billingCycle: "monthly" });
  });

  it("refuses a non-integer price without even asking the API", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [] },
    ]);

    render();
    await screen.findByText(/Belum ada paket/);

    fireEvent.change(screen.getByLabelText("Nama paket"), { target: { value: "Basic" } });
    fireEvent.change(screen.getByLabelText(/Harga per siklus/), { target: { value: "50000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah paket" }));

    expect((await screen.findByTestId("error-priceAmount")).textContent).toMatch(/bilangan bulat/);
    // Money never becomes a float on the way to the API — the request is not sent.
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("renders a 400 from the API as a field-level message", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [] },
      {
        method: "POST",
        path: TIERS_PATH,
        status: 400,
        body: { error: "priceAmount: Number must be less than or equal to 2000000000" },
      },
    ]);

    render();
    await screen.findByText(/Belum ada paket/);
    fireEvent.change(screen.getByLabelText("Nama paket"), { target: { value: "Mahal" } });
    fireEvent.change(screen.getByLabelText(/Harga per siklus/), { target: { value: "3000000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah paket" }));

    expect((await screen.findByTestId("error-priceAmount")).textContent).toContain("2000000000");
    expect((screen.getByLabelText("Nama paket") as HTMLInputElement).value).toBe("Mahal");
  });

  it("deactivates a tier and says what that means for the checkout page", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [BASIC] },
      { method: "PATCH", path: TIERS_PATH, body: { ...BASIC, isActive: false } },
    ]);

    render();
    await screen.findByText("Rp 1.250.000");

    fireEvent.click(screen.getByRole("button", { name: /Nonaktifkan/ }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = stub.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`${TIERS_PATH}/tier-1`);
    expect(patch.body).toEqual({ isActive: false });
    expect(await screen.findByText("Nonaktif")).toBeTruthy();
  });

  it("warns that tiers cannot be bought while payments are not connected", async () => {
    localStorage.removeItem("diudara.dashboard.payments.creator-1");
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: TIERS_PATH, body: [BASIC] },
    ]);

    render();
    await screen.findByText("Rp 1.250.000");

    // Building tiers nobody can buy is the failure this warning exists to prevent.
    expect(screen.getByTestId("payment-account-notice").className).toContain("notice-warning");
  });

  it("says the community was not found rather than showing an empty page for a 404", async () => {
    stubFetch([
      { path: "/communities", body: [] },
      { path: TIERS_PATH, status: 404, body: { error: "community not found" } },
    ]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });
});
