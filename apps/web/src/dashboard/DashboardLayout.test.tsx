import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { getToken, setSession } from "./auth";
import DashboardLayout from "./DashboardLayout";
import RequireAuth from "./RequireAuth";
import { stubFetch, type StubRoute } from "./testing";

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

/** `AiCoBuilderNavLink` fetches this on mount; default it to "disabled" so a
 * test that does not care about the AI nav entry does not have to think
 * about it — the one test that DOES care overrides this entry. */
const AI_DISABLED: StubRoute = { path: "/ai/status", body: { enabled: false } };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  setSession("jwt-secret-value", CREATOR);
  stubFetch([AI_DISABLED]);
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("DashboardLayout", () => {
  it("shows the signed-in creator's name and the page content", async () => {
    renderLayout();

    expect(screen.getByText("Budi")).toBeTruthy();
    expect(screen.getByText("Isi halaman")).toBeTruthy();

    // Let `AiCoBuilderNavLink`'s own `GET /ai/status` settle inside `act`
    // before the test ends, rather than have its state update land after.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("never renders the token", async () => {
    renderLayout();
    expect(document.body.innerHTML).not.toContain("jwt-secret-value");

    await act(async () => {
      await Promise.resolve();
    });
  });

  it("logs out by clearing the token and returning to login", async () => {
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: "Keluar" }));

    expect(getToken()).toBeNull();
    expect(await screen.findByText("Masuk ke DIUDARA")).toBeTruthy();
  });

  it("hides the AI co-builder nav entry when the server reports it disabled", async () => {
    renderLayout();

    await waitFor(() => expect(screen.queryAllByText("AI Co-Builder").length).toBe(0));
  });

  it("shows the AI co-builder nav entry once the server reports it enabled", async () => {
    stubFetch([{ path: "/ai/status", body: { enabled: true } }]);
    renderLayout();

    expect(await screen.findByText("AI Co-Builder")).toBeTruthy();
  });
});
