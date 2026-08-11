import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe("an unknown path", () => {
  it("says the page was not found", () => {
    renderAt("/tidak-ada-halaman-ini");
    expect(screen.getAllByText(/halaman tidak ditemukan/i).length).toBe(1);
  });

  // It must RENDER, not redirect: the URL the visitor actually typed has to
  // stay in the address bar, or the message cannot be acted on. Before this,
  // an unknown path was rewritten to /c/tidak-ada — a slug nobody requested.
  it("does not redirect to a fabricated community slug", () => {
    renderAt("/tidak-ada-halaman-ini");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Komunitas tidak ditemukan");
  });

  it("offers a link home", () => {
    renderAt("/tidak-ada-halaman-ini");
    const home = screen.getByRole("link", { name: /beranda/i });
    expect(home.getAttribute("href")).toBe("/");
  });

  // The dashboard keeps its OWN catch-all, which sends an unknown
  // /dashboard/... path to the dashboard home rather than to this page.
  it("leaves the dashboard's own catch-all alone", () => {
    renderAt("/dashboard/tidak-ada");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Halaman tidak ditemukan");
  });
});
