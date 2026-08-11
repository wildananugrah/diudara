import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { setSession } from "../dashboard/auth";
import { resetPaymentAccountCacheForTesting } from "../dashboard/paymentAccount";
import { stubFetch, TEST_CREATOR } from "../dashboard/testing";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  resetPaymentAccountCacheForTesting();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("an unknown path", () => {
  it("says the page was not found", () => {
    renderAt("/tidak-ada-halaman-ini");
    expect(screen.getAllByText(/halaman tidak ditemukan/i).length).toBe(1);
  });

  // It must RENDER, not redirect: the URL the visitor actually typed has to
  // stay in the address bar, or the message cannot be acted on. Before this,
  // an unknown path was rewritten to /c/tidak-ada — a slug nobody requested,
  // and CheckoutPage's synchronous first render for that slug shows "Memuat...".
  // A reverted catch-all lands there, so checking for THAT text (not just the
  // absence of a downstream error it never reaches) is what makes this
  // assertion fail on its own against the bug it exists to catch.
  it("does not redirect to a fabricated community slug", () => {
    renderAt("/tidak-ada-halaman-ini");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Komunitas tidak ditemukan");
    expect(text).not.toContain("Memuat...");
  });

  it("offers a link home", () => {
    renderAt("/tidak-ada-halaman-ini");
    const home = screen.getByRole("link", { name: /beranda/i });
    expect(home.getAttribute("href")).toBe("/");
  });

  // The dashboard keeps its OWN catch-all, which sends an unknown
  // /dashboard/... path to the dashboard home (CommunitiesPage) rather than
  // to this page. A signed-out render would redirect to /dashboard/login
  // before ever reaching that nested catch-all, so this test signs in first
  // and then confirms the dashboard's own home actually rendered — not just
  // that this page's own heading is absent, which a login redirect would
  // also satisfy.
  it("leaves the dashboard's own catch-all alone", async () => {
    setSession("jwt-test", TEST_CREATOR);
    stubFetch([
      { path: "/payment-account", body: { connected: true, provisioning: false } },
      { path: "/ai/status", body: { enabled: false } },
      { path: "/communities", body: [] },
    ]);

    renderAt("/dashboard/tidak-ada");

    expect(await screen.findByText("Komunitas Anda")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Halaman tidak ditemukan");
  });
});
