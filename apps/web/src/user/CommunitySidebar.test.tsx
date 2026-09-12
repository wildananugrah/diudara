import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunitySidebar from "./CommunitySidebar";

/** 1 February 2026, 07:00 WIB — the "now" every test renders at. */
const NOW = new Date("2026-02-01T00:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function anEvent(overrides: Record<string, unknown> = {}) {
  return {
    postId: "post-1",
    title: "Sesi tanya jawab",
    startsAt: "2026-02-20T09:00:00.000Z",
    endsAt: null,
    location: null,
    author: { handle: "wildan", displayName: "Wildan" },
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

describe("CommunitySidebar", () => {
  it("shows the community's description under Tentang komunitas", async () => {
    global.fetch = mock(async () => jsonResponse({ events: [] })) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description="Belajar desain dari nol." now={NOW} />
      </MemoryRouter>
    );

    expect(screen.getByText("Tentang komunitas")).toBeTruthy();
    expect(screen.getByText("Belajar desain dari nol.")).toBeTruthy();
    await screen.findByText(/Belum ada jadwal/);
  });

  it("omits the Tentang komunitas card entirely when there is no description", async () => {
    global.fetch = mock(async () => jsonResponse({ events: [] })) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description={null} now={NOW} />
      </MemoryRouter>
    );

    await screen.findByText("Event mendatang");
    expect(screen.queryAllByText("Tentang komunitas").length).toBe(0);
  });

  it("reads the current and next WIB month, and lists their events in date order", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (url.includes("month=2026-02")) {
        return jsonResponse({ events: [anEvent({ postId: "e1", title: "Sesi tanya jawab" })] });
      }
      if (url.includes("month=2026-03")) {
        return jsonResponse({
          events: [
            anEvent({ postId: "e2", title: "Kelas lanjutan", startsAt: "2026-03-05T09:00:00.000Z" }),
          ],
        });
      }
      return jsonResponse({ events: [] });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description={null} now={NOW} />
      </MemoryRouter>
    );

    await screen.findByText("Sesi tanya jawab");
    expect(screen.getByText("Kelas lanjutan")).toBeTruthy();
    expect(calls.some((call) => call.includes("month=2026-02"))).toBe(true);
    expect(calls.some((call) => call.includes("month=2026-03"))).toBe(true);
  });

  it("drops events already in the past and caps the list at three", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.includes("month=2026-02")) {
        return jsonResponse({
          events: [
            anEvent({ postId: "past", title: "Sudah lewat", startsAt: "2026-01-15T09:00:00.000Z" }),
            anEvent({ postId: "e1", title: "Event satu", startsAt: "2026-02-05T09:00:00.000Z" }),
            anEvent({ postId: "e2", title: "Event dua", startsAt: "2026-02-10T09:00:00.000Z" }),
            anEvent({ postId: "e3", title: "Event tiga", startsAt: "2026-02-15T09:00:00.000Z" }),
            anEvent({ postId: "e4", title: "Event empat", startsAt: "2026-02-20T09:00:00.000Z" }),
          ],
        });
      }
      return jsonResponse({ events: [] });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description={null} now={NOW} />
      </MemoryRouter>
    );

    await screen.findByText("Event satu");
    expect(screen.queryAllByText("Sudah lewat").length).toBe(0);
    expect(screen.getByText("Event dua")).toBeTruthy();
    expect(screen.getByText("Event tiga")).toBeTruthy();
    expect(screen.queryAllByText("Event empat").length).toBe(0);
  });

  it("shows an empty note when nothing is scheduled", async () => {
    global.fetch = mock(async () => jsonResponse({ events: [] })) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description={null} now={NOW} />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Belum ada jadwal/)).toBeTruthy();
  });

  it("fails quietly to an empty list when the events read errors out", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <CommunitySidebar slug="kelas-desain" description={null} now={NOW} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText(/Belum ada jadwal/)).toBeTruthy());
  });
});
