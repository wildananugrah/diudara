import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SiaranPage from "./SiaranPage";
import type { AttachHlsInput, StreamPlayerHandle } from "./StreamPlayer";
import type { StreamView } from "./apiClient";

/**
 * `/siaran` — who is live, and a lock where a stranger cannot watch (task
 * brief; design spec §8). `GET /streams` is mocked directly on
 * `global.fetch` for every test here, the same shape `WatchPage.test.tsx`
 * uses for `GET /c/watch/:token` — `SiaranPage` never reads `import.meta`
 * config or anything else that would need a heavier mock.
 *
 * A fake `attachHls` is injected into every test that exercises an UNLOCKED
 * row, so a real `hls.js` attach (unreachable in happy-dom — there is no
 * `MediaSource`) is never on the critical path of any assertion here. See
 * `StreamPlayer.test.tsx` for the re-mint loop itself; this file only
 * proves `SiaranPage` wires `locked` into the right branch and reaches the
 * right copy.
 */

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockStreams(streams: StreamView[]): void {
  global.fetch = mock(async () => jsonResponse({ streams })) as unknown as typeof fetch;
}

const PUBLIC_STREAM: StreamView = {
  id: "stream-public",
  title: "Ngobrol santai",
  visibility: "public",
  owner: { handle: "wildan", displayName: "Wildan" },
  locked: false,
  hlsPlaybackPath: "/u/stream-public/index.m3u8",
};

const LOCKED_STREAM: StreamView = {
  id: "stream-locked",
  title: "Bedah karya",
  visibility: "members",
  owner: { handle: "sari", displayName: "Sari" },
  locked: true,
  // Deliberately no `hlsPlaybackPath` key at all — the API omits it,
  // never sends `null`. See `StreamView`'s own docstring in `apiClient.ts`.
};

/** A fake `attachHls` that never touches real `hls.js`, for the rows this suite renders unlocked. */
function fakeAttach(): { destroy(): void } | null {
  return { destroy() {} } satisfies StreamPlayerHandle;
}

/** `SiaranPage` renders `<Link>`s (the owner identity, the lock) — every render needs a router context, the same reason `PostCard.test.tsx`/`ProfilePage.test.tsx` wrap with `MemoryRouter`. */
function renderSiaran(props?: { attachHls?: (input: AttachHlsInput) => { destroy(): void } | null }) {
  return render(
    <MemoryRouter>
      <SiaranPage attachHls={props?.attachHls} />
    </MemoryRouter>
  );
}

describe("SiaranPage — a public stream renders the player, not a lock", () => {
  it("renders StreamPlayer, and never the lock, for an unlocked row", async () => {
    mockStreams([PUBLIC_STREAM]);

    renderSiaran({ attachHls: (_input: AttachHlsInput) => fakeAttach() });

    await waitFor(() => expect(screen.queryAllByTestId("stream-player").length).toBe(1));
    expect(screen.queryAllByTestId("stream-lock").length).toBe(0);
  });

  it("attaches, and a <video> element actually mounts", async () => {
    mockStreams([PUBLIC_STREAM]);

    renderSiaran({ attachHls: (_input: AttachHlsInput) => fakeAttach() });

    await waitFor(() => expect(document.querySelectorAll("video").length).toBe(1));
  });
});

describe("SiaranPage — a gated stream", () => {
  it("renders the lock, the title, and the owner", async () => {
    mockStreams([LOCKED_STREAM]);

    renderSiaran();
    await screen.findByText("Bedah karya");

    const text = screen.getByTestId("siaran").textContent ?? "";
    expect(text).toContain("Bedah karya");
    expect(text).toContain("Jadi anggota untuk menonton");
  });

  it("the lock's copy is EXACT — catches text appended after it", async () => {
    mockStreams([LOCKED_STREAM]);

    renderSiaran();

    const lock = await screen.findByTestId("stream-lock");
    expect(lock.textContent).toBe("Jadi anggota untuk menonton");
  });

  it("no playback path for a gated stream reaches the DOM", async () => {
    mockStreams([LOCKED_STREAM]);

    renderSiaran();

    await screen.findByTestId("stream-lock");
    expect(document.body.innerHTML).not.toContain(".m3u8");
  });

  it("never renders StreamPlayer for a locked row", async () => {
    mockStreams([LOCKED_STREAM]);

    renderSiaran();

    await screen.findByTestId("stream-lock");
    expect(screen.queryAllByTestId("stream-player").length).toBe(0);
  });

  it("tapping the lock links to the owner's profile", async () => {
    mockStreams([LOCKED_STREAM]);

    renderSiaran();

    const lock = await screen.findByTestId("stream-lock");
    expect(lock.getAttribute("href")).toBe("/@sari");
  });
});

describe("SiaranPage — the empty state is honest", () => {
  it("shows the empty-state copy, verbatim, when nobody is live", async () => {
    mockStreams([]);

    renderSiaran();

    await waitFor(() =>
      expect(screen.getByTestId("siaran").textContent).toContain("Belum ada siaran langsung.")
    );
  });

  it("never shows the empty-state copy while the first fetch is still in flight", async () => {
    let resolveFetch!: (res: Response) => void;
    global.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    renderSiaran();

    expect(screen.queryAllByText("Belum ada siaran langsung.").length).toBe(0);

    resolveFetch(jsonResponse({ streams: [] }));
    await waitFor(() =>
      expect(screen.queryAllByText("Belum ada siaran langsung.").length).toBe(1)
    );
  });
});

describe("SiaranPage — a failed listing never shows the server's own words", () => {
  it("shows a Bahasa sentence, not the raw error, on a 500", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "internal server error" }, 500)
    ) as unknown as typeof fetch;

    renderSiaran();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("internal server error");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
  });
});

describe("SiaranPage — both a locked and an unlocked row, together", () => {
  it("shows one lock and one player, and no leaked playback path for the locked one", async () => {
    mockStreams([LOCKED_STREAM, PUBLIC_STREAM]);

    renderSiaran({ attachHls: (_input: AttachHlsInput) => fakeAttach() });

    await waitFor(() => expect(screen.queryAllByTestId("stream-lock").length).toBe(1));
    await waitFor(() => expect(screen.queryAllByTestId("stream-player").length).toBe(1));
  });
});
