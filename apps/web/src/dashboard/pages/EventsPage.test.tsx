import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import EventsPage from "./EventsPage";
import { setSession } from "../auth";
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
};

const CREATED_SESSION = {
  id: "event-2",
  title: "Q&A langsung",
  status: "scheduled",
  rtmpUrl: "rtmp://mediamtx.example.com:1935/live",
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
