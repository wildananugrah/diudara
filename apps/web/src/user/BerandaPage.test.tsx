import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from "react-router-dom";
import BerandaPage from "./BerandaPage";
import { getUserToken, setUserSession, type PostView } from "./apiClient";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makePost(id: string, body: string, handle = "wildan"): PostView {
  return {
    id,
    body,
    createdAt: "2026-08-18T00:00:00.000Z",
    editedAt: null,
    author: { handle, displayName: handle === "wildan" ? "Wildan" : "Budi" },
    // `[]` rather than absent: the API sends this key on every post, edited or
    // not (see `toPostView`), and `PostView` requires it for that reason.
    media: [],
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Replaces `global.fetch` directly — `apiClient`'s real functions then run unmodified against it, no module mocking. */
function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  global.fetch = mock(async (url: string, init: RequestInit | undefined) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

/** Lets the URL itself be asserted, rather than what happens to render. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function renderBeranda(entry = "/beranda") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/beranda" element={<BerandaPage />} />
        <Route path="/masuk" element={<h1>Masuk</h1>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function url(): string {
  return screen.getByTestId("url").textContent ?? "";
}

function tabButton(name: "Untuk Anda" | "Mengikuti"): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** Gives any effect a queued request would sit in a chance to fire before an absence is asserted. */
function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

describe("BerandaPage — the two tabs", () => {
  it("defaults to Untuk Anda, with Mengikuti as the other tab", async () => {
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    expect(tabButton("Untuk Anda").getAttribute("aria-current")).toBe("true");
    expect(tabButton("Mengikuti").getAttribute("aria-current")).toBe("false");
  });

  it("requests tab=untuk-anda by default", async () => {
    const calls = mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    expect(calls[0]!.url).toBe("/users/feed?tab=untuk-anda");
  });

  /**
   * The tab lives in the URL, so back and forward work and a link to Mengikuti
   * is shareable. Pinned against the URL rather than against what renders:
   * component state can make the right tab render while breaking both of those,
   * which is exactly the mutation Step 5 runs.
   */
  it("puts ?tab=mengikuti in the URL when Mengikuti is tapped", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    fireEvent.click(tabButton("Mengikuti"));

    await waitFor(() => {
      expect(url()).toBe("/beranda?tab=mengikuti");
    });
  });

  it("clears ?tab= from the URL when Untuk Anda is tapped again", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda("/beranda?tab=mengikuti");
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    fireEvent.click(tabButton("Untuk Anda"));

    await waitFor(() => {
      expect(url()).toBe("/beranda");
    });
  });

  /** A shared link. Nothing was clicked, so component state could not have produced this. */
  it("opens on Mengikuti when the URL already carries ?tab=mengikuti", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda("/beranda?tab=mengikuti");
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(tabButton("Mengikuti").getAttribute("aria-current")).toBe("true");
    expect(calls[0]!.url).toBe("/users/feed?tab=mengikuti");
  });

  /**
   * The reason the tab is in the URL at all. A real history stack, so going back
   * from Mengikuti lands on Untuk Anda instead of leaving the page.
   */
  it("restores the previous tab on a browser Back", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    const router = createMemoryRouter([{ path: "/beranda", element: <BerandaPage /> }], {
      initialEntries: ["/beranda"],
    });
    render(<RouterProvider router={router} />);
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    fireEvent.click(tabButton("Mengikuti"));
    await waitFor(() => {
      expect(router.state.location.search).toBe("?tab=mengikuti");
    });

    await act(async () => {
      await router.navigate(-1);
    });

    expect(router.state.location.search).toBe("");
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");
  });

  it("shows Mengikuti's own empty message, which points at an empty follow graph", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda("/beranda?tab=mengikuti");

    expect(await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.")).toBeTruthy();
    // The only answer to an empty follow graph, and this is where it is needed.
    const jelajah = screen.getAllByRole("link", { name: "Jelajah" });
    expect(jelajah.length).toBe(1);
    expect(jelajah[0]!.getAttribute("href")).toBe("/jelajah");
  });
});

describe("BerandaPage — signed out", () => {
  /**
   * The absence of the request is the assertion, not the presence of the text.
   * `listFeed("mengikuti")` goes through `apiFetch`, which clears the session
   * and throws `SESSION_EXPIRED_MESSAGE` on the 401 the server can only answer
   * with — so a visitor who was never signed in would be told their session had
   * expired. This test is what makes that path unreachable rather than merely
   * unlikely: it counts the requests.
   */
  it("fires NO request for Mengikuti and offers a link to /masuk", async () => {
    const calls = mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");
    expect(calls.length).toBe(1);

    fireEvent.click(tabButton("Mengikuti"));
    await settle();

    // Asserted FIRST, so it cannot be skipped by a later assertion failing.
    expect(calls.filter((call) => call.url.includes("tab=mengikuti")).length).toBe(0);
    expect(calls.length).toBe(1);

    const link = screen.getByRole("link", { name: "Masuk untuk melihat" });
    expect(link.getAttribute("href")).toBe("/masuk");
    // ...and the generic expiry sentence never appears on a page nobody was signed in to.
    expect(screen.queryAllByText(/Sesi Anda sudah berakhir/).length).toBe(0);
  });

  it("still loads Untuk Anda, because /beranda is a publicly reachable route", async () => {
    const calls = mockFetch(() =>
      jsonResponse({ posts: [makePost("p1", "kiriman publik")], nextCursor: null })
    );

    renderBeranda();

    expect(await screen.findByText("kiriman publik")).toBeTruthy();
    expect(calls[0]!.url).toBe("/users/feed?tab=untuk-anda");
    // No session, so nothing to attach — the anonymous request is byte-identical
    // to sending no headers at all.
    expect(new Headers(calls[0]!.init?.headers).has("Authorization")).toBe(false);
  });

  it("renders no composer at all", async () => {
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Kirim" }).length).toBe(0);
  });
});

describe("BerandaPage — signed in", () => {
  it("renders the composer", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    expect(screen.getByLabelText("Apa yang terjadi?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kirim" })).toBeTruthy();
  });

  it("sends the viewer's token on Mengikuti", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch(() => jsonResponse({ posts: [], nextCursor: null }));

    renderBeranda("/beranda?tab=mengikuti");
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("prepends a new post to the visible list with NO refetch", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse(makePost("p2", "kiriman baru"), 201);
      return jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await screen.findByText("kiriman baru");
    // One feed GET and one create POST. A third call would be a refetch.
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toBe("/users/posts");
    expect(calls[1]!.init?.method).toBe("POST");
    // At the TOP of the list, not appended to the bottom.
    expect(screen.getAllByRole("article")[0]!.textContent).toContain("kiriman baru");
    expect(screen.getByText("kiriman lama")).toBeTruthy();
  });

  /**
   * **The decision this task had to resolve, pinned.** The brief's own
   * `prepended` list — a second array of posts held by this page and rendered
   * above the feed — shows a new post twice the moment a tab switch refetches
   * it. The list lives in `PostFeed` behind `PostFeedHandle` instead, so
   * `PostFeed`'s existing "reset `posts` when `load` changes identity" effect
   * makes the duplicate structurally impossible rather than something this page
   * has to remember to clear.
   *
   * The refetch below deliberately DOES return the new post, which is what a
   * real server does by then; that is what makes a second copy possible at all.
   */
  it("shows a just-created post exactly once after switching tabs and back", async () => {
    setUserSession("jwt-abc", USER);
    let created = false;
    mockFetch((url, init) => {
      if (init?.method === "POST") {
        created = true;
        return jsonResponse(makePost("p2", "kiriman baru"), 201);
      }
      if (url.includes("tab=mengikuti")) return jsonResponse({ posts: [], nextCursor: null });
      return jsonResponse({
        posts: created
          ? [makePost("p2", "kiriman baru"), makePost("p1", "kiriman lama")]
          : [makePost("p1", "kiriman lama")],
        nextCursor: null,
      });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));
    await screen.findByText("kiriman baru");

    fireEvent.click(tabButton("Mengikuti"));
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    fireEvent.click(tabButton("Untuk Anda"));
    await screen.findByText("kiriman lama");

    expect(screen.getAllByText("kiriman baru").length).toBe(1);
  });

  /**
   * `mengikuti` is "posts by people you follow, NEVER your own" — measured in
   * `drizzle-post.repository.test.ts`. Prepending there would show a row the
   * next refetch silently removes, so the tab says what happened instead.
   */
  it("does not add a new post to the Mengikuti list, and says where it went", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse(makePost("p2", "kiriman baru"), 201);
      return jsonResponse({ posts: [], nextCursor: null });
    });

    renderBeranda("/beranda?tab=mengikuti");
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    expect(
      await screen.findByText("Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.")
    ).toBeTruthy();
    expect(screen.queryAllByRole("article").length).toBe(0);
  });

  it("keeps the typed text when the create fails, and shows Bahasa copy", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse({ error: "internal server error" }, 500);
      return jsonResponse({ posts: [], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "naskah yang panjang" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe(
      "naskah yang panjang"
    );
    expect(screen.queryAllByText(/internal server error/).length).toBe(0);
  });
});

/**
 * Fix round 1. Everything transient on this page is ABOUT a row in the list the
 * current tab is showing, and a tab change replaces that list wholesale. All
 * three of these survived a tab switch before the `useEffect` on `[tab]`.
 */
describe("BerandaPage — a tab change clears what belonged to the old tab", () => {
  it("does NOT show the sent notice again after leaving Mengikuti and returning", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse(makePost("p2", "kiriman baru"), 201);
      return jsonResponse({ posts: [], nextCursor: null });
    });

    renderBeranda("/beranda?tab=mengikuti");
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));
    await screen.findByText("Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.");

    fireEvent.click(tabButton("Untuk Anda"));
    await screen.findByText("Belum ada kiriman untuk ditampilkan.");
    expect(screen.queryAllByText(/Kiriman Anda terkirim/).length).toBe(0);

    // Back to Mengikuti. The notice was HIDDEN by the old `sentFrom === tab`
    // comparison, never cleared, so it came back here — announcing a post that
    // was sent minutes ago.
    fireEvent.click(tabButton("Mengikuti"));
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(screen.queryAllByText(/Kiriman Anda terkirim/).length).toBe(0);
  });

  it("drops a pending delete confirmation, so 'Ya, hapus' cannot fire for an unrendered post", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch((url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("tab=mengikuti")) return jsonResponse({ posts: [], nextCursor: null });
      return jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();

    fireEvent.click(tabButton("Mengikuti"));
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(screen.queryAllByText("Hapus kiriman ini?").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Ya, hapus" }).length).toBe(0);
    // No DELETE was ever sent — only the two feed GETs.
    expect(calls.filter((call) => call.init?.method === "DELETE").length).toBe(0);
  });

  it("closes an open edit composer, so Simpan cannot write to an unrendered post", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url) => {
      if (url.includes("tab=mengikuti")) return jsonResponse({ posts: [], nextCursor: null });
      return jsonResponse({ posts: [makePost("p1", "isi lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("isi lama");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();

    fireEvent.click(tabButton("Mengikuti"));
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(screen.queryAllByRole("button", { name: "Simpan" }).length).toBe(0);
    expect(screen.getByRole("button", { name: "Kirim" })).toBeTruthy();
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe("");
  });

  it("clears a delete failure", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      if (url.includes("tab=mengikuti")) return jsonResponse({ posts: [], nextCursor: null });
      return jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fireEvent.click(tabButton("Mengikuti"));
    await screen.findByText("Belum ada kiriman dari orang yang Anda ikuti.");

    expect(screen.queryAllByRole("alert").length).toBe(0);
  });
});

/**
 * Fix round 1, Concern 3 — measured by the reviewer, not merely reasoned.
 * `signedIn` is now a `useSyncExternalStore` subscription, the same pattern
 * `AppShell` uses, so a session cleared by `apiFetch`'s 401 handler reaches
 * this page immediately instead of at whatever render happens next.
 */
describe("BerandaPage — a session that expires mid-browse", () => {
  it("drops the composer when Mengikuti's 401 clears the session", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ error: "invalid or expired token" }, 401));

    renderBeranda("/beranda?tab=mengikuti");

    // The signed-out branch takes over: a live "Kirim" button attached to a
    // session that no longer exists is the state this replaces.
    expect(await screen.findByRole("link", { name: "Masuk untuk melihat" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Kirim" }).length).toBe(0);
    expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
    expect(getUserToken() === null).toBe(true);
  });
});

describe("BerandaPage — deleting your own post", () => {
  it("asks for confirmation before sending anything, then removes the row on confirm", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch((url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));

    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();
    // Nothing has been sent yet — the confirmation is not decoration.
    expect(calls.length).toBe(1);
    expect(screen.getByText("kiriman lama")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => {
      expect(screen.queryAllByText("kiriman lama").length).toBe(0);
    });
    expect(calls[1]!.url).toBe("/users/posts/p1");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });

  it("sends nothing and keeps the row when the confirmation is declined", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch(() =>
      jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null })
    );

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Tidak jadi" }));
    await settle();

    expect(calls.length).toBe(1);
    expect(screen.queryAllByText("Hapus kiriman ini?").length).toBe(0);
    expect(screen.getByText("kiriman lama")).toBeTruthy();
  });

  it("keeps the row and shows Bahasa copy when the delete fails", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      return jsonResponse({ posts: [makePost("p1", "kiriman lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman lama");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Gagal menghapus kiriman. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    expect(screen.getByText("kiriman lama")).toBeTruthy();
    expect(screen.queryAllByText(/internal server error/).length).toBe(0);
  });

  /**
   * Fix round 1. `setDeleteError(null)` in the `onDeleteRequested` and `onEdit`
   * handlers was removable with the suite green. The behaviour it produces is
   * right and worth keeping, so it is pinned rather than deleted: a failure
   * about the LAST delete must not sit under the confirmation panel for the
   * NEXT one, where it reads as a failure that has already happened to the post
   * you are about to confirm.
   */
  it("clears a previous delete failure when another delete is requested", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      return jsonResponse({
        posts: [makePost("p1", "kiriman satu"), makePost("p2", "kiriman dua")],
        nextCursor: null,
      });
    });

    renderBeranda();
    await screen.findByText("kiriman satu");

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[1]!);

    expect(screen.queryAllByRole("alert").length).toBe(0);
    expect(screen.getByText("Hapus kiriman ini?")).toBeTruthy();
  });

  it("clears a previous delete failure when an edit is started instead", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "internal server error" }, 500);
      return jsonResponse({ posts: [makePost("p1", "kiriman satu")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("kiriman satu");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryAllByRole("alert").length).toBe(0);
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();
  });

  it("offers no owner controls on somebody else's post", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() =>
      jsonResponse({ posts: [makePost("p9", "kiriman budi", "budi")], nextCursor: null })
    );

    renderBeranda();
    await screen.findByText("kiriman budi");

    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
  });
});

describe("BerandaPage — editing your own post", () => {
  it("opens the composer pre-filled, saves in place, and shows the diedit marker", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch((url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ...makePost("p1", "isi baru"),
          editedAt: "2026-08-18T01:00:00.000Z",
        });
      }
      return jsonResponse({ posts: [makePost("p1", "isi lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("isi lama");
    expect(screen.queryAllByText(/diedit/).length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const box = screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement;
    expect(box.value).toBe("isi lama");
    expect(screen.getByRole("button", { name: "Simpan" })).toBeTruthy();

    fireEvent.change(box, { target: { value: "isi baru" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await screen.findByText("isi baru");
    expect(calls[1]!.url).toBe("/users/posts/p1");
    expect(calls[1]!.init?.method).toBe("PATCH");
    // In place: one row, the old text gone, the edit marker on.
    expect(screen.getAllByRole("article").length).toBe(1);
    expect(screen.queryAllByText("isi lama").length).toBe(0);
    expect(screen.queryAllByText(/diedit/).length).toBeGreaterThan(0);
    // ...and the composer is back to composing.
    expect(screen.getByRole("button", { name: "Kirim" })).toBeTruthy();
  });

  it("keeps the edited text and leaves the row alone when the save fails", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch((url, init) => {
      if (init?.method === "PATCH") return jsonResponse({ error: "internal server error" }, 500);
      return jsonResponse({ posts: [makePost("p1", "isi lama")], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("isi lama");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "isi baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Kiriman gagal disimpan. Server sedang bermasalah. Coba lagi sebentar lagi."
      );
    });
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe(
      "isi baru"
    );
    expect(screen.getByText("isi lama")).toBeTruthy();
  });

  /**
   * Fix round 1, Minor. `key={editing.id}` on the edit composer was deletable
   * with all 23 tests green, because nothing ever opened a SECOND edit without
   * cancelling the first. `initialBody` only seeds `useState`, so without the
   * key React reuses the same component instance and its stale body:
   * tap Edit on A, then Edit on B, and B's box holds A's text — then Simpan
   * writes A's words onto B's post. Two own posts is all it takes to see it.
   */
  it("re-fills the box when Edit is tapped on a SECOND post without cancelling the first", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() =>
      jsonResponse({
        posts: [makePost("p1", "isi satu"), makePost("p2", "isi dua")],
        nextCursor: null,
      })
    );

    renderBeranda();
    await screen.findByText("isi satu");

    const editButtons = () => screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons().length).toBe(2);

    fireEvent.click(editButtons()[0]!);
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe(
      "isi satu"
    );

    fireEvent.click(editButtons()[1]!);

    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe(
      "isi dua"
    );
  });

  /**
   * The harm the missing key actually does, rather than the state that causes
   * it. Nothing is retyped: the box is submitted exactly as the second Edit
   * left it. Without the key that is the FIRST post's body, sent to the SECOND
   * post's id — one tap silently overwrites B's words with A's.
   */
  it("saves the SECOND post's own text, never the first post's, when Edit is tapped twice", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch((url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ ...makePost("p2", "isi dua"), editedAt: "2026-08-18T01:00:00.000Z" });
      }
      return jsonResponse({
        posts: [makePost("p1", "isi satu"), makePost("p2", "isi dua")],
        nextCursor: null,
      });
    });

    renderBeranda();
    await screen.findByText("isi satu");

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(calls.length).toBe(2);
    });
    expect(calls[1]!.url).toBe("/users/posts/p2");
    expect(JSON.parse(String(calls[1]!.init?.body)).body).toBe("isi dua");
    expect(screen.getByText("isi satu")).toBeTruthy();
  });

  it("abandons an edit on Batal, returning to the create composer", async () => {
    setUserSession("jwt-abc", USER);
    const calls = mockFetch(() =>
      jsonResponse({ posts: [makePost("p1", "isi lama")], nextCursor: null })
    );

    renderBeranda();
    await screen.findByText("isi lama");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    await settle();

    expect(calls.length).toBe(1);
    expect((screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Kirim" })).toBeTruthy();
    expect(screen.getByText("isi lama")).toBeTruthy();
  });

  /**
   * Fix round 1, item 2 (a parked finding from Task 5, fixed on the profile in
   * the same round). `onEdit` and `onDeleteRequested` each cleared
   * `deleteError` but neither cleared the OTHER's own state — Hapus then Edit
   * rendered the edit composer AND the "Hapus kiriman ini?" panel at once.
   */
  it("opening Edit closes an open delete confirmation, and requesting a delete closes an open edit composer", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: [makePost("p1", "isi lama")], nextCursor: null }));

    renderBeranda();
    await screen.findByText("isi lama");

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
 * **Whole-branch review, I2.** The confirmation panel and the edit composer
 * both render ABOVE the feed, so with 20 posts loaded, tapping Hapus on the
 * 20th inserted "Hapus kiriman ini?" roughly twenty rows above the viewport
 * with `document.activeElement` still on `body` — nothing scrolled, nothing
 * took focus, no live region announced it. On a 390px phone that is four to
 * six cards per screen, so **from about the sixth post down, tapping Hapus or
 * Edit appeared to do nothing at all.** The audience is phone-first.
 *
 * Neither happy-dom (which has no layout) nor the Playwright gate (whose
 * `.click()` auto-scrolls the target into view before clicking) can see the
 * scroll half, which is why it survived a 59-check browser gate. What happy-dom
 * CAN see is asserted here: `scrollIntoView` was called on the right element,
 * focus moved to it, and the panel carries the announcing role.
 */
/**
 * **Never let a happy-dom node reach a bun:test failure diff.** `expect(node)`
 * serialises the element's whole object graph to build the message: measured
 * with bun 1.3.14, a failing `toEqual` against a BARE detached `<div>` builds
 * an 848 KB message and a failing `toBe` a 2 MB one. Against a node attached to
 * a document holding twenty rendered posts it does not terminate — it allocated
 * ~80 MB/s until the OOM killer took the process, and on a machine without swap
 * that takes the machine with it. Identity is compared as a BOOLEAN here, so a
 * regression prints `true !== false` and the suite stays runnable.
 *
 * `name` is what the failure says instead of the node, since a bare boolean
 * names nothing.
 */
function isNode(actual: unknown, expected: Element | null, name: string): string {
  return actual === expected ? name : `NOT ${name}`;
}

describe("BerandaPage — the panel and the composer bring themselves into view (I2)", () => {
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
  let scrolled: { element: Element; options: unknown }[];

  beforeEach(() => {
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      scrolled.push({ element: this, options });
    };
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  /** Twenty rows, so the panel really is far from the tapped card — the measured shape of the bug. */
  function twentyPosts(): PostView[] {
    return Array.from({ length: 20 }, (_, index) => makePost(`p${index + 1}`, `kiriman ${index + 1}`));
  }

  it("tapping Hapus on the LAST of twenty posts scrolls the confirmation panel into view and focuses it", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: twentyPosts(), nextCursor: null }));

    renderBeranda();
    await screen.findByText("kiriman 20");

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[19]!);

    // PRESENCE control: the panel is on screen at all, and announces itself.
    // `alertdialog` is the role `MembersPage`'s own two confirmation panels
    // already use — a screen reader announces it on arrival, which `group`
    // (what this was) does not.
    const panel = screen.getByRole("alertdialog", { name: "Konfirmasi hapus" });
    expect(panel.textContent).toContain("Hapus kiriman ini?");

    expect(scrolled.length).toBe(1);
    expect(isNode(scrolled[0]!.element, panel, "the panel")).toBe("the panel");
    expect(scrolled[0]!.options).toEqual({ block: "center" });
    // Focus lands on the PANEL, never on "Ya, hapus" — a stray Enter must not
    // delete a post.
    expect(isNode(document.activeElement, panel, "the panel")).toBe("the panel");
  });

  it("tapping Edit on the LAST of twenty posts scrolls the composer into view and puts the caret in the box", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: twentyPosts(), nextCursor: null }));

    renderBeranda();
    await screen.findByText("kiriman 20");

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[19]!);

    // PRESENCE control: the edit composer opened, pre-filled with THAT post.
    const box = screen.getByLabelText("Apa yang terjadi?") as HTMLTextAreaElement;
    expect(box.value).toBe("kiriman 20");

    expect(scrolled.length).toBe(1);
    // The composer's own `<form>` — asserted as the textarea's parent rather
    // than with `element.contains(box)`, which this happy-dom version answers
    // `false` for even a direct child (measured while writing this test).
    expect(isNode(scrolled[0]!.element, box.parentElement, "the composer form")).toBe(
      "the composer form"
    );
    expect(scrolled[0]!.options).toEqual({ block: "center" });
    expect(isNode(document.activeElement, box, "the textarea")).toBe("the textarea");
  });

  it("re-opens for a DIFFERENT post: the panel scrolls and refocuses again", async () => {
    setUserSession("jwt-abc", USER);
    mockFetch(() => jsonResponse({ posts: twentyPosts(), nextCursor: null }));

    renderBeranda();
    await screen.findByText("kiriman 20");

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[19]!);
    const panel = screen.getByRole("alertdialog", { name: "Konfirmasi hapus" });
    // Focus somewhere else, exactly as a reader scrolling away would.
    (screen.getAllByRole("button", { name: "Hapus" })[0] as HTMLButtonElement).focus();
    expect(isNode(document.activeElement, panel, "the panel")).toBe("NOT the panel");

    fireEvent.click(screen.getAllByRole("button", { name: "Hapus" })[0]!);

    // Same panel element (it never unmounted), revealed a second time for the
    // new post — the effect is keyed on the post's id, not on mounting.
    expect(scrolled.length).toBe(2);
    expect(
      isNode(
        document.activeElement,
        screen.getByRole("alertdialog", { name: "Konfirmasi hapus" }),
        "the panel"
      )
    ).toBe("the panel");
  });
});

/**
 * Task 8. `PostComposer` and `MediaStrip` are tested on their own; these two
 * pin the WIRING — that the ids the strip collected actually reach
 * `createPost`/`editPost` through this page, in order, as the complete list.
 * Without them, `handleCreate` could drop its second argument and the whole
 * media suite would stay green while no photo ever reached a post.
 */
describe("BerandaPage — a post carries its photos (Task 8)", () => {
  it("sends the uploaded ids with the new post, in order", async () => {
    setUserSession("jwt-abc", USER);
    let uploaded = 0;
    const calls = mockFetch((url, init) => {
      if (url === "/users/media") {
        uploaded += 1;
        return jsonResponse({ id: `media-${uploaded}`, width: 800, height: 600 }, 201);
      }
      if (init?.method === "POST") return jsonResponse(makePost("p2", "kiriman baru"), 201);
      return jsonResponse({ posts: [], nextCursor: null });
    });

    renderBeranda();
    await screen.findByRole("button", { name: "Kirim" });

    fireEvent.change(screen.getByTestId("media-picker"), {
      target: {
        files: [
          new File([new Uint8Array([1])], "satu.jpg", { type: "image/jpeg" }),
          new File([new Uint8Array([2])], "dua.jpg", { type: "image/jpeg" }),
        ],
      },
    });
    // The strip's progress indicators disappear when both uploads have landed.
    await waitFor(() => {
      expect(screen.queryAllByRole("progressbar").length).toBe(0);
    });

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await screen.findByText("kiriman baru");
    const created = calls.find((call) => call.url === "/users/posts")!;
    expect(JSON.parse(String(created.init?.body))).toEqual({
      body: "kiriman baru",
      mediaIds: ["media-1", "media-2"],
    });
  });

  it("an edit sends the post's images back as the COMPLETE list, minus the one removed", async () => {
    setUserSession("jwt-abc", USER);
    const withPhotos = {
      ...makePost("p1", "isi lama"),
      media: [
        { id: "media-1", width: 800, height: 600 },
        { id: "media-2", width: 800, height: 600 },
      ],
    };
    const calls = mockFetch((url, init) => {
      if (init?.method === "PATCH") return jsonResponse({ ...withPhotos, body: "isi baru" });
      return jsonResponse({ posts: [withPhotos], nextCursor: null });
    });

    renderBeranda();
    await screen.findByText("isi lama");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Seeded from the post: both images are in the strip, as thumbnails.
    // Queried by the STRIP's own alt text rather than by role, so this keeps
    // meaning the strip once Task 9 renders images on the card too.
    expect(
      screen.getAllByAltText(/^Pratinjau foto/).map((img) => img.getAttribute("src"))
    ).toEqual(["/users/media/media-1/thumb", "/users/media/media-2/thumb"]);

    fireEvent.click(screen.getByRole("button", { name: "Hapus foto 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await screen.findByText("isi baru");
    const patched = calls.find((call) => call.init?.method === "PATCH")!;
    expect(JSON.parse(String(patched.init?.body))).toEqual({
      body: "isi lama",
      mediaIds: ["media-2"],
    });
  });
});
