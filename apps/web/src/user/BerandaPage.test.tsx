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
import { setUserSession, type PostView } from "./apiClient";

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
});
