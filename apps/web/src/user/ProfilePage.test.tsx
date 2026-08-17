import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProfilePage from "./ProfilePage";
import { setUserSession } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return {
    handle: "budi",
    displayName: "Budi",
    bio: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0,
    followingCount: 0,
    viewerFollows: null,
    ...overrides,
  };
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
  localStorage.clear();
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
      return jsonResponse(
        profileBody({ handle: "wildan", displayName: "Wildan Anugrah", bio: "Membangun DIUDARA." })
      );
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    expect(await screen.findByText("Wildan Anugrah")).toBeTruthy();
    expect(screen.getByText("@wildan")).toBeTruthy();
    expect(screen.getByText("Membangun DIUDARA.")).toBeTruthy();
    // The `@` is stripped before the API call — a bare handle, per Task 3.
    expect(calls[0]).toBe("/users/by-handle/wildan");
  });

  it("renders no bio element at all for a bio-less profile", async () => {
    global.fetch = mock(async () => jsonResponse(profileBody())) as unknown as typeof fetch;

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

  it("shows both counts, each linking to the right list", async () => {
    global.fetch = mock(async () =>
      jsonResponse(profileBody({ followerCount: 12, followingCount: 4 }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    await screen.findByText("Budi");
    const followers = screen.getByRole("link", { name: /12.*Pengikut/ });
    expect(followers.getAttribute("href")).toBe("/@budi/pengikut");
    const following = screen.getByRole("link", { name: /4.*Mengikuti/ });
    expect(following.getAttribute("href")).toBe("/@budi/mengikuti");
  });

  it("renders a follow button on someone else's profile", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse(profileBody({ viewerFollows: false }))) as unknown as typeof fetch;

    renderAt("/@budi");

    expect(await screen.findByRole("button", { name: "Ikuti" })).toBeTruthy();
  });

  it("renders NO follow button at all on your own profile", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () =>
      jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan", viewerFollows: false }))
    ) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Wildan");
    expect(screen.queryAllByRole("button", { name: /ikuti/i }).length).toBe(0);
    expect(screen.queryAllByRole("link", { name: /masuk untuk mengikuti/i }).length).toBe(0);
  });

  it("bumps the visible follower count when the follow button is tapped", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ following: true });
      }
      return jsonResponse(profileBody({ followerCount: 5, viewerFollows: false }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    const button = await screen.findByRole("button", { name: "Ikuti" });
    expect(screen.getByText("5")).toBeTruthy();

    fireEvent.click(button);

    expect(await screen.findByText("6")).toBeTruthy();
  });

  // Review round 2, Minor: the bump test above only exercises the FOLLOW
  // direction — `handleFollowChange`'s subtraction branch
  // (`- (viewerFollowing === true ? 1 : 0)`) had no test of its own, so
  // deleting it stayed green.
  it("drops the visible follower count when the follow button is tapped to unfollow", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return jsonResponse({ following: false });
      }
      return jsonResponse(profileBody({ followerCount: 5, viewerFollows: true }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    const button = await screen.findByRole("button", { name: "Mengikuti" });
    expect(screen.getByText("5")).toBeTruthy();

    fireEvent.click(button);

    expect(await screen.findByText("4")).toBeTruthy();
  });
});
