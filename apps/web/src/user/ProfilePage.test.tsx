import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
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
    media: [],
    author: { handle, displayName: handle === "wildan" ? "Wildan" : "Budi" },
    membersOnly: false,
    lockedMediaCount: 0,
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
    // Task 5 of memberships-5a widened the public profile by this field, and
    // it is ALWAYS present — `toMembershipView` reports `{ tiers: [] }` for a
    // creator who sells nothing rather than omitting the key, so the web never
    // branches on `undefined`. Every fixture here carries it for the same
    // reason: a fixture narrower than the wire is a page tested against a
    // response the API cannot send.
    membership: { tiers: [], viewerIsMember: false, viewerMembershipEnded: false },
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

/**
 * Both `/@wildan` and `/@budi` match the SAME route element (`/:handleParam`),
 * so React Router does not remount `ProfilePage` when a link swaps one for the
 * other — only `handleParam` changes. This is what lets state opened on one
 * profile (a pending delete confirmation, an open edit composer) survive onto
 * a completely different profile unless the component resets it itself. The
 * `<Link>` lives alongside the route, exactly like a real in-app link to
 * another handle (e.g. `PostCard`'s author link) would.
 */
function renderWithNav(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/@budi">Ke Budi</Link>
      <Link to="/@wildan">Ke Wildan</Link>
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
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
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

    // Fix round 1, item 3: nothing pinned the posts request to the profile
    // being viewed. `listUserPosts("orang-lain", before)` — a hardcoded
    // stranger — left the whole 625-test suite green before this assertion
    // existed.
    const postsCall = calls.find((url) => url.includes("/posts"));
    expect(postsCall).toBe("/users/budi/posts");
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

    // Fix round 1, item 4: a signed-out visitor must never be treated as the
    // owner of any post they see. Changing `getSessionUser()?.handle ?? null`
    // to `?? handle` at ProfilePage.tsx left the whole existing suite green,
    // because nothing at page level asserted the absence of owner controls
    // for a signed-out viewer — only that a body rendered, which the
    // preceding test already covers.
    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
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

  /**
   * Fix round 1, item 5. Replacing `setDeleteError(...)`'s body with `void
   * err` left 18 pass / 0 fail — the Bahasa error copy, the `role="alert"`
   * paragraph and "the row is kept" were all unexercised. Copies
   * `BerandaPage.test.tsx`'s "keeps the row and shows Bahasa copy when the
   * delete fails".
   */
  it("keeps the row and shows Bahasa copy when the delete fails", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Kiriman lama", "wildan")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");
    await screen.findByText("Kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Gagal menghapus kiriman. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    expect(screen.getByText("Kiriman lama")).toBeTruthy();
    expect(screen.queryAllByText(/internal server error/).length).toBe(0);
  });
});

/**
 * Fix round 1, item 1. `ProfilePage` is ONE route element (`/:handleParam`),
 * so a link from `/@wildan` to `/@budi` keeps the same component instance —
 * only `handle` (via `load`/`loadPosts`) refetches. Anything else held in
 * state must be reset by hand or it survives onto a profile it was never
 * about. Measured by the reviewer: a confirmation opened on wildan's own post
 * was still on screen on budi's profile, and "Ya, hapus" there fired a DELETE
 * for wildan's post while looking at budi's.
 */
describe("ProfilePage — resets per-post state when the viewed profile changes", () => {
  it("drops a pending delete confirmation, so 'Ya, hapus' cannot fire for a post from the last profile", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/wildan/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Kiriman wildan", "wildan")], nextCursor: null });
      }
      if (url.includes("/budi/posts")) {
        return jsonResponse({ posts: [makePost("p2", "Kiriman budi", "budi")], nextCursor: null });
      }
      if (url.includes("by-handle/budi")) return jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }));
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderWithNav("/@wildan");

    await screen.findByText("Kiriman wildan");
    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Ke Budi" }));
    await screen.findByText("Kiriman budi");

    // Not just a DOM check (per the finding): even if the panel somehow still
    // rendered, click whatever "Ya, hapus" is on screen now and prove no
    // DELETE was ever issued as a result — the real-world consequence, not an
    // implementation detail of what happens to be visible.
    const stillThere = screen.queryByRole("button", { name: "Ya, hapus" });
    if (stillThere !== null) fireEvent.click(stillThere);

    expect(screen.queryAllByText("Hapus kiriman ini?").length).toBe(0);
    expect(calls.filter((call) => call.init?.method === "DELETE").length).toBe(0);
  });

  /**
   * Fix round 2, N1. The `setEditing(null)` half of the reset effect
   * (`ProfilePage.tsx:106`) had no test of its own — deleting just that line
   * left the whole file at 25 pass / 0 fail. Measured harm: sign in as
   * wildan, open Edit on wildan's post, navigate to budi's profile, tap
   * whatever "Simpan" is on screen — a `PATCH /users/posts/p1` goes out
   * while budi's profile is on screen, saving text that has nothing to do
   * with what's rendered.
   *
   * **Assert on the recorded requests, not the DOM alone.** A DOM check for
   * "no Simpan button" passes under this mutation too: `handleSaveEdit`'s
   * own success path calls `setEditing(null)` regardless of the reset
   * effect, so clicking the surviving "Simpan" succeeds and only THEN hides
   * the composer. The PATCH already happened by the time the DOM looks
   * clean.
   */
  it("drops an open edit composer, so 'Simpan' cannot PATCH a post from the last profile", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "PATCH") {
        return jsonResponse({
          id: "p1",
          body: "Kiriman wildan",
          createdAt: "2026-08-18T00:00:00.000Z",
          editedAt: "2026-08-18T01:00:00.000Z",
          // Required and never absent on the wire — see `PostView.media`'s
          // own docstring. This mock predates Task 9, which is the first
          // thing to actually READ `post.media` on every render; without
          // this the field arrives `undefined` here and `PostCard` throws.
          media: [],
          author: { handle: "wildan", displayName: "Wildan" },
        });
      }
      if (url.includes("/wildan/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Kiriman wildan", "wildan")], nextCursor: null });
      }
      if (url.includes("/budi/posts")) {
        return jsonResponse({ posts: [makePost("p2", "Kiriman budi", "budi")], nextCursor: null });
      }
      if (url.includes("by-handle/budi")) return jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }));
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderWithNav("/@wildan");

    await screen.findByText("Kiriman wildan");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Guard: the composer actually opened before we navigate away from it.
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Ke Budi" }));
    await screen.findByText("Kiriman budi");

    // Not just a DOM check (see docstring above): click whatever "Simpan" is
    // on screen now, if anything, and prove no PATCH was ever issued as a
    // result — the real-world consequence, not an implementation detail of
    // what happens to be visible a moment later.
    const stillThere = screen.queryByRole("button", { name: "Simpan" });
    if (stillThere !== null) fireEvent.click(stillThere);

    expect(calls.filter((call) => call.init?.method === "PATCH").length).toBe(0);
  });

  /**
   * Fix round 2, N1 (smaller half). The `setDeleteError(null)` line in the
   * same reset effect was also unpinned. Lower stakes than the PATCH above —
   * no request fires as a result — but a failure banner about a post on the
   * LAST profile has no business surviving onto this one.
   */
  it("drops a delete-error banner from the last profile too", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      if (url.includes("/wildan/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Kiriman wildan", "wildan")], nextCursor: null });
      }
      if (url.includes("/budi/posts")) {
        return jsonResponse({ posts: [makePost("p2", "Kiriman budi", "budi")], nextCursor: null });
      }
      if (url.includes("by-handle/budi")) return jsonResponse(profileBody({ handle: "budi", displayName: "Budi" }));
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderWithNav("/@wildan");

    await screen.findByText("Kiriman wildan");
    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));
    // Guard: the failure actually happened before we navigate away from it.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("link", { name: "Ke Budi" }));
    await screen.findByText("Kiriman budi");

    expect(screen.queryAllByRole("alert").length).toBe(0);
  });
});

/**
 * Fix round 1, item 2. `PostCard` renders the `Edit` button whenever `isOwn`
 * is true whether or not an `onEdit` handler is supplied (`onEdit?.(post)` is
 * a safe no-op) — so before this fix the button was visible on your own
 * profile and did nothing when tapped. Mirrors `BerandaPage.tsx:123-132` and
 * `:174-184`.
 */
describe("ProfilePage — editing your own post (Task 6, fix round 1 item 2)", () => {
  it("opens the composer pre-filled with the post's body when Edit is tapped", async () => {
    setUserSession("jwt-abc", USER); // handle "wildan"
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Isi lama", "wildan")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Isi lama");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe("Isi lama");
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();
  });

  /**
   * Three rows, as the delete test above already established is necessary —
   * the assertion is the resulting ORDER, not membership, not just that the
   * text changed somewhere.
   */
  it("saves an edit IN PLACE, keeping the row's position among the others, and shows 'diedit'", async () => {
    setUserSession("jwt-abc", USER);
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "PATCH") {
        return jsonResponse({
          id: "p2",
          body: "Sudah diedit",
          createdAt: "2026-08-18T00:00:00.000Z",
          editedAt: "2026-08-18T01:00:00.000Z",
          // See the twin mock above — required on the wire, never absent.
          media: [],
          author: { handle: "wildan", displayName: "Wildan" },
        });
      }
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
    expect(bodies()).toEqual(["Kiriman satu", "Kiriman dua", "Kiriman tiga"]);

    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[1]!); // editing "Kiriman dua", the middle row

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), { target: { value: "Sudah diedit" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(bodies()).toEqual(["Kiriman satu", "Sudah diedit", "Kiriman tiga"]);
    });
    // The "diedit" marker lives in the row's own metadata line, not its body
    // (the body could coincidentally contain that word too).
    const metaTexts = Array.from(document.querySelectorAll(".post-card-meta")).map((el) => el.textContent ?? "");
    expect(metaTexts.some((text) => text.includes("diedit"))).toBe(true);
    const patchCall = calls.find((call) => call.init?.method === "PATCH");
    expect(patchCall?.url).toBe("/users/posts/p2");
  });

  it("keeps the typed text in the composer when a save fails", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ error: "internal server error" }, 500);
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Isi lama", "wildan")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Isi lama");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "Isi baru yang gagal disimpan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe(
      "Isi baru yang gagal disimpan"
    );
  });

  /**
   * `BerandaPage`'s own fix round 1: `key={editing.id}` on the composer was
   * deletable there with the whole suite green, because nothing ever opened a
   * SECOND edit without cancelling the first. `initialBody` only seeds
   * `useState`, so without the key React reuses the same component instance
   * and its stale body — tap Edit on post A, then on post B, and B's box
   * would hold A's text. Same shape, same fix, on the profile.
   */
  it("re-fills the box when Edit is tapped on a SECOND post without cancelling the first", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({
          posts: [makePost("p1", "isi satu", "wildan"), makePost("p2", "isi dua", "wildan")],
          nextCursor: null,
        });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");
    await screen.findByText("isi satu");

    const editButtons = () => screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons().length).toBe(2);

    fireEvent.click(editButtons()[0]!);
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe("isi satu");

    fireEvent.click(editButtons()[1]!);
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe("isi dua");
  });

  /**
   * A parked finding from Task 5, fixed here and in `BerandaPage.tsx` at the
   * same time: opening one of the edit/delete panels must close the other,
   * never let both render together for the same post.
   */
  it("opening Edit closes an open delete confirmation, and requesting a delete closes an open edit composer", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) => {
      if (url.includes("/posts")) {
        return jsonResponse({ posts: [makePost("p1", "Isi lama", "wildan")], nextCursor: null });
      }
      return jsonResponse(profileBody({ handle: "wildan", displayName: "Wildan" }));
    }) as unknown as typeof fetch;

    renderAt("/@wildan");
    await screen.findByText("Isi lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();
    expect(screen.queryAllByText("Hapus kiriman ini?").length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Simpan" }).length).toBe(0);
  });
});

/**
 * Task 10 of Phase 5a (spec §6): "A profile shows the offer and a 'Jadi
 * anggota' button."
 *
 * The offer's own behaviour — the rupiah formatting, the signed-out route to
 * Masuk, the own-profile hide, the invoice redirect and every failure
 * sentence — is tested against the component itself in
 * `MembershipOffer.test.tsx`. What is asserted HERE is the wiring that file
 * cannot see: that the profile page reads `membership.tiers` off the response
 * and hands it over, and that a profile selling nothing gets no offer at all.
 */
describe("ProfilePage — the membership offer (Task 10)", () => {
  const TIER = { id: "tier-1", name: "Anggota", priceAmount: 50000, billingCycle: "monthly" };

  it("shows what this creator sells, from the profile response's own membership field", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? emptyPostsPage()
        : jsonResponse(profileBody({ membership: { tiers: [TIER], viewerIsMember: false } }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");
    await screen.findByText("Budi");

    const offer = await screen.findByTestId("membership-tier-tier-1");
    expect(offer.textContent).toContain("Anggota");
    expect(offer.textContent).toContain("Rp 50.000");
    expect(screen.getByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
  });

  /**
   * The same rule the bio already follows on this page: no element at all,
   * never an empty one. Most profiles in this app sell nothing.
   */
  it("renders no offer element at all for a profile that sells nothing", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(profileBody())
    ) as unknown as typeof fetch;

    renderAt("/@budi");
    await screen.findByText("Budi");

    expect(document.querySelectorAll(".membership-offer").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: /Jadi anggota/ }).length).toBe(0);
    expect(screen.queryAllByText("Keanggotaan").length).toBe(0);
  });

  /**
   * Fix round 1: the profile now carries `membership.viewerIsMember`
   * (`IsMemberOf`, Task 8), and this is the wiring that reads it — a member
   * must not be offered a purchase of something they already hold.
   */
  it("tells an existing member they are a member instead of offering the button", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? emptyPostsPage()
        : jsonResponse(profileBody({ membership: { tiers: [TIER], viewerIsMember: true } }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");
    await screen.findByText("Budi");

    const panel = await screen.findByTestId("membership-member");
    expect(panel.textContent).toContain("Anda sudah menjadi anggota");
    expect(screen.queryAllByRole("button", { name: /Jadi anggota/ }).length).toBe(0);
  });

  /**
   * `membership.viewerMembershipEnded`, wired end to end — and since the final
   * whole-branch review's C-1 it selects a SENTENCE, not a dead end. Phase 5b's
   * purchase retires the lapsed row inside its own transaction, so this person
   * may buy again; the page must say their membership ended AND hand them the
   * button, with no worker pass in between. It used to render the notice and
   * nothing else, which left the headline feature unreachable from the product.
   */
  it("tells somebody whose membership ended that it ended, and still offers the button", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? emptyPostsPage()
        : jsonResponse(
            profileBody({
              membership: { tiers: [TIER], viewerIsMember: false, viewerMembershipEnded: true },
            })
          )
    ) as unknown as typeof fetch;

    renderAt("/@budi");
    await screen.findByText("Budi");

    const panel = await screen.findByTestId("membership-ended");
    expect(panel.textContent).toContain("sudah berakhir");
    expect(screen.getByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
    expect(screen.getByTestId("membership-tier-tier-1")).toBeTruthy();
  });

  /**
   * DEPLOY SKEW for this field specifically. An API that predates it sends
   * `membership` WITHOUT `viewerMembershipEnded`, and the default must be
   * `false` — defaulting the other way would hide every creator's offer from
   * every signed-in visitor on that deploy.
   */
  it("a membership field with no viewerMembershipEnded still shows the offer", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (url: string) =>
      url.includes("/posts")
        ? emptyPostsPage()
        : jsonResponse(profileBody({ membership: { tiers: [TIER], viewerIsMember: false } }))
    ) as unknown as typeof fetch;

    renderAt("/@budi");
    await screen.findByText("Budi");

    expect(await screen.findByRole("button", { name: "Jadi anggota — Anggota" })).toBeTruthy();
    expect(screen.queryAllByTestId("membership-ended").length).toBe(0);
  });
});

/**
 * DEPLOY SKEW, and the reason `ProfilePage` reads `membership` defensively
 * even though the field is required on `PublicUserProfile`.
 *
 * `membership` arrived in Task 5 of this phase. A browser holding this build
 * while the API is still the previous one — a rolling deploy, or a cached
 * bundle — gets a profile with no such field, and reading `.tiers` off it
 * throws DURING RENDER, which takes the whole page down rather than just the
 * offer. `toMembershipView`'s own docstring records the white screen Phase 4
 * shipped from exactly this shape.
 */
describe("ProfilePage — a response with no membership field at all", () => {
  it("still renders the profile and its feed, and simply shows no offer", async () => {
    setUserSession("jwt-abc", USER);
    const legacy = profileBody() as Record<string, unknown>;
    delete legacy.membership;
    global.fetch = mock(async (url: string) =>
      url.includes("/posts") ? emptyPostsPage() : jsonResponse(legacy)
    ) as unknown as typeof fetch;

    renderAt("/@budi");

    // The page itself is intact: the header, the counts and the feed's own
    // empty state — none of which has anything to do with memberships.
    expect(await screen.findByText("Budi")).toBeTruthy();
    expect(screen.getByText("@budi")).toBeTruthy();
    expect(await screen.findByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(document.querySelectorAll(".membership-offer").length).toBe(0);
    // And no membership is CLAIMED from a response that said nothing about
    // one: the safe default for "we could not ask" is "not a member".
    expect(screen.queryAllByTestId("membership-member").length).toBe(0);
  });
});
