import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FollowListPage from "./FollowListPage";
import { setUserSession } from "./apiClient";

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
      return jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }]);
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
      return jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }]);
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
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    const link = await screen.findByRole("link", { name: /Budi Santoso/ });
    expect(link.getAttribute("href")).toBe("/@budi");
  });

  /**
   * Final-review I1's design question, ruled: this page stays OUTSIDE the app
   * shell (consistent with `/@handle`, also outside) and gains a back link to
   * the profile it came from. Before this, the only navigation off
   * `/@x/pengikut` was browser-back or a row's own `/@handle` link — a genuine
   * dead end on a phone, since these two pages are reachable ONLY by tapping a
   * count on a profile.
   *
   * Asserted on the `href` rather than on the presence of any link, because
   * every ROW is also a link to some `/@handle`; the one that matters is the
   * one pointing back at the LIST'S OWN subject.
   */
  it("offers a back link to the profile the list belongs to", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    await screen.findByText("Budi Santoso");
    const back = screen.getByRole("link", { name: "Kembali ke @wildan" });
    expect(back.getAttribute("href")).toBe("/@wildan");
  });

  it("offers the same back link on the following list", async () => {
    global.fetch = mock(async () => jsonResponse([])) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    await screen.findByText("Belum mengikuti siapa pun.");
    const back = screen.getByRole("link", { name: "Kembali ke @wildan" });
    expect(back.getAttribute("href")).toBe("/@wildan");
  });

  /**
   * The error state is a dead end too — arguably more of one, since there are
   * no rows to tap through to. A failed list must still be escapable.
   */
  it("offers the back link even when the list failed to load", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "kesalahan server" }, 500)
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    await screen.findByRole("heading", { name: "Gagal memuat daftar" });
    const back = screen.getByRole("link", { name: "Kembali ke @wildan" });
    expect(back.getAttribute("href")).toBe("/@wildan");
  });
});

/**
 * FINAL REVIEW, MUST-FIX ITEM 1 — THE PAGE THE DEFECT WAS ABOUT.
 *
 * `/@you/mengikuti` is defined as "everyone you follow", and every row of it read
 * "Ikuti" because no list endpoint answered the question per row. Task 6 measured
 * the whole sequence in a real browser: tap 1 was a silent no-op re-follow (the
 * follow row count stayed at 1, no duplicate, no error), tap 2 was the real
 * DELETE. So unfollowing from a list took TWO taps and the first did nothing
 * visible — and combined with the (then) total absence of an error surface, a
 * user could not tell a no-op from a failure.
 */
describe("FollowListPage — per-row follow state and one-tap unfollow (item 1)", () => {
  const SESSION = { id: "u1", handle: "wildan", displayName: "Wildan", email: "w@example.com" };

  it("your own /mengikuti list reads Mengikuti on every row, never Ikuti", async () => {
    setUserSession("jwt-abc", SESSION);
    global.fetch = mock(async () =>
      jsonResponse([
        { handle: "budi", displayName: "Budi", bio: null, viewerFollows: true },
        { handle: "rina", displayName: "Rina", bio: null, viewerFollows: true },
      ])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    await screen.findByText("Budi");
    expect(screen.getAllByRole("button", { name: "Mengikuti" }).length).toBe(2);
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
  });

  /**
   * ONE TAP, and the request it issues. The old behaviour's first tap was a
   * POST — a re-follow of somebody already followed — so the assertion that
   * matters is the METHOD of the first request, not just the resulting label.
   */
  it("ONE tap unfollows: the first request is a DELETE, not a re-follow POST", async () => {
    setUserSession("jwt-abc", SESSION);
    const calls: Array<{ url: string; method: string | undefined }> = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (url.includes("/mengikuti") || url.endsWith("/following")) {
        calls.push({ url, method: init?.method });
        return jsonResponse([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: true }]);
      }
      calls.push({ url, method: init?.method });
      return jsonResponse({ following: false });
    }) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");
    const toggle = await screen.findByRole("button", { name: "Mengikuti" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    });
    const followCalls = calls.filter((c) => c.url === "/users/budi/follow");
    expect(followCalls).toHaveLength(1);
    expect(followCalls[0]!.method).toBe("DELETE");
  });

  it("a followers list mixes states honestly — one already followed, one not", async () => {
    setUserSession("jwt-abc", SESSION);
    global.fetch = mock(async () =>
      jsonResponse([
        { handle: "budi", displayName: "Budi", bio: null, viewerFollows: true },
        { handle: "rina", displayName: "Rina", bio: null, viewerFollows: false },
      ])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    await screen.findByText("Budi");
    expect(screen.getAllByRole("button", { name: "Mengikuti" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Ikuti" }).length).toBe(1);
  });

  it("signed out: every row offers the sign-in link, never a live toggle", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    await screen.findByText("Budi");
    expect(screen.getByRole("link", { name: "Masuk untuk mengikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
  });

  /**
   * Task 6 recorded that `/@x/pengikut` shows no button on your own row, so a
   * followers list is not somewhere you can unfollow from. That stays true, and
   * for the right reason — the handle comparison, not the value.
   */
  it("your own row carries no control, even though the API reports false for it", async () => {
    setUserSession("jwt-abc", SESSION);
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "wildan", displayName: "Wildan", bio: null, viewerFollows: false }])
    ) as unknown as typeof fetch;

    renderAt("/@budi/pengikut");

    await screen.findByText("Wildan");
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mengikuti" }).length).toBe(0);
  });
});
