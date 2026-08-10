import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import CommunityOverviewPage from "./CommunityOverviewPage";
import { renderPage, stubFetch, TEST_COMMUNITY } from "../testing";

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
  localStorage.setItem("diudara.dashboard.payments.creator-1", "connected");
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("CommunityOverviewPage", () => {
  it("shows the community's name and its status with what the status MEANS", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();

    expect(await screen.findByText("Kelas Bimbel Budi")).toBeTruthy();
    expect(screen.getByTestId("status-explanation").textContent).toMatch(/bisa dibeli|menerima pembayaran/);
  });

  it("explains a paused community keeps its checkout page but refuses purchases", async () => {
    stubFetch([{ path: "/communities", body: [{ ...TEST_COMMUNITY, status: "paused" }] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    const explanation = screen.getByTestId("status-explanation").textContent ?? "";
    expect(explanation).toMatch(/tetap terbuka|tetap tampil/);
    expect(explanation).toMatch(/ditolak|tidak bisa membeli/);
  });

  it("explains an archived community's page is gone", async () => {
    stubFetch([{ path: "/communities", body: [{ ...TEST_COMMUNITY, status: "archived" }] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect(screen.getByTestId("status-explanation").textContent).toMatch(/tidak dapat dibuka|404|hilang/);
  });

  it("shows the public checkout link in full and copyable", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect(screen.getByText(new RegExp("/c/kelas-bimbel-budi"))).toBeTruthy();
    expect(screen.getByRole("button", { name: /Salin/ })).toBeTruthy();
  });

  it("changes the status with a PATCH", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { method: "PATCH", path: `/communities/${TEST_COMMUNITY.id}`, body: { ...TEST_COMMUNITY, status: "paused" } },
    ]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "paused" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan status" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = stub.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/communities/${TEST_COMMUNITY.id}`);
    expect(patch.body).toEqual({ status: "paused" });
    expect((await screen.findByTestId("status-explanation")).textContent).toMatch(/tetap terbuka|tetap tampil/);
  });

  it("renders a 409 on a slug rename inline, keeping the slug the creator typed", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
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
    stubFetch([{ path: "/communities", body: [] }]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });

  it("links to the community's other screens", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    for (const label of ["Ringkasan", "Paket", "Grup", "Anggota", "Aktivitas"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
  });
});
