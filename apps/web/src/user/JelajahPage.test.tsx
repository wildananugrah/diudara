import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import JelajahPage from "./JelajahPage";
import { setUserSession } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <JelajahPage />
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

const NEWEST = [{ handle: "baru", displayName: "Akun Baru", bio: null }];
const MOST_FOLLOWED = [{ handle: "populer", displayName: "Akun Populer", bio: null }];

describe("JelajahPage", () => {
  it("loads both rails with an empty query on mount, and asks for no ?q=", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED });
    }) as unknown as typeof fetch;

    renderPage();

    expect(await screen.findByText("Akun Baru")).toBeTruthy();
    expect(screen.getByText("Akun Populer")).toBeTruthy();
    expect(calls[0]).toBe("/users/explore");
  });

  it("shows the empty state for both rails when there are no rows, without an error", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: [], mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderPage();

    // Both "Akun terbaru" and "Paling banyak diikuti" are empty here, so the
    // message legitimately renders twice.
    await waitFor(() => {
      expect(screen.queryAllByText("Belum ada akun.").length).toBe(2);
    });
    expect(screen.queryAllByRole("alert").length).toBe(0);
  });

  it("shows no 'Hasil pencarian' section at all until a search is submitted", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Akun Baru");
    expect(screen.queryAllByText("Hasil pencarian").length).toBe(0);
  });

  it("does NOT search on every keystroke — typing alone triggers no new request", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.queryAllByText("Belum ada akun.").length).toBe(2);
    });
    const initialCalls = calls.length;

    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), { target: { value: "budi" } });

    // Give any accidental async effect a turn to fire before asserting nothing did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(initialCalls);
  });

  it("searches on submit and renders the results section", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (url.includes("q=budi")) {
        return jsonResponse({
          results: [{ handle: "budisantoso", displayName: "Budi Santoso", bio: null }],
          newest: [],
          mostFollowed: [],
        });
      }
      return jsonResponse({ results: [], newest: [], mostFollowed: [] });
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.queryAllByText("Belum ada akun.").length).toBe(2);
    });

    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), { target: { value: "budi" } });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));

    expect(await screen.findByText("Hasil pencarian")).toBeTruthy();
    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(calls.some((url) => url === "/users/explore?q=budi")).toBe(true);
  });

  it("each row links to /@handle", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderPage();

    const link = await screen.findByRole("link", { name: /Akun Baru/ });
    expect(link.getAttribute("href")).toBe("/@baru");
  });

  it("shows an error message if the request fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });
  });

  // Review round 2, Important 3: FollowRow guesses `viewerFollows` from
  // whether a session exists (none of /explore, /followers, /following
  // return a per-row value) — every other test in this file runs
  // signed-out, so neither direction of that guess had ever been asserted.
  // Collapsing it to always-`{null}` would silently kill the follow feature
  // for signed-in visitors (every row reads "Masuk untuk mengikuti"
  // instead); collapsing it to always-`{false}` would show a signed-out
  // visitor a live "Ikuti" that 401s the moment it's tapped — the exact
  // inversion `apiClient.ts`'s `viewerFollows` docstring warns against.
  it("shows the sign-in link on every row for a signed-out visitor, never a live toggle", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Akun Baru");
    expect(screen.getByRole("link", { name: "Masuk untuk mengikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
  });

  it("shows a live Ikuti toggle on every row for a signed-in visitor, never the sign-in link", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Akun Baru");
    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: "Masuk untuk mengikuti" }).length).toBe(0);
  });
});
