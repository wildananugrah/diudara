import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import CommunitiesPage from "./CommunitiesPage";
import { renderPage, stubFetch, TEST_COMMUNITY } from "../testing";

function render() {
  return renderPage(<CommunitiesPage />, { path: "/dashboard", at: "/dashboard" });
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

describe("CommunitiesPage", () => {
  it("lists the creator's communities with their status", async () => {
    stubFetch([
      {
        path: "/communities",
        body: [TEST_COMMUNITY, { ...TEST_COMMUNITY, id: "c2", name: "Kelas Sore", slug: "kelas-sore", status: "paused" }],
      },
    ]);

    render();

    expect(await screen.findByText("Kelas Bimbel Budi")).toBeTruthy();
    expect(screen.getByText("Kelas Sore")).toBeTruthy();
    expect(screen.getByText("Aktif")).toBeTruthy();
    expect(screen.getByText("Dijeda")).toBeTruthy();
  });

  it("shows the copyable public checkout link for each community", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    // The link a creator broadcasts. The whole product depends on them sharing it,
    // so it is on the first screen, in full, and copyable.
    expect(screen.getByText(new RegExp("/c/kelas-bimbel-budi"))).toBeTruthy();
    expect(screen.getByRole("button", { name: /Salin/ })).toBeTruthy();
  });

  it("copies the checkout link to the clipboard", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });

    render();
    await screen.findByText("Kelas Bimbel Budi");
    fireEvent.click(screen.getByRole("button", { name: /Salin/ }));

    await waitFor(() => expect(written.length).toBe(1));
    expect(written[0]).toContain("/c/kelas-bimbel-budi");
    expect(await screen.findByText("Tersalin")).toBeTruthy();
  });

  it("shows an empty state that says what to do next when there are no communities", async () => {
    stubFetch([{ path: "/communities", body: [] }]);

    render();

    expect(await screen.findByText(/Belum ada komunitas/)).toBeTruthy();
    expect(screen.getByText(/Buat komunitas pertama Anda/)).toBeTruthy();
  });

  it("warns prominently that nobody can buy anything until payments are connected", async () => {
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    const notice = screen.getByTestId("payment-account-notice");
    expect(notice.textContent).toMatch(/belum bisa membayar|belum terhubung/);
    expect(notice.className).toContain("notice-warning");
  });

  it("hides the payment warning once payments are recorded as connected", async () => {
    localStorage.setItem("diudara.dashboard.payments.creator-1", "connected");
    stubFetch([{ path: "/communities", body: [TEST_COMMUNITY] }]);

    render();
    await screen.findByText("Kelas Bimbel Budi");

    expect(screen.queryAllByTestId("payment-account-notice").length).toBe(0);
  });

  it("creates a community and shows it without a reload", async () => {
    const created = { ...TEST_COMMUNITY, id: "c-new", name: "Kelas Malam", slug: "kelas-malam" };
    const stub = stubFetch([
      { path: "/communities", body: [] },
      { method: "POST", path: "/communities", status: 201, body: created },
    ]);

    render();
    await screen.findByText(/Belum ada komunitas/);

    fireEvent.change(screen.getByLabelText("Nama komunitas"), { target: { value: "Kelas Malam" } });
    fireEvent.change(screen.getByLabelText("Bidang (opsional)"), { target: { value: "bimbel" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    expect(await screen.findByText("Kelas Malam")).toBeTruthy();
    const post = stub.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/communities");
    expect(post.body).toEqual({ name: "Kelas Malam", niche: "bimbel" });
  });

  it("omits an empty niche rather than sending an empty string", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [] },
      { method: "POST", path: "/communities", status: 201, body: TEST_COMMUNITY },
    ]);

    render();
    await screen.findByText(/Belum ada komunitas/);
    fireEvent.change(screen.getByLabelText("Nama komunitas"), { target: { value: "Kelas Malam" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST")).toBe(true));
    expect(stub.calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Kelas Malam" });
  });

  it("renders a 400 as a field-level message and keeps what was typed", async () => {
    stubFetch([
      { path: "/communities", body: [] },
      {
        method: "POST",
        path: "/communities",
        status: 400,
        body: { error: "name: String must contain at most 255 character(s)" },
      },
    ]);

    render();
    await screen.findByText(/Belum ada komunitas/);
    fireEvent.change(screen.getByLabelText("Nama komunitas"), { target: { value: "terlalu panjang" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    expect((await screen.findByTestId("error-name")).textContent).toContain("at most 255");
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).value).toBe("terlalu panjang");
  });

  it("shows an error state rather than a blank panel when the list fails to load", async () => {
    stubFetch([{ path: "/communities", status: 500, body: { error: "internal server error" } }]);

    render();

    expect(await screen.findByText(/Gagal memuat/)).toBeTruthy();
  });
});
