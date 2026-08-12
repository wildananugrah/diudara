import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import EventsPage, { resetBrowserPublishUnloadGuardForTesting } from "./EventsPage";
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
  /**
   * `connectionState` starts `"new"` and `setRemoteDescription` transitions
   * it to `"connected"` by default — fix round 1, Critical 1 added a real
   * `waitForConnection` step to `publishToWhip` (see whip-publisher.ts and
   * whip-publisher.test.ts), so a fake that never reports "connected" would
   * make every "goes live" test in this file hang for real seconds instead
   * of exercising the UI. The mid-stream-drop / never-connects paths
   * themselves are pinned at the `whip-publisher.ts` unit level, not
   * re-tested here — this file is about what the SCREEN does once
   * negotiation has (or has not) succeeded.
   */
  class FakePeerConnection {
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: { type: string; sdp: string } | null = null;
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
    async setRemoteDescription(desc: { type: string; sdp: string }) {
      this.remoteDescription = desc;
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
    // The real shape (CONTRIBUTING.md's "Browser publishing" section, and
    // whip-publisher.test.ts's own `okAnswer`): the session sub-resource is
    // NESTED under the stream key, `/whip/<streamKey>/<sessionId>` — a
    // SIBLING of `/whip/session-x` would not start with `whip.url` at all,
    // which is exactly the mismatch that made this helper's own DELETE
    // branch below unreachable in fix round 1 until this default was
    // corrected to match reality.
    const defaultLocation = `${new URL(whip.url).pathname}/session-x`;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith(whip.url)) {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") {
          if (whip.throwOnPost === true) throw new TypeError("Failed to fetch");
          return new Response("v=0\r\no=- fake-answer\r\n", {
            status: whip.status ?? 201,
            headers: {
              "Content-Type": "application/sdp",
              Location: whip.location ?? defaultLocation,
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
    // `activeBrowserPublishCount` is module state (Fix Round 1, Critical 2) —
    // a test that intentionally leaves something mid-flight (Important 1's
    // own test does exactly that) must not leak a nonzero count into the
    // next test in this file.
    resetBrowserPublishUnloadGuardForTesting();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    (globalThis as Record<string, unknown>).RTCPeerConnection = originalRTCPeerConnection;
    resetBrowserPublishUnloadGuardForTesting();
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

  // Fix round 1, Important 4: these two device states existed in
  // DEVICE_STATUS_MESSAGE and classifyGetUserMediaError, and the report
  // claimed they were "exercised only via the component test suite" — a
  // claim that did not hold, since no test actually pinned either. Fixed
  // here rather than merely re-asserted.
  it("explains that the camera/mic is busy in another app (NotReadableError)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: rejectingMediaDevices("NotReadableError"),
    });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    expect(await screen.findByText(/sedang dipakai aplikasi lain/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Mulai siaran dari browser/ }).length).toBe(0);
  });

  it("treats TrackStartError the same as a busy camera/mic", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: rejectingMediaDevices("TrackStartError"),
    });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    expect(await screen.findByText(/sedang dipakai aplikasi lain/)).toBeTruthy();
  });

  it("points at OBS/Streamlabs and a modern browser when this one has no mediaDevices support at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));

    expect(await screen.findByText(/tidak mendukung siaran langsung dari browser/)).toBeTruthy();
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
    expect(await screen.findByText(/sudah berstatus live saat ini/)).toBeTruthy();
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

  it("hides the browser-publish path only for the session where it is unconfigured, not app-wide", async () => {
    // A MIXED fixture — one configured session, one not — is the point of
    // this rewrite (fix round 1: review measured that the single-session
    // version of this test still passed against the PRE-Task-3 code, where
    // there was no "Siarkan" button or "Siaran dari browser" text for ANY
    // session, making both assertions vacuous — "hidden because null" and
    // "hidden because the feature does not exist" were indistinguishable
    // from a single session with nulled URLs). With both present in the
    // same render, the configured session proves the feature exists and
    // works, which is what makes the unconfigured session's absence mean
    // something.
    const UNCONFIGURED_SESSION = {
      ...SCHEDULED_SESSION,
      id: "event-unconfigured",
      title: "Sesi tanpa WHIP",
      rtmpUrl: null,
      whipUrl: null,
    };
    stubFetch([
      COMMUNITY,
      ENABLED,
      { path: EVENTS_PATH, body: [SCHEDULED_SESSION, UNCONFIGURED_SESSION] },
    ]);

    render();
    await screen.findByText("Sesi belajar saham");
    await screen.findByText("Sesi tanpa WHIP");

    // Exactly one "Siarkan" button — for the configured session's row only.
    const siarkanButtons = screen.getAllByRole("button", { name: "Siarkan" });
    expect(siarkanButtons.length).toBe(1);

    // And it genuinely works — expanding it shows the browser panel, proving
    // the feature is present and only conditionally hidden, not absent.
    fireEvent.click(siarkanButtons[0]!);
    expect(await screen.findByText("Siaran dari browser")).toBeTruthy();
  });

  /** Dispatches a REAL cancelable `beforeunload` at `window` and reports whether it was cancelled. */
  function dispatchBeforeUnload(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("goes live from the browser, warns before unload, and stops cleanly", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetchWithWhip([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }], {
      url: SCHEDULED_SESSION.whipUrl,
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

  // Fix round 1, Critical 2. Review measured, through the real component,
  // that the OLD "…warns before unload…" test above only ever asserted the
  // ON-SCREEN paragraph's text — never the actual `beforeunload` LISTENER —
  // which is exactly why a stale-identity bug that left the real listener
  // permanently registered still passed it. This test dispatches a real,
  // cancelable `beforeunload` at `window` and reads `defaultPrevented`,
  // which only reflects reality if `removeEventListener` genuinely removed
  // what `addEventListener` added.
  it("cancels a real beforeunload while live, and stops cancelling it once stopped (Critical 2)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetchWithWhip([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }], {
      url: SCHEDULED_SESSION.whipUrl,
    });

    render();
    await screen.findByText("Sesi belajar saham");

    // PROBE, pinned: nothing is live yet, so a real beforeunload passes through.
    expect(dispatchBeforeUnload()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mulai siaran dari browser/ }));
    await screen.findByRole("button", { name: "Hentikan siaran" });

    // PROBE A/B, pinned: while live, the SAME real event is cancelled.
    expect(dispatchBeforeUnload()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hentikan siaran" }));
    await screen.findByRole("button", { name: /Mulai siaran dari browser/ });

    // PROBE, pinned: after stopping, it is no longer cancelled — the
    // listener genuinely came off, not just the on-screen paragraph.
    expect(dispatchBeforeUnload()).toBe(false);
  });

  // Fix round 1, Important 1. Review measured, through the real component,
  // that collapsing a row WHILE `publishToWhip` was still in flight (before
  // `handleRef.current` was ever set) left an open `RTCPeerConnection` with
  // no DELETE issued and nothing able to close it — an unstoppable ghost
  // publish. This is the exact race: the POST is held open past the click
  // that collapses the row, so the promise resolves on an unmounted
  // component. Important 3 (below) only locks collapsing once `publishing`
  // is actually `true`, which is why this race exists at all — during
  // "Menghubungkan…" the row is still collapsible.
  it("closes an in-flight publish attempt if the row is collapsed before it resolves (Important 1)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetch([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }]);
    const jsonFetch = global.fetch;
    let releasePost: (() => void) | undefined;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const whipCalls: string[] = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith(SCHEDULED_SESSION.whipUrl)) {
        const method = (init?.method ?? "GET").toUpperCase();
        whipCalls.push(method);
        if (method === "POST") {
          await postGate; // held open until the test releases it
          return new Response("v=0\r\no=- fake-answer\r\n", {
            status: 201,
            headers: {
              "Content-Type": "application/sdp",
              // Nested under the stream key, the real shape (see
              // stubFetchWithWhip's own comment on why a sibling path like
              // "/whip/session-x" would not even be recognised as a WHIP
              // call by this same mock's own `startsWith` check below).
              Location: `/whip/${SCHEDULED_SESSION.streamKey}/session-x`,
            },
          });
        }
        if (method === "DELETE") return new Response(null, { status: 200 });
      }
      return jsonFetch(url, init);
    }) as unknown as typeof fetch;

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mulai siaran dari browser/ }));

    // Still connecting — the POST hasn't resolved, so `publishing` is still
    // false and the row can still be collapsed (see this test's own comment
    // on why that window exists).
    await screen.findByRole("button", { name: "Menghubungkan..." });
    fireEvent.click(screen.getByRole("button", { name: "Sembunyikan" }));
    expect(await screen.findByRole("button", { name: "Siarkan" })).toBeTruthy();

    // NOW let the negotiation succeed, on a component that is already gone.
    releasePost?.();
    await waitFor(() => expect(whipCalls).toContain("DELETE"));

    // Re-expanding proves there is no leftover live state from the ghost —
    // a fresh panel, not one that thinks it is already broadcasting.
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    expect(screen.queryAllByRole("button", { name: "Hentikan siaran" }).length).toBe(0);
    expect(dispatchBeforeUnload()).toBe(false);
  });

  // Fix round 1, Important 3. Review measured that ONE CLICK on "Sembunyikan"
  // silently ended a live broadcast with no confirmation, while the
  // on-screen warning told the creator not to close or reload the TAB —
  // never mentioning that a row a click away did the identical permanent
  // damage. The toggle is now replaced by a locked indicator for exactly as
  // long as this panel reports itself live.
  it("keeps the row from being collapsed while live, and releases it once stopped (Important 3)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: grantingMediaDevices(),
    });
    stubFetchWithWhip([COMMUNITY, ENABLED, { path: EVENTS_PATH, body: [SCHEDULED_SESSION] }], {
      url: SCHEDULED_SESSION.whipUrl,
    });

    render();
    await screen.findByText("Sesi belajar saham");
    fireEvent.click(screen.getByRole("button", { name: "Siarkan" }));
    fireEvent.click(screen.getByRole("button", { name: /Aktifkan kamera/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mulai siaran dari browser/ }));
    await screen.findByRole("button", { name: "Hentikan siaran" });

    // The toggle is GONE — nothing clickable can collapse this row now.
    expect(screen.queryAllByRole("button", { name: "Sembunyikan" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Siarkan" }).length).toBe(0);
    expect(await screen.findByText("Sedang live")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hentikan siaran" }));

    // Stopping releases the lock — the toggle is back.
    expect(await screen.findByRole("button", { name: "Sembunyikan" })).toBeTruthy();
  });
});
