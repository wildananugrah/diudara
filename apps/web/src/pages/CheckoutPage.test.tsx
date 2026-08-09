import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CheckoutPage from "./CheckoutPage";

const COMMUNITY = {
  id: "community-1",
  name: "Kelas Bimbel Budi",
  niche: "bimbel",
  slug: "kelas-budi",
  acceptingNewMembers: true,
  tiers: [
    { id: "tier-1", name: "Basic", priceAmount: 50000, billingCycle: "monthly" },
    { id: "tier-2", name: "Pro", priceAmount: 150000, billingCycle: "monthly" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/c/${slug}`]}>
      <Routes>
        <Route path="/c/:slug" element={<CheckoutPage />} />
      </Routes>
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("CheckoutPage", () => {
  it("renders the community's tiers with formatted Rupiah prices from a stubbed fetch", async () => {
    global.fetch = mock(async () => jsonResponse(COMMUNITY)) as unknown as typeof fetch;

    renderAt("kelas-budi");

    expect(await screen.findByText("Kelas Bimbel Budi")).toBeTruthy();
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("Pro")).toBeTruthy();
    // Integer Rupiah, Indonesian thousands separator.
    expect(screen.getByText(/Rp 50\.000/)).toBeTruthy();
    expect(screen.getByText(/Rp 150\.000/)).toBeTruthy();

    expect(global.fetch).toHaveBeenCalledWith("/c/kelas-budi");
  });

  it("posts checkout to the right endpoint with the selected tier id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return jsonResponse(
          { invoiceUrl: "https://fake-checkout.local/inv_1", subscriptionId: "sub-1", transactionId: "txn-1" },
          201
        );
      }
      return jsonResponse(COMMUNITY);
    }) as unknown as typeof fetch;

    // window.location.href assignment would otherwise navigate happy-dom
    // away and throw ("navigation not implemented"); only the POST is under
    // test here, never the Xendit redirect itself.
    const originalHref = Object.getOwnPropertyDescriptor(window.location, "href");
    Object.defineProperty(window.location, "href", {
      configurable: true,
      set: () => {},
      get: () => "about:blank",
    });

    renderAt("kelas-budi");
    await screen.findByText("Kelas Bimbel Budi");

    fireEvent.click(screen.getAllByRole("radio")[1]!);
    fireEvent.change(screen.getByLabelText("Nama"), { target: { value: "Siti" } });
    fireEvent.change(screen.getByLabelText("Nomor WhatsApp"), { target: { value: "+6281234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /Lanjutkan pembayaran/ }));

    await waitFor(() => {
      expect(calls.some((c) => c.init?.method === "POST")).toBe(true);
    });

    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/c/kelas-budi/checkout");
    const body = JSON.parse(post.init!.body as string);
    expect(body).toEqual({ tierId: "tier-2", payerName: "Siti", payerWhatsappNumber: "+6281234567890" });

    if (originalHref) Object.defineProperty(window.location, "href", originalHref);
  });

  it("renders a paused state and offers no checkout when the community is not accepting new members", async () => {
    global.fetch = mock(async () => jsonResponse({ ...COMMUNITY, acceptingNewMembers: false })) as unknown as typeof fetch;

    renderAt("kelas-budi");

    expect(await screen.findByText(/tidak menerima anggota baru/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Lanjutkan pembayaran/ })).toBeNull();
    expect(screen.queryByText("Basic")).toBeNull();
  });

  it("renders a not-found state for a 404 instead of crashing", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "community not found" }, 404)) as unknown as typeof fetch;

    renderAt("tidak-ada");

    expect(await screen.findByText(/tidak ditemukan/)).toBeTruthy();
  });
});
