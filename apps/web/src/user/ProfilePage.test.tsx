import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProfilePage from "./ProfilePage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:handleParam" element={<ProfilePage />} />
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

describe("ProfilePage", () => {
  it("renders the display name, handle and bio for a known profile", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        handle: "wildan",
        displayName: "Wildan Anugrah",
        bio: "Membangun DIUDARA.",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    expect(await screen.findByText("Wildan Anugrah")).toBeTruthy();
    expect(screen.getByText("@wildan")).toBeTruthy();
    expect(screen.getByText("Membangun DIUDARA.")).toBeTruthy();
    // The `@` is stripped before the API call — a bare handle, per Task 3.
    expect(calls[0]).toBe("/users/by-handle/wildan");
  });

  it("renders no bio element at all for a bio-less profile", async () => {
    global.fetch = mock(async () =>
      jsonResponse({
        handle: "budi",
        displayName: "Budi",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    expect(await screen.findByText("Budi")).toBeTruthy();
    expect(document.querySelectorAll(".profile-bio").length).toBe(0);
  });

  it("renders the 404 page for an unknown handle", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "user not found" }, 404)) as unknown as typeof fetch;

    renderAt("/@nosuchuser");

    expect(await screen.findByText("Halaman tidak ditemukan")).toBeTruthy();
  });

  it("renders the 404 page (never the profile fetch) for a path with no leading @", async () => {
    global.fetch = mock(async () => {
      throw new Error("must not be called for a non-profile URL");
    }) as unknown as typeof fetch;

    renderAt("/signup-typo");

    expect(screen.getByText("Halaman tidak ditemukan")).toBeTruthy();
  });
});
