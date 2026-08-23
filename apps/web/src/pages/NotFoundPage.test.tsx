import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";

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

  // Phase 8's Task 1 deleted the creator dashboard entirely, so an unknown
  // /dashboard/... path now falls through to this page like any other
  // unknown path — see App.test.tsx's own routing test for that.
  it("renders this same page for an unknown path under the old /dashboard prefix", () => {
    renderAt("/dashboard/tidak-ada");
    expect(screen.getAllByText(/halaman tidak ditemukan/i).length).toBe(1);
  });
});
