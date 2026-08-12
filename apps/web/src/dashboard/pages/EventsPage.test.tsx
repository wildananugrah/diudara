import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import EventsPage from "./EventsPage";
import { setSession } from "../auth";
import { formatDateTime } from "../format";
import { resetPaymentAccountCacheForTesting } from "../paymentAccount";
import { renderPage, stubFetch, TEST_COMMUNITY, type StubRoute } from "../testing";

const EVENTS_PATH = `/communities/${TEST_COMMUNITY.id}/events`;
const COMMUNITY_PATH = `/communities/${TEST_COMMUNITY.id}`;

const COMMUNITY: StubRoute = { path: COMMUNITY_PATH, body: TEST_COMMUNITY };
const ENABLED: StubRoute = { path: "/streaming/status", body: { enabled: true } };
const DISABLED: StubRoute = { path: "/streaming/status", body: { enabled: false } };

const SCHEDULED_SESSION = {
  id: "event-1",
  communityId: TEST_COMMUNITY.id,
  title: "Sesi belajar saham",
  scheduledAt: "2026-09-01T10:00:00.000Z",
  streamKey: "a".repeat(32),
  status: "scheduled",
  hlsPlaybackPath: "/live/aaaa/index.m3u8",
  recordingUrl: null,
  rtmpUrl: "rtmp://mediamtx.example.com:1935/live",
  whipUrl: "https://stream.example.com/whip/" + "a".repeat(32),
};

const CREATED_SESSION = {
  id: "event-2",
  title: "Q&A langsung",
  status: "scheduled",
  rtmpUrl: "rtmp://mediamtx.example.com:1935/live",
  whipUrl: "https://stream.example.com/whip/" + "b".repeat(32),
  streamKey: "b".repeat(32),
  hlsPlaybackPath: "/live/bbbb/index.m3u8",
};

function render() {
  return renderPage(<EventsPage />, {
    path: "/dashboard/c/:communityId/streaming",
    at: `/dashboard/c/${TEST_COMMUNITY.id}/streaming`,
  });
}

let originalFetch: typeof fetch;
let originalClipboard: Clipboard;

beforeEach(() => {
  originalFetch = global.fetch;
  originalClipboard = navigator.clipboard;
  localStorage.clear();
  resetPaymentAccountCacheForTesting();
});

afterEach(() => {
  global.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  cleanup();
});

describe("EventsPage", () => {
  it("shows an empty state that says what to do next when there are no sessions", async () => {
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [] }]);

    render();

    expect(await screen.findByText(/Belum ada sesi/)).toBeTruthy();
  });

  it("lists existing sessions with their status, in Indonesian", async () => {
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();

    expect(await screen.findByText("Sesi belajar saham")).toBeTruthy();
    expect(screen.getByText("Terjadwal")).toBeTruthy();
  });

  it("shows a distinct status for a session that is currently live", async () => {
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [{ ...SCHEDULED_SESSION, status: "live" }] },
    ]);

    render();

    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByText(/sedang berlangsung/i)).toBeTruthy();
  });

  it("shows a distinct status for a session that has ended", async () => {
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [{ ...SCHEDULED_SESSION, status: "ended" }] },
    ]);

    render();

    expect(await screen.findByText("Selesai")).toBeTruthy();
    expect(screen.getByText(/tidak bisa dipakai untuk memulai siaran baru/i)).toBeTruthy();
  });

  it("does not render any session's stream key until asked to reveal it", async () => {
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");

    // The value is not in the document at all yet — a reveal toggle exists,
    // but nothing has been clicked.
    expect(screen.queryAllByText(SCHEDULED_SESSION.streamKey).length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /Tampilkan stream key/ }));

    expect(await screen.findByText(SCHEDULED_SESSION.streamKey)).toBeTruthy();
  });

  it("renders the RTMP URL and stream key ONLY after a new session is created, with copy buttons and OBS instructions", async () => {
    const stub = stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [] },
      { method: "POST", path: EVENTS_PATH, status: 201, body: CREATED_SESSION },
    ]);

    render();
    await screen.findByText(/Belum ada sesi/);

    // Before creating anything, neither secret is anywhere on the page.
    expect(screen.queryAllByText(CREATED_SESSION.streamKey).length).toBe(0);
    expect(screen.queryAllByText(CREATED_SESSION.rtmpUrl).length).toBe(0);

    fireEvent.change(screen.getByLabelText("Judul sesi"), { target: { value: "Q&A langsung" } });
    fireEvent.click(screen.getByRole("button", { name: "Jadwalkan sesi" }));

    expect(await screen.findByText(CREATED_SESSION.rtmpUrl)).toBeTruthy();
    expect(screen.getByText(CREATED_SESSION.streamKey)).toBeTruthy();

    // OBS setup instructions, for someone who has never configured it.
    expect(screen.getByText("Cara mengatur OBS Studio")).toBeTruthy();
    expect(screen.getAllByText(/OBS/).length).toBeGreaterThan(0);

    const copyButtons = screen.getAllByRole("button", { name: "Salin" });
    expect(copyButtons.length).toBeGreaterThanOrEqual(2);

    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    fireEvent.click(copyButtons[0]!);
    await waitFor(() => expect(written.length).toBe(1));

    const post = stub.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ title: "Q&A langsung" });
  });

  it("shows the time the creator scheduled, not 'Langsung', right after creating a session for later", async () => {
    // The POST response genuinely carries no `scheduledAt` (see
    // `CreatedLiveSession`'s docstring) — this pins that the page uses the
    // value the creator TYPED rather than defaulting to "immediate" until
    // the next refetch, which used to show "Langsung" for a session
    // deliberately scheduled for tomorrow.
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [] },
      { method: "POST", path: EVENTS_PATH, status: 201, body: CREATED_SESSION },
    ]);

    render();
    await screen.findByText(/Belum ada sesi/);

    fireEvent.change(screen.getByLabelText("Judul sesi"), { target: { value: "Q&A langsung" } });
    fireEvent.change(screen.getByLabelText(/Waktu/), { target: { value: "2026-09-01T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Jadwalkan sesi" }));

    await screen.findByText(CREATED_SESSION.rtmpUrl);

    const expectedIso = new Date("2026-09-01T10:00").toISOString();
    expect(await screen.findByText(formatDateTime(expectedIso))).toBeTruthy();
    expect(screen.queryAllByText("Langsung").length).toBe(0);
  });

  it("shows a friendly Indonesian message rather than the raw 503 if creation is attempted while disabled", async () => {
    stubFetch([
      COMMUNITY,
      DISABLED,
      { path: EVENTS_PATH, body: [] },
      { method: "POST", path: EVENTS_PATH, status: 503, body: { error: "live streaming is not configured on this server" } },
    ]);

    render();
    await screen.findByText(/Belum ada sesi/);

    // The create form is hidden while disabled — the notice explains why,
    // in Indonesian, without ever mentioning a raw 503.
    expect(screen.queryAllByRole("button", { name: "Jadwalkan sesi" }).length).toBe(0);
    await waitFor(() => expect(screen.queryAllByText(/belum dikonfigurasi/).length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/503/).length).toBe(0);
  });

  it("says the community was not found rather than showing an empty page for a 404", async () => {
    stubFetch([
      ENABLED,
      { path: COMMUNITY_PATH, status: 404, body: { error: "community not found" } },
    ]);

    render();

    expect(await screen.findByText(/Komunitas tidak ditemukan/)).toBeTruthy();
  });

  it("does not carry a just-created stream key over when the community changes without a remount", async () => {
    // React Router reuses the SAME `EventsPage` instance across a route-param
    // change (same path, same position in the tree) — it does not remount
    // it. This is the exact scenario the brief's "must not cache a key
    // across a community switch" is about: local state (`justCreated`) would
    // otherwise survive a navigation from one community's streaming tab to
    // another's.
    const OTHER_COMMUNITY = {
      ...TEST_COMMUNITY,
      id: "other-community-id",
      name: "Kelas Lain",
      slug: "kelas-lain",
    };
    stubFetch([
      COMMUNITY,
      { path: `/communities/${OTHER_COMMUNITY.id}`, body: OTHER_COMMUNITY },
      ENABLED,
      { path: EVENTS_PATH, body: [] },
      { path: `/communities/${OTHER_COMMUNITY.id}/events`, body: [] },
      { method: "POST", path: EVENTS_PATH, status: 201, body: CREATED_SESSION },
    ]);

    setSession("jwt-test", { id: "creator-1", name: "Budi", email: "budi@example.com" });
    rtlRender(
      <MemoryRouter initialEntries={[`/dashboard/c/${TEST_COMMUNITY.id}/streaming`]}>
        <Routes>
          <Route
            path="/dashboard/c/:communityId/streaming"
            element={
              <>
                <Link to={`/dashboard/c/${OTHER_COMMUNITY.id}/streaming`}>Ganti komunitas</Link>
                <EventsPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Belum ada sesi/);
    fireEvent.change(screen.getByLabelText("Judul sesi"), { target: { value: "Q&A langsung" } });
    fireEvent.click(screen.getByRole("button", { name: "Jadwalkan sesi" }));
    expect(await screen.findByText(CREATED_SESSION.rtmpUrl)).toBeTruthy();

    fireEvent.click(screen.getByText("Ganti komunitas"));

    await screen.findByText("Kelas Lain");
    expect(screen.queryAllByText(CREATED_SESSION.rtmpUrl).length).toBe(0);
    expect(screen.queryAllByText(CREATED_SESSION.streamKey).length).toBe(0);
  });
});

/**
 * Browser publishing (Task 3): device permission, preview, go-live/stop, and
 * — per the brief, "most of this task's value" — a distinct Indonesian
 * message for each failure. The real WHIP negotiation (`whip-publisher.ts`)
 * is exercised separately, against an injected `fetchFn`, in
 * `whip-publisher.test.ts` — these tests exercise the SCREEN around it: what
 * a creator sees for each of the five named failure states, plus the two
 * structural checks the brief calls out (the button disabled while `live`,
 * the whole path hidden when unconfigured).
 *
 * `RTCPeerConnection` does not exist in happy-dom (this repo's `bun test`
 * DOM — see CONTRIBUTING.md's "environment finding" section on why camera/mic
 * browser features cannot run for real on this machine), so a minimal fake is
 * installed on `globalThis` here, the same shape `whip-publisher.test.ts`
 * uses for the identical reason. `navigator.mediaDevices` is stubbed the same
 * way `navigator.clipboard` already is in this file's own top-level
 * `beforeEach`/`afterEach` — happy-dom does not implement it either.
 */
describe("EventsPage - browser publishing", () => {
  class FakePeerConnection {
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: { type: string; sdp: string } | null = null;
    iceGatheringState = "complete";
    closed = false;
    addTrack() {}
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- fake-offer\r\n" };
    }
    async setLocalDescription(desc: { type: string; sdp: string }) {
      this.localDescription = desc;
    }
    async setRemoteDescription(desc: { type: string; sdp: string }) {
      this.remoteDescription = desc;
    }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
    }
  }

  class FakeTrack {
    stopped = false;
    constructor(private deviceId: string) {}
    stop() {
      this.stopped = true;
    }
    getSettings() {
      return { deviceId: this.deviceId };
    }
  }

  function fakeMediaStream(): MediaStream {
    const videoTrack = new FakeTrack("camera-1");
    const audioTrack = new FakeTrack("mic-1");
    return {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
  }

  /** Grants access successfully with one camera and one microphone. */
  function grantingMediaDevices() {
    return {
      getUserMedia: async () => fakeMediaStream(),
      enumerateDevices: async () =>
        [
          { deviceId: "camera-1", kind: "videoinput", label: "Kamera Depan" },
          { deviceId: "mic-1", kind: "audioinput", label: "Mikrofon Bawaan" },
        ] as MediaDeviceInfo[],
    };
  }

  /** `getUserMedia` rejects with the given `DOMException` name. */
  function rejectingMediaDevices(errorName: string) {
    return {
      getUserMedia: async () => {
        const err = new Error(errorName);
        err.name = errorName;
        throw err;
      },
      enumerateDevices: async () => [] as MediaDeviceInfo[],
    };
  }

  /**
   * The JSON API stub (`stubFetch`) PLUS a fake WHIP endpoint at `whip.url` —
   * `stubFetch` alone always answers JSON and cannot also serve
   * `application/sdp` with a `Location` header, so WHIP requests are
   * intercepted first and everything else falls through to it.
   */
  function stubFetchWithWhip(
    routes: StubRoute[],
    whip: { url: string; throwOnPost?: boolean; status?: number; location?: string }
  ) {
    stubFetch(routes);
    const jsonFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith(whip.url)) {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") {
          if (whip.throwOnPost === true) throw new TypeError("Failed to fetch");
          return new Response("v=0\r\no=- fake-answer\r\n", {
            status: whip.status ?? 201,
            headers: {
              "Content-Type": "application/sdp",
              Location: whip.location ?? "/whip/session-x",
            },
          });
        }
        if (method === "DELETE") return new Response(null, { status: 200 });
      }
      return jsonFetch(url, init);
    }) as unknown as typeof fetch;
  }

  let originalMediaDevices: MediaDevices | undefined;
  let originalRTCPeerConnection: unknown;

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    originalRTCPeerConnection = (globalThis as Record<string, unknown>).RTCPeerConnection;
    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    (globalThis as Record<string, unknown>).RTCPeerConnection = originalRTCPeerConnection;
  });

  it("explains how to grant access when camera/microphone permission is denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: rejectingMediaDevices("NotAllowedError"),
    });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    const message = await screen.findByText(/Izin kamera\/mikrofon ditolak/);
    expect(message.textContent).toContain("gembok");
    // The "go live" button must not appear at all while access is denied.
    expect(screen.queryAllByRole("button", { name: /Mulai siaran dari browser/ }).length).toBe(0);
  });

  it("says so, before ever offering to go live, when there is no camera or microphone", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: rejectingMediaDevices("NotFoundError"),
    });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    expect(await screen.findByText(/Tidak ditemukan kamera atau mikrofon/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Mulai siaran dari browser/ }).length).toBe(0);
  });

  it("names UDP-blocking and points at OBS when the WHIP negotiation itself fails", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetchWithWhip([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }], {
      url: SCHEDULED_SESSION.whipUrl,
      throwOnPost: true,
    });

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mulai siaran dari browser/ }));

    const message = await screen.findByText(/Gagal terhubung ke server siaran/);
    expect(message.textContent).toContain("UDP");
    expect(message.textContent).toContain("OBS");
    // Failing to connect must not leave the creator stuck believing they are live.
    expect(screen.queryAllByRole("button", { name: "Hentikan siaran" }).length).toBe(0);
  });

  it("disables the go-live button and explains why when the session is already live via OBS", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [{ ...SCHEDULED_SESSION, status: "live" }] },
    ]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    const button = await screen.findByRole("button", { name: /Mulai siaran dari browser/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      await screen.findByText(/sedang live lewat OBS \/ Streamlabs/)
    ).toBeTruthy();
  });

  it("offers to schedule a new session instead of device pickers when the session has ended", async () => {
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [{ ...SCHEDULED_SESSION, status: "ended" }] },
    ]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));

    // The panel's own "ended" message — distinct from the ALWAYS-present
    // "Jadwalkan sesi baru" schedule-form heading further down the page,
    // which is why this matches the fuller sentence rather than that phrase
    // alone.
    expect(await screen.findByText(/Sesi ini sudah selesai/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Aktifkan kamera/ }).length).toBe(0);
  });

  it("hides the browser-publish path entirely when it is not configured for a session", async () => {
    stubFetch([
      COMMUNITY,
      ENABLED,
      {
        path: EVENTS_PATH,
        body: [{ ...SCHEDULED_SESSION, rtmpUrl: null, whipUrl: null }],
      },
    ]);

    render();
    await screen.findByText("Sesi belajar saham");

    // No way to reach the browser-publish panel at all — not even a
    // "Siarkan" toggle, since there is nothing this session could publish to.
    expect(screen.queryAllByRole("button", { name: "Siarkan" }).length).toBe(0);
    expect(screen.queryAllByText("Siaran dari browser").length).toBe(0);
  });

  it("goes live from the browser, warns before unload, and stops cleanly", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetchWithWhip([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }], {
      url: SCHEDULED_SESSION.whipUrl,
      location: "/whip/session-x",
    });

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mulai siaran dari browser/ }));

    expect(await screen.findByRole("button", { name: "Hentikan siaran" })).toBeTruthy();
    expect(await screen.findByText(/Jangan tutup atau muat ulang tab ini/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hentikan siaran" }));

    expect(await screen.findByRole("button", { name: /Mulai siaran dari browser/ })).toBeTruthy();
    expect(screen.queryAllByText(/Jangan tutup atau muat ulang tab ini/).length).toBe(0);
  });
});
