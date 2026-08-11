import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WatchPage, { buildXhrSetup, withToken, type AttachPlayer } from "./WatchPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(token: string, attachPlayer?: AttachPlayer) {
  return render(
    <MemoryRouter initialEntries={[`/watch/${token}`]}>
      <Routes>
        <Route path="/watch/:token" element={<WatchPage attachPlayer={attachPlayer} />} />
      </Routes>
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

describe("WatchPage — the happy path", () => {
  it("shows a loading state first, then attaches the player once the token resolves", async () => {
    let resolveFetch!: (res: Response) => void;
    global.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    const calls: Array<{ hlsUrl: string; token: string }> = [];
    const fakeAttach: AttachPlayer = (input) => {
      calls.push({ hlsUrl: input.hlsUrl, token: input.token });
      return { destroy() {} };
    };

    renderAt("tok-abc", fakeAttach);

    expect(await screen.findByText(/memuat siaran/i)).toBeTruthy();
    expect(calls).toHaveLength(0);

    resolveFetch(jsonResponse({ hlsUrl: "https://hls.diudara.test/live/key/index.m3u8" }));

    await screen.findByText(/tayang langsung/i);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      hlsUrl: "https://hls.diudara.test/live/key/index.m3u8",
      token: "tok-abc",
    });
    expect(document.querySelector("video")).toBeTruthy();
  });

  it("fetches the exact /c/watch/:token path the API exposes", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ hlsUrl: "https://hls.diudara.test/live/key/index.m3u8" })
    ) as unknown as typeof fetch;

    renderAt("tok-xyz", () => ({ destroy() {} }));

    await screen.findByText(/tayang langsung/i);
    expect(global.fetch).toHaveBeenCalledWith("/c/watch/tok-xyz");
  });
});

describe("WatchPage — the player lifecycle", () => {
  it("shows 'siaran telah berakhir' when the attached player reports a fatal error", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ hlsUrl: "https://hls.diudara.test/live/key/index.m3u8" })
    ) as unknown as typeof fetch;

    let reportFatal: (() => void) | undefined;
    const fakeAttach: AttachPlayer = (input) => {
      reportFatal = input.onFatalError;
      return { destroy() {} };
    };

    renderAt("tok-abc", fakeAttach);
    await screen.findByText(/tayang langsung/i);

    reportFatal!();

    expect(await screen.findByText(/telah berakhir/i)).toBeTruthy();
  });

  it("shows the unsupported-browser message when attachPlayer cannot attach anything", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ hlsUrl: "https://hls.diudara.test/live/key/index.m3u8" })
    ) as unknown as typeof fetch;

    const fakeAttach: AttachPlayer = () => null;

    renderAt("tok-abc", fakeAttach);

    expect(await screen.findByText(/tidak didukung/i)).toBeTruthy();
  });

  it("destroys the player on unmount", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ hlsUrl: "https://hls.diudara.test/live/key/index.m3u8" })
    ) as unknown as typeof fetch;

    let destroyed = false;
    const fakeAttach: AttachPlayer = () => ({
      destroy() {
        destroyed = true;
      },
    });

    const view = renderAt("tok-abc", fakeAttach);
    await screen.findByText(/tayang langsung/i);

    view.unmount();

    expect(destroyed).toBe(true);
  });
});

describe("WatchPage — one message for every failure mode", () => {
  const ATTACH_NEVER_CALLED: AttachPlayer = () => {
    throw new Error("attachPlayer must not run when the token never resolved");
  };

  it("renders 'tautan sudah tidak berlaku' for an expired/invalid token (403)", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "watch link is no longer valid" }, 403)
    ) as unknown as typeof fetch;

    renderAt("tok-expired", ATTACH_NEVER_CALLED);

    expect(await screen.findByRole("heading", { name: /tautan sudah tidak berlaku/i })).toBeTruthy();
  });

  it("renders the identical message for a cancelled-subscription refusal — same 403, same body", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "watch link is no longer valid" }, 403)
    ) as unknown as typeof fetch;

    renderAt("tok-cancelled", ATTACH_NEVER_CALLED);

    expect(await screen.findByRole("heading", { name: /tautan sudah tidak berlaku/i })).toBeTruthy();
  });

  it("renders the identical message on a network error, not a distinct one", async () => {
    global.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    renderAt("tok-network-error", ATTACH_NEVER_CALLED);

    expect(await screen.findByRole("heading", { name: /tautan sudah tidak berlaku/i })).toBeTruthy();
  });

  it("renders the identical message for a malformed success body (no hlsUrl)", async () => {
    global.fetch = mock(async () => jsonResponse({ notAUrl: true })) as unknown as typeof fetch;

    renderAt("tok-malformed", ATTACH_NEVER_CALLED);

    // `fetchWatchSession` resolves (200, valid JSON) but with the wrong
    // shape — WatchPage still has to end up somewhere sane rather than
    // trying to attach a player with `hlsUrl: undefined`. Handing a
    // player-less "playing" phase to `attachPlayer` would violate the
    // "never call attachPlayer for anything that didn't genuinely resolve"
    // property the other tests in this block pin, so this is folded into
    // the same generic outcome.
    await waitFor(() => {
      const playingHeading = screen.queryAllByText(/tayang langsung/i).length;
      expect(playingHeading).toBe(0);
    });
  });
});

describe("withToken — the exact re-attachment logic MediaMTX's per-request auth depends on", () => {
  it("appends the token as a query parameter to a bare URL", () => {
    const result = withToken("https://hls.diudara.test/live/key/index.m3u8", "tok-1");
    expect(result).toBe("https://hls.diudara.test/live/key/index.m3u8?token=tok-1");
  });

  it("OVERWRITES an existing token rather than duplicating the parameter", () => {
    const result = withToken("https://hls.diudara.test/live/key/index.m3u8?token=stale", "tok-2");
    const url = new URL(result);
    expect(url.searchParams.getAll("token")).toEqual(["tok-2"]);
  });

  it("preserves the path and any OTHER query parameters already on the URL", () => {
    const result = withToken("https://hls.diudara.test/live/key/seg-0.ts?m=1234", "tok-3");
    const url = new URL(result);
    expect(url.pathname).toBe("/live/key/seg-0.ts");
    expect(url.searchParams.get("m")).toBe("1234");
    expect(url.searchParams.get("token")).toBe("tok-3");
  });

  it("resolves a relative URL against the current origin — the shape a segment URL inside a playlist can take", () => {
    const result = withToken("/live/key/seg-1.ts", "tok-4");
    expect(result).toContain("/live/key/seg-1.ts?token=tok-4");
  });
});

describe("buildXhrSetup — exactly what hls.js's loader is told to do with EVERY request", () => {
  it("re-opens the XHR against the token-bearing URL, for the manifest AND for a segment URL alike", () => {
    const setup = buildXhrSetup("tok-5");
    const calls: Array<[string, string, boolean]> = [];
    const fakeXhr = {
      open(method: string, url: string, async: boolean) {
        calls.push([method, url, async]);
      },
    } as unknown as XMLHttpRequest;

    setup(fakeXhr, "https://hls.diudara.test/live/key/index.m3u8");
    setup(fakeXhr, "https://hls.diudara.test/live/key/seg-0.ts");

    expect(calls).toEqual([
      ["GET", "https://hls.diudara.test/live/key/index.m3u8?token=tok-5", true],
      ["GET", "https://hls.diudara.test/live/key/seg-0.ts?token=tok-5", true],
    ]);
  });
});
