import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { getToken, setSession } from "./auth";
import DashboardLayout from "./DashboardLayout";
import RequireAuth from "./RequireAuth";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

/**
 * The real route tree's shape: the layout lives INSIDE RequireAuth, which is what
 * turns "Keluar" (a bare clearToken) into a redirect. Wiring the layout on its own
 * would test a tree the app does not have.
 */
function renderLayout(path = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/login" element={<div>Masuk ke DIUDARA</div>} />
        <Route
          path="/dashboard/*"
          element={
            <RequireAuth>
              <DashboardLayout />
            </RequireAuth>
          }
        >
          <Route path="*" element={<div>Isi halaman</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  setSession("jwt-secret-value", CREATOR);
});

afterEach(() => {
  cleanup();
});

describe("DashboardLayout", () => {
  it("shows the signed-in creator's name and the page content", () => {
    renderLayout();

    expect(screen.getByText("Budi")).toBeTruthy();
    expect(screen.getByText("Isi halaman")).toBeTruthy();
  });

  it("never renders the token", () => {
    renderLayout();
    expect(document.body.innerHTML).not.toContain("jwt-secret-value");
  });

  it("logs out by clearing the token and returning to login", async () => {
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: "Keluar" }));

    expect(getToken()).toBeNull();
    expect(await screen.findByText("Masuk ke DIUDARA")).toBeTruthy();
  });
});
