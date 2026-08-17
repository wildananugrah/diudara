import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FollowListPage from "./FollowListPage";

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
        <Route path="/:handleParam/pengikut" element={<FollowListPage direction="followers" />} />
        <Route path="/:handleParam/mengikuti" element={<FollowListPage direction="following" />} />
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

describe("FollowListPage", () => {
  it("renders follower rows for /@handle/pengikut", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null }]);
    }) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pengikut" })).toBeTruthy();
    expect(calls[0]).toBe("/users/wildan/followers");
  });

  it("renders following rows for /@handle/mengikuti", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null }]);
    }) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mengikuti" })).toBeTruthy();
    expect(calls[0]).toBe("/users/wildan/following");
  });

  it("shows the empty state for a follower list with no rows", async () => {
    global.fetch = mock(async () => jsonResponse([])) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    expect(await screen.findByText("Belum ada pengikut.")).toBeTruthy();
  });

  it("shows the empty state for a following list with no rows", async () => {
    global.fetch = mock(async () => jsonResponse([])) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    expect(await screen.findByText("Belum mengikuti siapa pun.")).toBeTruthy();
  });

  it("renders the 404 page for an unknown handle", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "user not found" }, 404)) as unknown as typeof fetch;

    renderAt("/@nosuchuser/pengikut");

    expect(await screen.findByText("Halaman tidak ditemukan")).toBeTruthy();
  });

  it("renders the 404 page (never the fetch) for a path with no leading @", async () => {
    global.fetch = mock(async () => {
      throw new Error("must not be called for a non-profile URL");
    }) as unknown as typeof fetch;

    renderAt("/signup-typo/pengikut");

    expect(screen.getByText("Halaman tidak ditemukan")).toBeTruthy();
  });

  it("each row links to /@handle", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    const link = await screen.findByRole("link", { name: /Budi Santoso/ });
    expect(link.getAttribute("href")).toBe("/@budi");
  });
});
