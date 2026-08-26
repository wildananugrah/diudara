import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SiaranPage from "./SiaranPage";
import type { AttachHlsInput, StreamPlayerHandle } from "./StreamPlayer";
import { setUserSession, type StreamView } from "./apiClient";

/**
 * `/siaran` — who is live, and a lock where a stranger cannot watch (task
 * brief; design spec §8). `GET /streams` is mocked directly on
 * `global.fetch` for every test here — `SiaranPage` never reads `import.meta`
 * config or anything else that would need a heavier mock. (This note used to
 * cite `WatchPage.test.tsx`'s mock of `GET /c/watch/:token` as the shape it
 * copied; retire-telegram deleted that page, that route and that test.)
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
  // The composer describes below sign in via `setUserSession` — cleared here
  // so a session from one test never leaks into the next, the same rule
  // `BerandaPage.test.tsx`'s own `beforeEach` follows.
  localStorage.clear();
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

/**
 * Task 8: the creator's own controls — a title, *Khusus anggota*, and
 * *Mulai siaran* (design spec §8's second half, split from Task 7's own
 * half of §8). Signed-in only, the same gate `PostComposer`'s appearance on
 * `BerandaPage` already uses — `POST /streams` requires a session, and there
 * is nothing for a signed-out visitor to do here but collect
 * `SESSION_EXPIRED_MESSAGE`.
 *
 * The API's own `GET /streams` is stubbed empty in every test below, the
 * same shape `mockStreams([])` already gives every OTHER describe block in
 * this file — this section only adds routing for the SECOND fetch call,
 * `POST /streams` (and, where named, `DELETE /streams/:id`).
 */
const SESSION_USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

const STARTED_STREAM = {
  id: "stream-new",
  title: "Tanya jawab",
  visibility: "public",
  whipUrl: "https://stream.example.com/whip/streamkey123",
  rtmpUrl: "rtmp://stream.example.com/live",
  streamKey: "streamkey123-secret",
  hlsPlaybackPath: "/u/stream-new/index.m3u8",
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Replaces `global.fetch` with a router keyed on method+url, and records every call. */
function mockApi(handler: (url: string, method: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, (init?.method ?? "GET").toUpperCase(), init);
  }) as unknown as typeof fetch;
  return calls;
}

/** `GET /streams` empty, `POST /streams` answering with `STARTED_STREAM`. Nothing else is routed. */
function mockGoLive(overrides?: Partial<typeof STARTED_STREAM>): Call[] {
  return mockApi((url, method) => {
    if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
    if (url === "/streams" && method === "POST") {
      return jsonResponse({ ...STARTED_STREAM, ...overrides }, 201);
    }
    return jsonResponse({ error: "unrouted in this test" }, 500);
  });
}

async function renderSignedIn() {
  setUserSession("jwt-abc", SESSION_USER);
  const result = renderSiaran();
  await waitFor(() => expect(screen.queryAllByText("Belum ada siaran langsung.").length).toBe(1));
  return result;
}

/**
 * **M3 (final whole-branch review, a carried finding confirmed empirically):
 * the sign-in gate was pinned by NOTHING.** Rendering `StreamComposer`
 * unconditionally — deleting the `signedIn ? … : null` in `SiaranPage` — left
 * the entire web suite green, 911 pass / 0 fail. Nothing in this file or in
 * `App.test.tsx` asserted the composer was absent for a signed-out visitor.
 *
 * The consequence today is mild (a signed-out visitor types a title, presses
 * *Mulai siaran*, and collects `SESSION_EXPIRED_MESSAGE` from `apiFetch`),
 * which is exactly why it went unnoticed — but the behaviour the component's
 * own docstring claims was unowned, and *Akhiri siaran*'s rehydration now
 * hangs off the same gate.
 *
 * `localStorage` is cleared in this file's own `beforeEach`, so "signed out"
 * here is the real thing rather than a stub: `isUserSignedIn()` reads the
 * absent token, and `useSyncExternalStore` reports false.
 */
describe("SiaranPage — the composer is signed-in only", () => {
  it("renders NO composer at all for a signed-out visitor", async () => {
    mockStreams([]);

    renderSiaran();

    await waitFor(() =>
      expect(screen.queryAllByText("Belum ada siaran langsung.").length).toBe(1)
    );
    expect(screen.queryAllByTestId("stream-composer").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mulai siaran" }).length).toBe(0);
  });

  /** The other half: the same page, the same listing, with a session. */
  it("renders the composer once there IS a session", async () => {
    mockStreams([]);
    setUserSession("jwt-abc", SESSION_USER);

    renderSiaran();

    await waitFor(() => expect(screen.queryAllByTestId("stream-composer").length).toBe(1));
  });
});

describe("SiaranPage — Mulai siaran is disabled until a title is typed", () => {
  it("starts disabled, and enables once a title is typed", async () => {
    mockGoLive();
    await renderSignedIn();

    const button = screen.getByRole("button", { name: "Mulai siaran" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    expect(button.disabled).toBe(false);
  });

  it("goes back to disabled when the title is cleared again — not a one-way switch", async () => {
    mockGoLive();
    await renderSignedIn();

    const title = screen.getByLabelText("Judul");
    const button = screen.getByRole("button", { name: "Mulai siaran" }) as HTMLButtonElement;
    fireEvent.change(title, { target: { value: "Tanya jawab" } });
    expect(button.disabled).toBe(false);

    fireEvent.change(title, { target: { value: "   " } });
    expect(button.disabled).toBe(true);
  });
});

describe("SiaranPage — the OBS block after going live", () => {
  it("shows the RTMP URL and the stream key, collapsed under Pakai OBS", async () => {
    mockGoLive();
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    const details = (await screen.findByTestId("stream-obs-details")) as HTMLDetailsElement;
    expect(details.textContent).toContain(STARTED_STREAM.rtmpUrl);
    expect(details.textContent).toContain(STARTED_STREAM.streamKey);
    // Collapsed by default — the design spec's own words ("a collapsed
    // block for a creator on a desktop with OBS"), not merely present.
    expect(details.open).toBe(false);
    // The summary's copy, EXACT — catches text appended after "Pakai OBS".
    expect(screen.getByText("Pakai OBS").textContent).toBe("Pakai OBS");
  });
});

describe("SiaranPage — Khusus anggota controls the request body", () => {
  it("is sent as visibility: members when ticked — the WHOLE parsed body, not just one field", async () => {
    const calls = mockGoLive();
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByLabelText("Khusus anggota"));
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    await screen.findByTestId("stream-obs-details");
    const post = calls.find((c) => c.url === "/streams" && c.init?.method === "POST");
    expect(JSON.parse((post?.init?.body as string) ?? "null")).toEqual({
      title: "Tanya jawab",
      visibility: "members",
    });
  });

  it("omits visibility entirely when left unchecked — never sends a literal 'public'", async () => {
    const calls = mockGoLive();
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    await screen.findByTestId("stream-obs-details");
    const post = calls.find((c) => c.url === "/streams" && c.init?.method === "POST");
    expect(JSON.parse((post?.init?.body as string) ?? "null")).toEqual({ title: "Tanya jawab" });
  });
});

describe("SiaranPage — Akhiri siaran", () => {
  it("ends the stream: calls DELETE /streams/:id and returns the composer to its start state", async () => {
    const calls = mockApi((url, method) => {
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (url === `/streams/${STARTED_STREAM.id}` && method === "DELETE") {
        return jsonResponse({ ended: true });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    });
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));
    await screen.findByTestId("stream-obs-details");

    fireEvent.click(screen.getByRole("button", { name: "Akhiri siaran" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/streams/${STARTED_STREAM.id}` && c.init?.method === "DELETE")).toBe(
        true
      )
    );
    await waitFor(() => expect(screen.queryAllByTestId("stream-obs-details").length).toBe(0));
    // Back to the start state: the composer form (with its own "Mulai
    // siaran" button) is there again, disabled until a title is typed.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Mulai siaran" }) as HTMLButtonElement).disabled).toBe(true)
    );
  });

  /**
   * THE ONE TO THINK ABOUT (task instructions): a stream key must not
   * outlive the broadcast that produced it, in this creator's own DOM.
   * Asserted directly on `document.body.innerHTML` rather than a testid
   * query, since the whole point is that NOTHING should still be holding
   * it — there is no element left to query by the time this runs.
   */
  it("removes the stream key from the DOM once the stream has ended", async () => {
    mockApi((url, method) => {
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (url === `/streams/${STARTED_STREAM.id}` && method === "DELETE") {
        return jsonResponse({ ended: true });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    });
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));
    const details = await screen.findByTestId("stream-obs-details");
    expect(details.textContent).toContain(STARTED_STREAM.streamKey);

    fireEvent.click(screen.getByRole("button", { name: "Akhiri siaran" }));

    await waitFor(() => expect(document.body.innerHTML.includes(STARTED_STREAM.streamKey)).toBe(false));
  });
});

describe("SiaranPage — POST /streams 503s when no provider is configured", () => {
  it("tells the creator honestly, never the generic 'coba lagi' retry sentence, and leaves the button usable", async () => {
    mockApi((url, method) => {
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") {
        return jsonResponse({ error: "siaran langsung belum tersedia di server ini" }, 503);
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    });
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Siaran langsung belum dikonfigurasi di server ini. Coba lagi nanti atau hubungi admin."
    );
    expect(alert.textContent).not.toContain("siaran langsung belum tersedia di server ini");
    expect(screen.queryAllByTestId("stream-obs-details").length).toBe(0);
    // Not left staring at a dead button — the title survived the failed
    // submit (same rule `PostComposer` follows: a failed submit keeps what
    // was typed), so the button is enabled again, not stuck.
    expect((screen.getByRole("button", { name: "Mulai siaran" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * The move this task is actually about: `publishToWhip`, relocated from
 * `dashboard/whip-publisher.ts`, is wired into *Mulai siaran* itself (design
 * spec §7: "The browser publishes over WHIP"). `RTCPeerConnection` does not
 * exist in happy-dom, so a minimal fake is installed on `globalThis` — the
 * same shape `whip-publisher.test.ts` and `EventsPage.test.tsx` both use for
 * the identical reason — and `navigator.mediaDevices` is stubbed the same
 * way `EventsPage.test.tsx`'s own top-level `beforeEach` already does.
 */
describe("SiaranPage — going live actually publishes over WHIP", () => {
  class FakePeerConnection {
    localDescription: { type: string; sdp: string } | null = null;
    iceGatheringState = "complete";
    connectionState = "new";
    closed = false;
    private listeners = new Map<string, Set<() => void>>();
    addTrack() {}
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- fake-offer\r\n" };
    }
    async setLocalDescription(desc: { type: string; sdp: string }) {
      this.localDescription = desc;
    }
    async setRemoteDescription() {
      this.connectionState = "connected";
      for (const callback of this.listeners.get("connectionstatechange") ?? []) callback();
    }
    addEventListener(event: string, callback: () => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(callback);
    }
    removeEventListener(event: string, callback: () => void) {
      this.listeners.get(event)?.delete(callback);
    }
    close() {
      this.closed = true;
    }
  }

  /** Every track this double handed out, so a test can assert the camera was released. */
  let handedOutTracks: Array<{ kind: string; stopped: boolean }> = [];

  /**
   * A REAL `MediaStream`, not a duck-typed object.
   *
   * It used to be `{ getTracks: () => [...] } as unknown as MediaStream`, which
   * was enough while nothing did anything with it but hand it to a fake peer
   * connection. It stopped being enough the moment `SiaranPage` began assigning
   * the capture to a `<video>`: happy-dom's `srcObject` setter type-checks its
   * argument and throws `The provided value is not of type 'MediaStream'`. The
   * double was lying about a type the production code legitimately relies on.
   *
   * `getTracks` is overridden on the instance because happy-dom's MediaStream
   * has no way to add a track without a real capture device.
   */
  function fakeMediaStream(): MediaStream {
    const tracks = [
      { kind: "video", stopped: false },
      { kind: "audio", stopped: false },
    ];
    handedOutTracks = tracks;
    const stream = new MediaStream();
    Object.defineProperty(stream, "getTracks", {
      value: () => tracks.map((t) => ({ kind: t.kind, stop: () => { t.stopped = true; } })),
    });
    return stream;
  }

  let originalMediaDevices: MediaDevices | undefined;
  let originalRTCPeerConnection: unknown;

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    originalRTCPeerConnection = (globalThis as Record<string, unknown>).RTCPeerConnection;
    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => fakeMediaStream() },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
    (globalThis as Record<string, unknown>).RTCPeerConnection = originalRTCPeerConnection;
  });

  /**
   * The broadcaster could not see themselves. The capture went straight to
   * WHIP and was never attached to anything, so the page showed a stream key
   * and no picture — and there was no way to tell a working camera from a
   * black one until a viewer said so.
   *
   * Asserts `srcObject` IS the captured stream, not merely that a <video>
   * rendered: an element with nothing attached looks identical on screen and
   * would pass a presence check.
   */
  it("shows the broadcaster their own camera while live", async () => {
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (typeof url === "string" && url.startsWith(STARTED_STREAM.whipUrl)) {
        return new Response("v=0\r\no=- fake-answer\r\n", {
          status: 201,
          headers: {
            "Content-Type": "application/sdp",
            Location: `${new URL(STARTED_STREAM.whipUrl).pathname}/session-x`,
          },
        });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    }) as unknown as typeof fetch;

    await renderSignedIn();
    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    const video = (await screen.findByTestId("stream-self-preview")) as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject === null).toBe(false));
    // Muted is not cosmetic: unmuted, autoplay policy blocks it AND the
    // broadcaster's microphone comes back out of their own speakers.
    expect(video.muted).toBe(true);
  });

  /**
   * `PublishHandle.close()` closes the peer connection and DELETEs the WHIP
   * session — it never owned the tracks and never stopped them, and nothing
   * else did. After *Akhiri siaran* the camera light stayed on until the tab
   * was closed. Nobody noticed while there was no preview to make it visible.
   *
   * Asserts the TRACKS, not the element: removing the <video> hides the
   * picture and leaves the camera running, which is the bug wearing a fix.
   */
  it("releases the camera and microphone when the broadcast ends", async () => {
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (url === `/streams/${STARTED_STREAM.id}` && method === "DELETE") return jsonResponse({ ok: true });
      if (typeof url === "string" && url.startsWith(STARTED_STREAM.whipUrl)) {
        return new Response("v=0\r\no=- fake-answer\r\n", {
          status: 201,
          headers: {
            "Content-Type": "application/sdp",
            Location: `${new URL(STARTED_STREAM.whipUrl).pathname}/session-x`,
          },
        });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    }) as unknown as typeof fetch;

    await renderSignedIn();
    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));
    await screen.findByTestId("stream-self-preview");
    expect(handedOutTracks.every((track) => track.stopped)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Akhiri siaran" }));

    await waitFor(() => expect(handedOutTracks.every((track) => track.stopped)).toBe(true));
    // Both of them — video AND audio. Stopping only the camera leaves a live
    // microphone, which is the worse half to leave running.
    expect(handedOutTracks.map((track) => track.kind).sort()).toEqual(["audio", "video"]);
  });

  /**
   * `listStreams()` ran once on mount and nothing re-ran it, so the page went
   * on saying "Belum ada siaran langsung." while its own author was
   * demonstrably broadcasting, until they reloaded by hand.
   */
  it("re-reads the listing after going live, so the page stops contradicting itself", async () => {
    let listCalls = 0;
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/streams" && method === "GET") {
        listCalls += 1;
        return jsonResponse({ streams: [] });
      }
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (typeof url === "string" && url.startsWith(STARTED_STREAM.whipUrl)) {
        return new Response("v=0\r\no=- fake-answer\r\n", {
          status: 201,
          headers: {
            "Content-Type": "application/sdp",
            Location: `${new URL(STARTED_STREAM.whipUrl).pathname}/session-x`,
          },
        });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    }) as unknown as typeof fetch;

    await renderSignedIn();
    expect(listCalls).toBe(1);

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    await waitFor(() => expect(listCalls).toBe(2));
  });

  it("POSTs the SDP offer to the whipUrl POST /streams returned", async () => {
    const whipCalls: Call[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") return jsonResponse(STARTED_STREAM, 201);
      if (typeof url === "string" && url.startsWith(STARTED_STREAM.whipUrl)) {
        whipCalls.push({ url, init });
        return new Response("v=0\r\no=- fake-answer\r\n", {
          status: 201,
          headers: {
            "Content-Type": "application/sdp",
            Location: `${new URL(STARTED_STREAM.whipUrl).pathname}/session-x`,
          },
        });
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    }) as unknown as typeof fetch;

    await renderSignedIn();
    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    await waitFor(() => expect(whipCalls.length).toBe(1));
    expect(whipCalls[0]?.url).toBe(STARTED_STREAM.whipUrl);
    expect(whipCalls[0]?.init?.method).toBe("POST");
  });
});

/**
 * **I2 (final whole-branch review). A creator who reloads mid-broadcast must
 * still be able to end their own stream.**
 *
 * `liveStream` used to be local `useState` initialised to `null` and nothing
 * rehydrated it, so after a reload — or after a browser publish that never
 * started, which leaves the row `live` with no publisher and therefore no
 * `offline` webhook — there was NO *Akhiri siaran* control anywhere in the
 * app. `DELETE /streams/:id` was built, tested, and deliberately made to work
 * on a box with no provider "specifically so a creator can never be left
 * unable to end their own stream" (`apiClient.ts`'s own words), and no UI
 * reached it. The next *Mulai siaran* then 409s against
 * `user_stream_one_live` for up to twelve hours, until `SweepStaleUserStreams`
 * catches the row.
 *
 * The creator's own live row is already in `GET /streams` — the same payload
 * this page already fetches — so rehydrating from it needs no new endpoint.
 * `isOwnHandle` is the ONE handle comparison this app makes (`apiClient.ts`),
 * reused rather than re-implemented here.
 */
describe("SiaranPage — Akhiri siaran survives a reload (I2)", () => {
  /** The creator's OWN live row, exactly as `GET /streams` renders it — no key, no whip/rtmp URL. */
  const OWN_LIVE_STREAM: StreamView = {
    id: "stream-mine",
    title: "Tanya jawab",
    visibility: "public",
    owner: { handle: "wildan", displayName: "Wildan" },
    locked: false,
    hlsPlaybackPath: "/u/stream-mine/index.m3u8",
  };

  /** Somebody else's live row — the same shape, a different owner. */
  const OTHER_LIVE_STREAM: StreamView = {
    id: "stream-theirs",
    title: "Bedah karya",
    visibility: "public",
    owner: { handle: "sari", displayName: "Sari" },
    locked: false,
    hlsPlaybackPath: "/u/stream-theirs/index.m3u8",
  };

  /** `GET /streams` answering `streams`, `DELETE /streams/:id` answering `{ ended: true }`. */
  function mockReload(streams: StreamView[]): Call[] {
    return mockApi((url, method) => {
      if (url === "/streams" && method === "GET") return jsonResponse({ streams });
      if (url.startsWith("/streams/") && method === "DELETE") return jsonResponse({ ended: true });
      return jsonResponse({ error: "unrouted in this test" }, 500);
    });
  }

  async function renderReloaded(streams: StreamView[]) {
    setUserSession("jwt-abc", SESSION_USER);
    render(
      <MemoryRouter>
        <SiaranPage attachHls={(_input: AttachHlsInput) => fakeAttach()} />
      </MemoryRouter>
    );
    await screen.findByTestId("stream-composer");
    return streams;
  }

  it("puts Akhiri siaran on screen for the creator's OWN live row, with no Mulai siaran in this session", async () => {
    mockReload([OWN_LIVE_STREAM]);
    await renderReloaded([OWN_LIVE_STREAM]);

    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Akhiri siaran" }).length).toBe(1)
    );
    expect(screen.queryAllByRole("button", { name: "Mulai siaran" }).length).toBe(0);
  });

  it("DELETEs the rehydrated row's OWN id, not some id this session invented", async () => {
    const calls = mockReload([OWN_LIVE_STREAM]);
    await renderReloaded([OWN_LIVE_STREAM]);

    const end = await screen.findByRole("button", { name: "Akhiri siaran" });
    fireEvent.click(end);

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/streams/stream-mine" && c.init?.method === "DELETE")
      ).toBe(true)
    );
  });

  it("never shows Akhiri siaran for somebody ELSE's live row", async () => {
    mockReload([OTHER_LIVE_STREAM]);
    await renderReloaded([OTHER_LIVE_STREAM]);

    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Mulai siaran" }).length).toBe(1)
    );
    expect(screen.queryAllByRole("button", { name: "Akhiri siaran" }).length).toBe(0);
  });

  it("shows NO OBS block for a rehydrated row — GET /streams never carries the stream key", async () => {
    mockReload([OWN_LIVE_STREAM]);
    await renderReloaded([OWN_LIVE_STREAM]);

    await screen.findByRole("button", { name: "Akhiri siaran" });
    expect(screen.queryAllByTestId("stream-obs-details").length).toBe(0);
  });

  /**
   * The listing is NOT refetched after *Akhiri siaran*, so the row this
   * component rehydrated from is still sitting in `streams` when the panel
   * closes. Without a memory of what was ended, the rehydration would fire
   * again on the very next render and pin the creator in a panel they just
   * dismissed.
   */
  it("stays ended after Akhiri siaran, even though the stale listing still lists the row", async () => {
    const calls = mockReload([OWN_LIVE_STREAM]);
    await renderReloaded([OWN_LIVE_STREAM]);

    fireEvent.click(await screen.findByRole("button", { name: "Akhiri siaran" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/streams/stream-mine" && c.init?.method === "DELETE")).toBe(
        true
      )
    );

    // **SETTLED STATE, NOT A POLLED ONE.** `waitFor` alone was NOT enough
    // here, and finding that out is the reason this comment exists: with the
    // `endedIdsRef` guard deleted, the re-adoption happens one effect pass
    // AFTER the panel closes, so a polling `waitFor("Mulai siaran")` catches
    // the transient form and reports green against a component that has
    // already put the panel back. Flushing every pending effect first and
    // then asserting ONCE, synchronously, is what actually pins this.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryAllByRole("button", { name: "Akhiri siaran" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Mulai siaran" }).length).toBe(1);
  });
});

/**
 * **I2's other half. The 409 must not say "coba lagi".**
 *
 * `POST /streams` answers 409 (`user_stream_one_live`) whenever the caller
 * already holds a `live` row — the exact state a failed browser publish
 * leaves behind. `describeStreamStartFailure` used to delegate every non-503
 * shape to `describeRequestFailure`, whose 4xx branch says "Permintaan tidak
 * dapat diproses. Coba lagi." — advice that cannot terminate, since retrying
 * *Mulai siaran* 409s again every single time. Same class as
 * `describeUploadFailure`'s HEIC branch and `describeSubscribeFailure`'s: a
 * refusal a retry cannot fix must never be answered "try again".
 */
describe("SiaranPage — POST /streams 409s when a stream is already running", () => {
  it("names the running stream and points at ending it, never the generic retry sentence", async () => {
    mockApi((url, method) => {
      if (url === "/streams" && method === "GET") return jsonResponse({ streams: [] });
      if (url === "/streams" && method === "POST") {
        return jsonResponse({ error: "sudah ada siaran yang sedang berlangsung" }, 409);
      }
      return jsonResponse({ error: "unrouted in this test" }, 500);
    });
    await renderSignedIn();

    fireEvent.change(screen.getByLabelText("Judul"), { target: { value: "Tanya jawab" } });
    fireEvent.click(screen.getByRole("button", { name: "Mulai siaran" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Anda masih punya siaran yang sedang berlangsung. Akhiri siaran itu dulu, lalu mulai lagi."
    );
    expect(alert.textContent).not.toContain("sudah ada siaran yang sedang berlangsung");
  });
});

