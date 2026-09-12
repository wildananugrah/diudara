import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LiveRoomPage from "./LiveRoomPage";
import type { StreamView } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / `.getAttribute(...)`.
 */

function aStream(overrides: Partial<StreamView> = {}): StreamView {
  return {
    id: "stream-1",
    title: "Sesi Q&A Malam",
    visibility: "public",
    owner: { handle: "wildan", displayName: "Wildan" },
    locked: false,
    hlsPlaybackPath: "/hls/stream-1/index.m3u8",
    viewerCount: 0,
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function stubStreams(streams: StreamView[], status = 200): void {
  global.fetch = mock(async () =>
    new Response(JSON.stringify(status === 200 ? { streams } : { error: "boom" }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

function renderRoom(entry = "/siaran/stream-1") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/siaran/:streamId" element={<LiveRoomPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LiveRoomPage", () => {
  it("shows the title, the LIVE badge and a link back to the broadcaster", async () => {
    stubStreams([aStream()]);
    renderRoom();

    await screen.findByText("Sesi Q&A Malam");
    expect(screen.getByText("LIVE").textContent).toBe("LIVE");
    expect(screen.getByRole("link", { name: /Wildan/ }).getAttribute("href")).toBe("/@wildan");
    expect(screen.getByRole("link", { name: "Keluar" }).getAttribute("href")).toBe("/siaran");
  });

  /**
   * The same two branches `ProfilePage` already has, now on their own page.
   * A non-member must never be handed a player: mounting one mints a watch
   * token and begins an HLS attach, which is work for a stream they cannot
   * watch — the reason `SiaranPage` carries no player at all.
   */
  it("shows a locked non-member the membership route and NO player", async () => {
    stubStreams([aStream({ locked: true })]);
    renderRoom();

    await screen.findByTestId("live-room-lock");
    expect(screen.getByText(/Jadi anggota untuk menonton/).textContent).toContain(
      "Jadi anggota untuk menonton"
    );
    expect(screen.queryAllByTestId("stream-player").length).toBe(0);
  });

  it("an unknown id renders NotFound", async () => {
    stubStreams([aStream()]);
    renderRoom("/siaran/tidak-ada");

    await screen.findByText(/Halaman tidak ditemukan/i);
  });

  /**
   * A stream that has ended leaves `GET /streams`, so "not live any more" and
   * "never existed" arrive identically — and both are absence to a viewer.
   */
  it("a stream that is no longer live renders NotFound", async () => {
    stubStreams([]);
    renderRoom();

    await screen.findByText(/Halaman tidak ditemukan/i);
  });

  it("a failed load shows an error, not an empty room", async () => {
    stubStreams([], 500);
    renderRoom();

    await screen.findByRole("alert");
    expect(screen.queryAllByTestId("live-room").length).toBe(0);
  });

  /**
   * The chat column's space is left EMPTY rather than stubbed. A disabled
   * input or a "coming soon" panel is a control for an action that cannot
   * happen — Phase 8 owns the realtime layer chat needs.
   */
  it("renders no chat affordance at all", async () => {
    stubStreams([aStream()]);
    renderRoom();

    await screen.findByText("Sesi Q&A Malam");
    expect(screen.queryAllByRole("textbox").length).toBe(0);
    expect(screen.queryAllByText(/chat/i).length).toBe(0);
  });

  /** The conference feature, removed by the programme's Phase 7 decision. */
  it("renders no participant strip", async () => {
    stubStreams([aStream()]);
    renderRoom();

    await screen.findByText("Sesi Q&A Malam");
    // One person is on camera in a broadcast; there is nobody for a strip to
    // show, so there is no list of people anywhere on this page.
    expect(screen.queryAllByRole("list").length).toBe(0);
  });
});
