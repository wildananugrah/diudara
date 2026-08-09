import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { apiFetch } from "./apiClient";
import { getToken, setSession } from "./auth";
import RequireAuth from "./RequireAuth";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

/** A protected panel that loads data the moment it mounts, like every real screen. */
function Panel() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch("/communities").catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "gagal");
    });
  }, []);
  return <div>Panel terlindungi{error ? ` — ${error}` : ""}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/login" element={<div>Masuk ke DIUDARA</div>} />
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <Panel />
            </RequireAuth>
          }
        />
      </Routes>
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

describe("RequireAuth", () => {
  it("redirects to login when there is no token", async () => {
    global.fetch = mock(async () => new Response("{}")) as unknown as typeof fetch;

    renderAt("/dashboard");

    expect(await screen.findByText("Masuk ke DIUDARA")).toBeTruthy();
    expect(screen.queryByText(/Panel terlindungi/)).toBeNull();
  });

  it("renders the protected panel when a token is present", async () => {
    setSession("jwt-abc", CREATOR);
    global.fetch = mock(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;

    renderAt("/dashboard");

    expect(await screen.findByText(/Panel terlindungi/)).toBeTruthy();
  });

  it("returns to login — not a half-authenticated panel — when a protected call 401s", async () => {
    setSession("jwt-stale", CREATOR);
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "invalid or expired token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;

    renderAt("/dashboard");

    // The whole point: the expired token does not leave the panel sitting there
    // showing an error with no way out.
    expect(await screen.findByText("Masuk ke DIUDARA")).toBeTruthy();
    expect(getToken()).toBeNull();
    expect(screen.queryByText(/Panel terlindungi/)).toBeNull();
  });

  it("keeps the token out of the rendered DOM", async () => {
    setSession("jwt-super-secret", CREATOR);
    global.fetch = mock(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;

    renderAt("/dashboard");
    await screen.findByText(/Panel terlindungi/);

    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain("jwt-super-secret");
    });
  });
});
