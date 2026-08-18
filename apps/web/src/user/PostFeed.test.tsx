import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { MemoryRouter } from "react-router-dom";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import { listFeed, type PostView } from "./apiClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makePost(id: string, handle = "wildan"): PostView {
  return {
    id,
    body: `Isi kiriman ${id}`,
    createdAt: "2026-08-18T00:00:00.000Z",
    editedAt: null,
    author: { handle, displayName: "Wildan" },
  };
}

/**
 * A stable, module-level function — never recreated per render. Exactly the
 * "caller memoises `load`" contract `PostFeed`'s own docstring requires: a
 * fresh closure passed in on every render is the hang this component's tests
 * exist to catch, not a slowdown.
 */
function load(before: string | null) {
  return listFeed("untuk-anda", before);
}

function renderFeed(props: Partial<Parameters<typeof PostFeed>[0]> = {}) {
  return render(
    <MemoryRouter>
      <PostFeed load={load} emptyMessage="Belum ada kiriman." ownHandle={null} {...props} />
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("PostFeed", () => {
  it("renders emptyMessage and no 'Muat lebih banyak' button for an empty first page", async () => {
    global.fetch = mock(async () => jsonResponse({ posts: [], nextCursor: null })) as unknown as typeof fetch;

    renderFeed();

    expect(await screen.findByText("Belum ada kiriman.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Muat lebih banyak" }).length).toBe(0);
  });

  it("renders the button when nextCursor is present; clicking it appends posts and sends before=<cursor>", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return jsonResponse({ posts: [makePost("1")], nextCursor: "cursor-a" });
      return jsonResponse({ posts: [makePost("2")], nextCursor: "cursor-b" });
    }) as unknown as typeof fetch;

    renderFeed();
    await screen.findByText("Isi kiriman 1");
    const button = screen.getByRole("button", { name: "Muat lebih banyak" });

    fireEvent.click(button);

    await screen.findByText("Isi kiriman 2");
    // Checked BEFORE the "still on screen" assertion below: with the append
    // logic keyed off `before === null`, a mutation that drops the cursor
    // (calling `fetchPage(null)` on click) makes posts get REPLACED rather
    // than appended, which would otherwise fail the assertion below first and
    // mask the fact that the URL itself never carried `before=` at all. This
    // line is the one that actually proves the cursor was forwarded.
    expect(calls[1]).toBe("/users/feed?tab=untuk-anda&before=cursor-a");
    // The first page's post is still there — appended, not replaced.
    expect(screen.getByText("Isi kiriman 1")).toBeTruthy();
  });

  it("hides the button once a page comes back with nextCursor: null", async () => {
    const calls: string[] = [];
    global.fetch = mock(async () => {
      calls.push("x");
      if (calls.length === 1) return jsonResponse({ posts: [makePost("1")], nextCursor: "cursor-a" });
      return jsonResponse({ posts: [makePost("2")], nextCursor: null });
    }) as unknown as typeof fetch;

    renderFeed();
    const button = await screen.findByRole("button", { name: "Muat lebih banyak" });
    fireEvent.click(button);

    await screen.findByText("Isi kiriman 2");
    expect(screen.queryAllByRole("button", { name: "Muat lebih banyak" }).length).toBe(0);
  });

  /**
   * The final review of Phase 2 made exactly this a merge blocker: a failed
   * "load more" must not wipe out what already rendered. `error` is held
   * separately from `posts` for exactly this reason — see `PostFeed.tsx`'s
   * own docstring.
   */
  it("keeps posts already on screen when a 'load more' fails, and shows Bahasa error copy", async () => {
    const calls: string[] = [];
    global.fetch = mock(async () => {
      calls.push("x");
      if (calls.length === 1) return jsonResponse({ posts: [makePost("1")], nextCursor: "cursor-a" });
      return jsonResponse({ error: "internal server error" }, 500);
    }) as unknown as typeof fetch;

    renderFeed();
    const button = await screen.findByRole("button", { name: "Muat lebih banyak" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    });
    // Still on screen — the point of the test.
    expect(screen.getByText("Isi kiriman 1")).toBeTruthy();
  });

  it("never renders the server's own error text — describeRequestFailure only", async () => {
    const calls: string[] = [];
    global.fetch = mock(async () => {
      calls.push("x");
      if (calls.length === 1) return jsonResponse({ posts: [makePost("1")], nextCursor: "cursor-a" });
      return jsonResponse({ error: "internal server error" }, 500);
    }) as unknown as typeof fetch;

    renderFeed();
    const button = await screen.findByRole("button", { name: "Muat lebih banyak" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    });
    expect(screen.queryAllByText("internal server error").length).toBe(0);
    expect(screen.queryAllByText(/internal server error/).length).toBe(0);
  });

  /**
   * Fix round 1, I3. Every other top-level request-failure element under
   * `src/user` (`FollowButton`, `LoginPage`, `SignupPage`, `ResetCompletePage`,
   * `SettingsPage`, both Jelajah error paragraphs) carries `role="alert"`;
   * `PostFeed`'s error paragraph came from the brief's own code sample, which
   * omitted it — the one place this component diverged from the rest of the
   * codebase's accessibility convention. Pinned explicitly, via `role`, so the
   * next component copied from this one inherits the right thing rather than
   * the gap.
   */
  it("exposes the feed error as role=alert, matching every other error paragraph under src/user", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderFeed();

    const alert = await screen.findByRole("alert");
    expect(alert.className).toBe("feed-error");
  });

  it('clicking "Muat lebih banyak" twice quickly fires only one extra request', async () => {
    let resolveSecond: (res: Response) => void = () => {};
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) return jsonResponse({ posts: [makePost("1")], nextCursor: "cursor-a" });
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    }) as unknown as typeof fetch;

    renderFeed();
    const button = await screen.findByRole("button", { name: "Muat lebih banyak" });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    resolveSecond(jsonResponse({ posts: [makePost("2")], nextCursor: null }));
    await screen.findByText("Isi kiriman 2");

    // One request for the first page, one for the (only) "load more".
    expect(calls.length).toBe(2);
  });

  /**
   * `load` must be memoised by the caller (`useCallback`/module-level
   * function) or the effect refetches on every render — a hang, not a
   * slowdown, since Beranda's tabs rely on `load`'s identity changing only
   * when the tab does. This module's own `load` function is stable across
   * renders (declared once, at module scope), so a correctly-memoised caller
   * must produce exactly one request here.
   */
  it("issues exactly one request for a stable, memoised load prop", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ posts: [makePost("1")], nextCursor: null });
    }) as unknown as typeof fetch;

    renderFeed();

    await screen.findByText("Isi kiriman 1");
    // Give any further render/effect cycles a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.length).toBe(1);
  });

  it("passes isOwn=true only for posts whose author handle matches ownHandle", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [makePost("1", "wildan"), makePost("2", "budi")], nextCursor: null })
    ) as unknown as typeof fetch;

    renderFeed({ ownHandle: "wildan" });

    await screen.findByText("Isi kiriman 1");
    // Only the post authored by "wildan" gets owner controls.
    expect(screen.getAllByRole("button", { name: "Hapus" }).length).toBe(1);
  });

  it("calls onDeleteRequested with the post's id when Hapus is clicked on an owned post", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [makePost("1", "wildan")], nextCursor: null })
    ) as unknown as typeof fetch;
    const onDeleteRequested = mock(() => {});

    renderFeed({ ownHandle: "wildan", onDeleteRequested });
    await screen.findByText("Isi kiriman 1");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));

    expect(onDeleteRequested).toHaveBeenCalledTimes(1);
    expect(onDeleteRequested).toHaveBeenCalledWith("1");
  });

  /**
   * Fix round 1, R4. The callback fires on the TAP, before any DELETE exists —
   * it was called `onDeleted` with a docstring claiming "the row is gone once
   * this fires", which was false in both halves. This pins the true half: the
   * feed does NOT remove anything of its own accord, so a consumer that wires a
   * list removal straight to this callback is removing a row the server was
   * never asked about.
   */
  it("does NOT remove the row itself when Hapus is tapped — the caller decides", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [makePost("1", "wildan")], nextCursor: null })
    ) as unknown as typeof fetch;

    renderFeed({ ownHandle: "wildan", onDeleteRequested: () => {} });
    await screen.findByText("Isi kiriman 1");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));

    expect(screen.getByText("Isi kiriman 1")).toBeTruthy();
    expect(screen.getAllByRole("article").length).toBe(1);
  });
});

/**
 * Fix round 1, I1 and I2. `PostFeedHandle` is the seam Task 5 added so a page
 * can mutate the list this component owns, and it had NO direct tests at all —
 * every exercise of it went through `BerandaPage.test.tsx`, whose fixtures are
 * all ONE row. With one row, "removes the row" cannot tell the right row from
 * row 0, and "in place" has no position to keep. Both were measured green under
 * mutation:
 *
 * | mutation | web suite |
 * |---|---|
 * | `remove` → `current.slice(1)` | 598 pass / 0 fail |
 * | `replace` → `[...current.filter(...), post]` | 598 pass / 0 fail |
 *
 * So every test below uses THREE rows and asserts the ORDER, not just the
 * membership. Task 6 consumes this handle next.
 */
describe("PostFeed — PostFeedHandle", () => {
  /** The bodies of every rendered row, in document order. Order is the whole point here. */
  function bodies(): string[] {
    return screen
      .getAllByRole("article")
      .map((article) => article.querySelector(".post-card-body")?.textContent ?? "");
  }

  async function renderThreeRows(): Promise<RefObject<PostFeedHandle | null>> {
    global.fetch = mock(async () =>
      jsonResponse({
        posts: [makePost("1"), makePost("2"), makePost("3")],
        nextCursor: null,
      })
    ) as unknown as typeof fetch;
    const handle = createRef<PostFeedHandle>();

    renderFeed({ ref: handle, ownHandle: "wildan" });
    await screen.findByText("Isi kiriman 1");
    // Guards every assertion below: if the fixture were not three rows, "the
    // MIDDLE one" would mean nothing.
    expect(bodies()).toEqual(["Isi kiriman 1", "Isi kiriman 2", "Isi kiriman 3"]);

    return handle;
  }

  it("remove drops the post with THAT id, not whichever row happens to be first", async () => {
    const handle = await renderThreeRows();

    act(() => handle.current!.remove("2"));

    expect(bodies()).toEqual(["Isi kiriman 1", "Isi kiriman 3"]);
  });

  it("remove leaves the list untouched for an id that is not on screen", async () => {
    const handle = await renderThreeRows();

    act(() => handle.current!.remove("99"));

    expect(bodies()).toEqual(["Isi kiriman 1", "Isi kiriman 2", "Isi kiriman 3"]);
  });

  it("replace swaps a post IN PLACE — the row keeps its position", async () => {
    const handle = await renderThreeRows();

    act(() => handle.current!.replace({ ...makePost("2"), body: "Isi kiriman 2 (diubah)" }));

    // Still in the MIDDLE. A replace that removed and re-appended would put it
    // last, which is what a reader watching their own edit would experience as
    // the post jumping to the bottom of the feed.
    expect(bodies()).toEqual([
      "Isi kiriman 1",
      "Isi kiriman 2 (diubah)",
      "Isi kiriman 3",
    ]);
  });

  it("replace leaves the list untouched for a post that is not on screen", async () => {
    const handle = await renderThreeRows();

    act(() => handle.current!.replace({ ...makePost("99"), body: "tidak ada di sini" }));

    expect(bodies()).toEqual(["Isi kiriman 1", "Isi kiriman 2", "Isi kiriman 3"]);
    expect(screen.queryAllByText("tidak ada di sini").length).toBe(0);
  });

  it("prepend puts the post at the TOP and keeps the rest in order", async () => {
    const handle = await renderThreeRows();

    act(() => handle.current!.prepend({ ...makePost("0"), body: "Isi kiriman baru" }));

    expect(bodies()).toEqual([
      "Isi kiriman baru",
      "Isi kiriman 1",
      "Isi kiriman 2",
      "Isi kiriman 3",
    ]);
  });

  it("keeps the handle usable across a refetch, still targeting the right row", async () => {
    // The handle's identity is stable (empty `useImperativeHandle` deps) while
    // `posts` underneath it is replaced wholesale by a refetch. This pins that
    // the two stay connected — a handle that closed over a stale `posts` would
    // operate on the previous page.
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        posts:
          calls.length === 1
            ? [makePost("1"), makePost("2")]
            : [makePost("7"), makePost("8"), makePost("9")],
        nextCursor: "cursor-a",
      });
    }) as unknown as typeof fetch;
    const handle = createRef<PostFeedHandle>();

    renderFeed({ ref: handle, ownHandle: "wildan" });
    await screen.findByText("Isi kiriman 1");

    fireEvent.click(screen.getByRole("button", { name: "Muat lebih banyak" }));
    await screen.findByText("Isi kiriman 8");

    act(() => handle.current!.remove("8"));

    expect(bodies()).toEqual([
      "Isi kiriman 1",
      "Isi kiriman 2",
      "Isi kiriman 7",
      "Isi kiriman 9",
    ]);
  });
});
