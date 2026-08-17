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

/**
 * Rows as the API now sends them — with `viewerFollows` (final review, item 1).
 * `null` is the ANONYMOUS answer, which is what these two constants carry, since
 * most tests in this file run signed out.
 */
const NEWEST = [{ handle: "baru", displayName: "Akun Baru", bio: null, viewerFollows: null }];
const MOST_FOLLOWED = [
  { handle: "populer", displayName: "Akun Populer", bio: null, viewerFollows: null },
];

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
          results: [
            { handle: "budisantoso", displayName: "Budi Santoso", bio: null, viewerFollows: null },
          ],
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

  /**
   * Review round 2's Important 3 pinned both directions of a GUESS
   * (`signedIn ? false : null`), because no list endpoint returned a per-row
   * value. The final review's item 1 replaced the guess with the server's own
   * answer, so these two now pin that the ROW drives the control — which is a
   * strictly stronger statement, since a row can now say "true" and the old
   * guess could not.
   */
  it("a row the API reports as null renders the sign-in link, never a live toggle", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Akun Baru");
    expect(screen.getByRole("link", { name: "Masuk untuk mengikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
  });

  it("a row the API reports as false renders a live Ikuti toggle, never the sign-in link", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({
        results: [],
        newest: [{ handle: "baru", displayName: "Akun Baru", bio: null, viewerFollows: false }],
        mostFollowed: [],
      })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Akun Baru");
    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: "Masuk untuk mengikuti" }).length).toBe(0);
  });

  /**
   * THE DEFECT ITSELF, on the screen that shares this row component. Before item
   * 1 no row could ever read "Mengikuti", whatever the truth — which on
   * `/@you/mengikuti` was wrong for 100% of rows.
   */
  it("a row the API reports as true reads Mengikuti, not Ikuti", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({
        results: [],
        newest: [{ handle: "diikuti", displayName: "Sudah Diikuti", bio: null, viewerFollows: true }],
        mostFollowed: [],
      })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Sudah Diikuti");
    expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
  });

  it("mixes states within one list — one Mengikuti and one Ikuti side by side", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({
        results: [],
        newest: [
          { handle: "diikuti", displayName: "Sudah Diikuti", bio: null, viewerFollows: true },
          { handle: "belum", displayName: "Belum Diikuti", bio: null, viewerFollows: false },
        ],
        mostFollowed: [],
      })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Sudah Diikuti");
    expect(screen.getAllByRole("button", { name: "Mengikuti" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Ikuti" }).length).toBe(1);
  });

  /**
   * Your own account appears in "Akun terbaru", and the API answers `false` for
   * it (nobody follows themselves) — so a control driven off that value alone
   * would offer to follow you, and collect the 409. `FollowButton` compares
   * handles instead. Item 1's brief calls this out specifically: "your own row
   * must show no button, not a self-follow that 409s."
   */
  it("shows NO control at all on the viewer's own row, even though the API says false", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({
        results: [],
        newest: [{ handle: "wildan", displayName: "Wildan", bio: null, viewerFollows: false }],
        mostFollowed: [],
      })
    ) as unknown as typeof fetch;

    renderPage();

    await screen.findByText("Wildan");
    expect(screen.queryAllByRole("button", { name: "Ikuti" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mengikuti" }).length).toBe(0);
    expect(screen.queryAllByRole("link", { name: "Masuk untuk mengikuti" }).length).toBe(0);
  });
});

/**
 * Final-review I3, both halves.
 *
 * Half one: the server bounds `?q=` at 100 characters and refused beyond it;
 * the client bounded neither the input nor what it sent, so a pasted long line
 * produced a 400 whose Zod-derived ENGLISH message `readError` lifted straight
 * onto the screen. Half two: because `LoadState` was a single union,
 * `status: "error"` replaced the WHOLE page — "Akun terbaru" and "Paling banyak
 * diikuti" both vanished, though neither depends on `q` and both had already
 * loaded successfully.
 *
 * The `100` below is the LITERAL, deliberately not `MAX_EXPLORE_QUERY_LENGTH`.
 * Asserting against the constant the component reads would move with it and
 * pass vacuously — the trap Task 3's implementer caught in its own first
 * attempt at pinning `DEFAULT_EXPLORE_LIMIT`. The API's own
 * `rejects a ?q= longer than 100 characters` / `accepts a ?q= of exactly 100`
 * pair does the same on the server side, so mutating the SHARED constant now
 * goes red on both sides at once — which is what makes it one number rather
 * than two that happen to agree.
 */
describe("JelajahPage — the ?q= bound and a survivable failed search (item 5)", () => {
  it("bounds the search input at 100 characters, the same number the server enforces", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED })
    ) as unknown as typeof fetch;

    renderPage();
    await screen.findByText("Akun Baru");

    expect(screen.getByLabelText("Cari nama atau handle").getAttribute("maxlength")).toBe("100");
  });

  /**
   * `maxLength` is the browser's bound and a real paste respects it — but it is
   * an ATTRIBUTE, not a guarantee: `fireEvent.change` walks straight past it,
   * and so does any programmatic value set. The state itself must clamp, or the
   * over-long request still leaves the browser.
   */
  it("never sends a q longer than 100 characters, even when the input's value bypasses maxLength", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED });
    }) as unknown as typeof fetch;

    renderPage();
    await screen.findByText("Akun Baru");

    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), {
      target: { value: "b".repeat(250) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));

    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(1);
    });
    const searchCall = calls[calls.length - 1]!;
    const sent = new URL(searchCall, "http://localhost").searchParams.get("q");
    expect(sent).not.toBeNull();
    expect(sent!.length).toBe(100);
  });

  it("keeps BOTH rails on screen when the search itself fails", async () => {
    let failNext = false;
    global.fetch = mock(async (url: string) => {
      if (failNext && url.includes("q=")) return jsonResponse({ error: "server error" }, 500);
      return jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED });
    }) as unknown as typeof fetch;

    renderPage();
    await screen.findByText("Akun Baru");

    failNext = true;
    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), { target: { value: "budi" } });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));

    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });
    // The whole point: neither rail depends on `q`, and both had loaded.
    expect(screen.getByText("Akun Baru")).toBeTruthy();
    expect(screen.getByText("Akun Populer")).toBeTruthy();
    expect(screen.getByText("Akun terbaru")).toBeTruthy();
    expect(screen.getByText("Paling banyak diikuti")).toBeTruthy();
  });

  /**
   * The exact 400 body the final review measured against the real route, fed
   * back through the client. Nothing of it may reach the screen.
   */
  it("shows a Bahasa Indonesia message for a failed search, never the server's English one", async () => {
    const SERVER_MESSAGE =
      "invalid query: q must be at most 100 characters, limit must be an integer between 1 and 100";
    let failNext = false;
    global.fetch = mock(async (url: string) => {
      if (failNext && url.includes("q=")) return jsonResponse({ error: SERVER_MESSAGE }, 400);
      return jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED });
    }) as unknown as typeof fetch;

    renderPage();
    await screen.findByText("Akun Baru");

    failNext = true;
    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), { target: { value: "budi" } });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Pencarian gagal. Coba lagi.");
    });
    expect(screen.queryAllByText(SERVER_MESSAGE).length).toBe(0);
  });

  it("shows a Bahasa Indonesia message when the FIRST load fails and there is nothing to preserve", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Gagal memuat Jelajah. Coba lagi.");
    });
    expect(screen.queryAllByText("internal server error").length).toBe(0);
  });

  /**
   * Found while writing these tests, and a real defect rather than a test bug:
   * keying the fetch on the query STRING meant tapping "Cari" again with the
   * SAME text was a no-op (React bails out of a `useState` set to an equal
   * value, so the effect never re-ran). A screen that says "Coba lagi" and then
   * cannot be tried again is worse than one that says nothing. This retries the
   * IDENTICAL query deliberately.
   */
  it("recovers: retrying the SAME failed search clears the message and shows results", async () => {
    let failNext = false;
    global.fetch = mock(async (url: string) => {
      if (url.includes("q=")) {
        if (failNext) return jsonResponse({ error: "server error" }, 500);
        return jsonResponse({
          results: [
            { handle: "budisantoso", displayName: "Budi Santoso", bio: null, viewerFollows: null },
          ],
          newest: NEWEST,
          mostFollowed: MOST_FOLLOWED,
        });
      }
      return jsonResponse({ results: [], newest: NEWEST, mostFollowed: MOST_FOLLOWED });
    }) as unknown as typeof fetch;

    renderPage();
    await screen.findByText("Akun Baru");

    failNext = true;
    fireEvent.change(screen.getByLabelText("Cari nama atau handle"), { target: { value: "budi" } });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));
    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });

    // The input is untouched: the same query, tapped again.
    failNext = false;
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.queryAllByRole("alert").length).toBe(0);
  });
});
