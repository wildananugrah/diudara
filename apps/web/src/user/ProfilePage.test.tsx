import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProfilePage from "./ProfilePage";
import { setUserSession, type PostView } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A page's every route now also fires `listUserPosts`, so every mock below
 * that reaches the "ready" branch must answer BOTH `/users/by-handle/:handle`
 * and `/users/:handle/posts` — a mock that only knows about the profile
 * shape gets that same object handed back for the posts request, and
 * `PostFeed` reading `.posts` off it crashes the whole render. Tests that
 * never reach "ready" (404, network/500 profile failures) are unaffected:
 * `PostFeed` only mounts once `load.status === "ready"`.
 */
function emptyPostsPage() {
  return jsonResponse({ posts: [], nextCursor: null });
}

function makePost(id: string, body: string, handle: string): PostView {
  return {
    id,
    body,
    createdAt: "2026-08-18T00:00:00.000Z",
    editedAt: null,
    author: { handle, displayName: handle === "wildan" ? "Wildan" : "Budi" },
  };
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
      if (url.includes("/posts")) return emptyPostsPage();
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
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(profileBody())
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

  it("shows both counts, each linking to the right list", async () => {
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(profileBody({ followerCount: 12, followingCount: 4 }))
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
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(profileBody({ viewerFollows: false }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    expect(await screen.findByRole("button", { name: "Ikuti" })).toBeTruthy();
  });

  it("renders NO follow button at all on your own profile", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? emptyPostsPage()
        : jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan", viewerFollows: false }))
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
      if (url.includes("/posts")) return emptyPostsPage();
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
      if (url.includes("/posts")) return emptyPostsPage();
      return jsonResponse(profileBody({ followerCount: 5, viewerFollows: true }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    const button = await screen.findByRole("button", { name: "Mengikuti" });
    expect(screen.getByText("5")).toBeTruthy();

    fireEvent.click(button);

    expect(await screen.findByText("4")).toBeTruthy();
  });
});

/**
 * Re-review N1, measured on this exact component: `"Gagal memuat profil"`
 * followed by the server's own `"internal server error"` on a 500, and by the
 * browser's own `"Failed to fetch"` on a network drop. Both English, on a screen
 * whose every other word is Bahasa.
 */
describe("ProfilePage — a failed load speaks Bahasa Indonesia (N1)", () => {
  it("shows Bahasa copy for a 500, never the server's own string", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByRole("heading", { name: "Gagal memuat profil" });
    expect(screen.getByText("Server sedang bermasalah. Coba lagi sebentar lagi.")).toBeTruthy();
    expect(screen.queryAllByText("internal server error").length).toBe(0);
  });

  it("shows Bahasa copy when the connection drops, never 'Failed to fetch'", async () => {
    // What a real network failure looks like: `fetch` REJECTS, it does not
    // resolve with a status. Nothing about it is a UserApiError.
    global.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByRole("heading", { name: "Gagal memuat profil" });
    expect(screen.getByText("Tidak dapat menghubungi server. Coba lagi.")).toBeTruthy();
    expect(screen.queryAllByText("Failed to fetch").length).toBe(0);
  });
});

/**
 * Task 6: a person's posts render below the header. `listUserPosts` goes
 * through `publicGet` (Task 3's `/:handle/posts`), and `PostFeed` — not this
 * component — owns the list, its loading state and its own error paragraph.
 * See `PostFeed.tsx`'s own docstring for why a page cannot hold a second,
 * parallel copy of the list.
 */
describe("ProfilePage — posts (Task 6)", () => {
  it("renders that person's posts below the profile header", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({
          posts: [makePost("p1", "Kiriman pertama", "budi"), makePost("p2", "Kiriman kedua", "budi")],
          nextCursor: null,
        });
      }
      return jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    await screen.findByText("Budi");
    expect(await screen.findByText("Kiriman pertama")).toBeTruthy();
    expect(screen.getByText("Kiriman kedua")).toBeTruthy();
  });

  it("still renders the posts when signed out — listUserPosts goes through publicGet", async () => {
    // No setUserSession: this is a signed-out visitor. `/@handle` is public.
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Kiriman publik", "budi")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    await screen.findByText("Budi");
    expect(await screen.findByText("Kiriman publik")).toBeTruthy();
  });

  it("shows honest Bahasa copy for an empty list, not a spinner", async () => {
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    await screen.findByText("Budi");
    expect(await screen.findByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.queryAllByText("Memuat...").length).toBe(0);
  });

  it("carries Edit and Hapus on your own profile's posts", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Punyaku sendiri", "wildan")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Punyaku sendiri");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus" })).toBeTruthy();
  });

  it("carries NEITHER Edit nor Hapus on someone else's posts", async () => {
    setUserSession("jwt-abc", USER); // signed in as wildan, viewing budi's profile
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Punya Budi", "budi")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "budi", displayName: "Budi", viewerFollows: false }));
    }) as unknown as typeof fetch;

    renderAt("/@budi");

    await screen.findByText("Punya Budi");
    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  /**
   * The same rule Jelajah's rails follow, and the rule Phase 2's final review
   * made a merge blocker: a failed fetch for one region of the page must not
   * blank a DIFFERENT region that already loaded successfully. Post state and
   * profile state are held separately for exactly this reason.
   */
  it("does NOT blank the profile header when the post load fails", async () => {
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? jsonResponse({ error: "internal server error" }, 500)
        : jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    // Guard: the header actually loaded.
    await screen.findByText("Budi");
    // Guard: the post load actually failed and PostFeed's own error rendered
    // — proof this isn't just "we didn't wait long enough".
    await screen.findByRole("alert");

    // The point: the header is STILL there next to that error.
    expect(screen.getByText("Budi")).toBeTruthy();
    expect(screen.getByText("@budi")).toBeTruthy();
  });

  /**
   * Task 5's delete tests all used a one-row fixture, which is exactly why
   * `PostFeedHandle.remove`'s "the right row, not just any row" guarantee
   * went unnoticed for a whole round. Three rows here, and the assertion is
   * the resulting ORDER, not membership or length.
   */
  it("deleting from your own profile removes exactly that row, keeping the others in order", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/posts")) {
        return jsonResponse({
          posts: [
            makePost("p1", "Kiriman satu", "wildan"),
            makePost("p2", "Kiriman dua", "wildan"),
            makePost("p3", "Kiriman tiga", "wildan"),
          ],
          nextCursor: null,
        });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    function bodies(): string[] {
      return screen
        .getAllByRole("article")
        .map((article) => article.querySelector(".post-card-body")?.textContent ?? "");
    }

    renderAt("/@wildan");

    await screen.findByText("Kiriman satu");
    // Guards every assertion below: if the fixture were not three rows in
    // this order, "the MIDDLE one" would mean nothing.
    expect(bodies()).toEqual(["Kiriman satu", "Kiriman dua", "Kiriman tiga"]);

    const hapusButtons = screen.getAllByRole("button", { name: "Hapus" });
    fireEvent.click(hapusButtons[1]!); // requests deleting "Kiriman dua", the middle row
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => {
      expect(bodies()).toEqual(["Kiriman satu", "Kiriman tiga"]);
    });
    const deleteCall = calls.find((call) => call.init?.method === "DELETE");
    expect(deleteCall?.url).toBe("/users/posts/p2");
  });
});
