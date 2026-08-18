import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PostFeed from "./PostFeed";
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

  it("calls onDeleted with the post's id when Hapus is clicked on an owned post", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [makePost("1", "wildan")], nextCursor: null })
    ) as unknown as typeof fetch;
    const onDeleted = mock(() => {});

    renderFeed({ ownHandle: "wildan", onDeleted });
    await screen.findByText("Isi kiriman 1");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith("1");
  });
});
