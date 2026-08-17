import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FollowButton from "./FollowButton";
import { getUserToken, setUserSession } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderButton(props: Parameters<typeof FollowButton>[0]) {
  return render(
    <MemoryRouter>
      <FollowButton {...props} />
    </MemoryRouter>
  );
}

/**
 * Same button, but inside a real (if tiny) route table, so a navigation the
 * component performs itself can be OBSERVED by what renders afterwards rather
 * than by mocking `useNavigate` — the 401 path in item 7 has to actually land
 * somewhere.
 */
function renderButtonRouted(props: Parameters<typeof FollowButton>[0]) {
  return render(
    <MemoryRouter initialEntries={["/@budi"]}>
      <Routes>
        <Route path="/@budi" element={<FollowButton {...props} />} />
        <Route path="/masuk" element={<h1>Masuk</h1>} />
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

describe("FollowButton", () => {
  it('renders "Masuk untuk mengikuti", linking to /masuk, when viewerFollows is null (signed out)', () => {
    renderButton({ handle: "budi", viewerFollows: null });

    const link = screen.getByRole("link", { name: "Masuk untuk mengikuti" });
    expect(link.getAttribute("href")).toBe("/masuk");
  });

  it('renders "Ikuti" when viewerFollows is false', () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: false });

    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
  });

  it('renders "Mengikuti" when viewerFollows is true', () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: true });

    expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
  });

  it('tapping "Ikuti" calls POST .../follow and flips to "Mengikuti"', async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: true });
    }) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
    });
    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it('tapping "Mengikuti" calls DELETE .../follow and flips to "Ikuti"', async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ following: false });
    }) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: true });
    fireEvent.click(screen.getByRole("button", { name: "Mengikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    });
    expect(calls[0]!.url).toBe("/users/budi/follow");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("reverts to Ikuti when the follow call fails", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    // Optimistic flip happens immediately...
    expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();

    // ...then reverts once the failed request resolves.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
    });
  });

  it("is disabled while a request is in flight, and re-enabled once it resolves", async () => {
    setUserSession("jwt-abc", USER);
    let resolveFetch: (res: Response) => void = () => {};
    global.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    const button = screen.getByRole("button", { name: "Mengikuti" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    resolveFetch(jsonResponse({ following: true }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Mengikuti" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("renders nothing at all on your own profile, even though viewerFollows is false there, not null", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  it("is absent on your own profile regardless of handle case", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "WILDAN", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  // Review round 2, Minor: the case fix above only varies the TARGET
  // handle's case, so a comparison that normalised only that side (leaving
  // the session's own cached handle un-lowercased) would still pass it. This
  // varies the SESSION side instead.
  it("is absent on your own profile even when the session's cached handle has different case than the prop", () => {
    setUserSession("jwt-abc", { ...USER, handle: "WILDAN" });
    renderButton({ handle: "wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("is absent on your own profile even if the handle prop carries a leading @", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "@wildan", viewerFollows: false });

    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("renders the toggle normally when signed out is false but the handle differs from the viewer's own", () => {
    setUserSession("jwt-abc", USER);
    renderButton({ handle: "budi", viewerFollows: false });

    expect(screen.getByRole("button", { name: "Ikuti" })).toBeTruthy();
  });
});

/**
 * Final-review M2: `catch { setFollowing(!next); }` swallowed EVERY failure and
 * only reverted the visible state. Nothing told the user anything — the button
 * snapped back to "Ikuti" and stayed a live toggle they could tap forever. The
 * old "reverts to Ikuti when the follow call fails" test above pinned the
 * revert; nothing pinned any feedback, because there was none to pin.
 */
describe("FollowButton — a failed toggle is not silent (item 7)", () => {
  it("shows an Indonesian error when the follow call fails", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Gagal memperbarui status mengikuti. Coba lagi.");
    });
  });

  /**
   * The API's own error strings on this endpoint are NOT all Bahasa —
   * `routes/users.ts`'s unknown-handle case answers `{"error":"user not
   * found"}`, and `apiFetch`'s own fallback embeds a bare status code. Copy
   * rule is project-wide, so this screen renders its OWN sentence rather than
   * lifting whatever arrived, and this test pins that it does not leak the
   * server's text through.
   */
  it("never surfaces the server's own error text", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "user not found" }, 404)
    ) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.queryAllByText("user not found").length).toBe(0);
  });

  it("shows the error for a failed UNFOLLOW too, not only a failed follow", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: true });
    fireEvent.click(screen.getByRole("button", { name: "Mengikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Gagal memperbarui status mengikuti. Coba lagi.");
    });
  });

  /**
   * The 401 is the failure that MATTERS: `apiRequest` has already cleared the
   * session by the time this `catch` runs, so the button is a live toggle
   * attached to a session that no longer exists. Reverting silently left the
   * user tapping it indefinitely with no hint they had been signed out.
   */
  it("sends the visitor to /masuk when the session turns out to be gone (401)", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid or expired token" }, 401)
    ) as unknown as typeof fetch;

    renderButtonRouted({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    expect(await screen.findByRole("heading", { name: "Masuk" })).toBeTruthy();
    // `apiRequest` cleared it on the way past; asserted here so the redirect
    // cannot be mistaken for the only thing that happened.
    expect(getUserToken()).toBeNull();
  });

  it("clears the error once a later tap succeeds", async () => {
    setUserSession("jwt-abc", USER);
    let fail = true;
    global.fetch = mock(async () =>
      fail ? jsonResponse({ error: "server error" }, 500) : jsonResponse({ following: true })
    ) as unknown as typeof fetch;

    renderButton({ handle: "budi", viewerFollows: false });
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Ikuti" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mengikuti" })).toBeTruthy();
    });
    expect(screen.queryAllByRole("alert").length).toBe(0);
  });
});

/**
 * Re-review N4. `FollowButtonProps.viewerFollows`' docstring still described the
 * guess item 1 deleted — "or the caller's best guess of it — see `FollowRow` in
 * `JelajahPage.tsx` for the one place that guesses". Correcting the prose is
 * cheap; what follows pins the CLAIM the corrected prose makes, so it cannot go
 * stale again the way `getProfileByHandle`'s "a request nothing checks" did —
 * that comment stayed true-looking for a whole phase after it stopped being
 * true, and cost this project a Critical.
 *
 * The claim: no caller derives `viewerFollows` itself. It is the server's
 * answer, passed straight through. A ternary or a literal in that prop position
 * IS the guess coming back, and it is exactly what Phase 3 will be tempted to
 * write when it renders this button inside a post card.
 */
describe("FollowButton — nobody guesses viewerFollows (N4)", () => {
  it("every call site passes the server's value through, never a literal or a ternary", () => {
    const offenders: string[] = [];
    const dir = import.meta.dir;

    for (const entry of readdirSync(dir)) {
      if (!/\.tsx$/.test(entry) || /\.test\.tsx$/.test(entry)) continue;
      const source = readFileSync(join(dir, entry), "utf8");
      for (const match of source.matchAll(/viewerFollows=\{([^}]*)\}/g)) {
        const value = match[1]!.trim();
        // A bare identifier or property access is the server's value being
        // forwarded. Anything containing `?`, `true` or `false` is the caller
        // deciding — which is the defect.
        if (/[?]|(^|\W)(true|false|null)(\W|$)/.test(value)) {
          offenders.push(`${entry}: viewerFollows={${value}}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("finds the real call sites at all, and detects a guess — guards the guard", () => {
    const dir = import.meta.dir;
    const callSites = readdirSync(dir)
      .filter((entry) => /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry))
      .flatMap((entry) => [...readFileSync(join(dir, entry), "utf8").matchAll(/viewerFollows=\{/g)]);
    // ProfilePage and JelajahPage's FollowRow, at least.
    expect(callSites.length).toBeGreaterThan(1);

    // The exact expression item 1 deleted.
    const guess = "signedIn ? false : null";
    expect(/[?]|(^|\W)(true|false|null)(\W|$)/.test(guess)).toBe(true);
    // ...and the forwarding forms must not be flagged.
    expect(/[?]|(^|\W)(true|false|null)(\W|$)/.test("row.viewerFollows")).toBe(false);
    expect(/[?]|(^|\W)(true|false|null)(\W|$)/.test("viewerFollowing")).toBe(false);
  });
});
