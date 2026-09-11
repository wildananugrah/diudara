import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import KegiatanTab from "./KegiatanTab";
import type { CommunityEventRow } from "./apiClient";

/**
 * The Kegiatan tab — the month grid and the agenda below it, from ONE fetch.
 *
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / `.getAttribute(...)` / arrays of strings.
 */

/** 15 September 2026, 16:00 WIB. */
const STARTS_AT = "2026-09-15T09:00:00.000Z";
/** 4 September 2026, 10:00 WIB — the "now" every test renders at. */
const NOW = new Date("2026-09-04T03:00:00.000Z");

function anEvent(overrides: Partial<CommunityEventRow> = {}): CommunityEventRow {
  return {
    postId: "post-1",
    title: "Trigonometri lanjutan",
    startsAt: STARTS_AT,
    endsAt: null,
    location: null,
    author: { handle: "pakandi", displayName: "Pak Andi" },
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

/** Records every requested URL, so the tests can assert which month was asked for. */
function stubFetch(events: CommunityEventRow[] = [], status = 200): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(status === 200 ? { events } : { error: "nope" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function renderTab() {
  return render(
    <MemoryRouter>
      <KegiatanTab slug="kelas-fisika" now={NOW} />
    </MemoryRouter>
  );
}

describe("KegiatanTab", () => {
  it("asks for the WIB month containing now, and names it", async () => {
    const calls = stubFetch([]);
    renderTab();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toContain("month=2026-09");
    expect(screen.getByText("September 2026")).toBeTruthy();
  });

  it("renders the agenda from the same fetch the grid uses", async () => {
    stubFetch([anEvent(), anEvent({ postId: "post-2", title: "Sesi alumni", startsAt: "2026-09-20T13:00:00.000Z" })]);
    renderTab();

    // findAllBy, not findBy: each title is rendered twice on purpose, and a
    // single-match query would fail on the very property being asserted.
    await screen.findAllByText("Sesi alumni");
    // The title appears twice — once as a chip in its day cell, once in the
    // agenda row. That is the point: one fetch, two renderings.
    expect(screen.getAllByText("Trigonometri lanjutan").length).toBe(2);
  });

  it("places an event under its WIB day, not its UTC one", async () => {
    // 16 September, 00:30 WIB = 15 September, 17:30 UTC. A grid bucketing on
    // UTC parts puts this chip in the 15th's cell.
    stubFetch([anEvent({ startsAt: "2026-09-15T17:30:00.000Z" })]);
    renderTab();

    await screen.findByTestId("kegiatan-day-16");
    const cell = screen.getByTestId("kegiatan-day-16");
    expect(cell.textContent).toContain("Trigonometri lanjutan");
    expect(screen.getByTestId("kegiatan-day-15").textContent).not.toContain("Trigonometri");
  });

  it("links each agenda row and each chip to the event page", async () => {
    stubFetch([anEvent()]);
    renderTab();

    await screen.findAllByRole("link", { name: /Trigonometri lanjutan/ });
    const hrefs = screen
      .getAllByRole("link", { name: /Trigonometri lanjutan/ })
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/komunitas/kelas-fisika/kegiatan/post-1",
      "/komunitas/kelas-fisika/kegiatan/post-1",
    ]);
  });

  it("shows the WIB time on the agenda row", async () => {
    stubFetch([anEvent()]);
    renderTab();

    // 09:00Z is 16.00 in Jakarta.
    await screen.findByText(/16\.00 WIB/);
  });

  it("moves to the next month and refetches", async () => {
    const calls = stubFetch([]);
    renderTab();
    await waitFor(() => expect(calls.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Bulan berikutnya" }));

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toContain("month=2026-10");
    expect(screen.getByText("Oktober 2026")).toBeTruthy();
  });

  it("moves to the previous month, rolling the year at January", async () => {
    const calls = stubFetch([]);
    render(
      <MemoryRouter>
        <KegiatanTab slug="kelas-fisika" now={new Date("2026-01-15T03:00:00.000Z")} />
      </MemoryRouter>
    );
    await waitFor(() => expect(calls.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Bulan sebelumnya" }));

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toContain("month=2025-12");
  });

  it("an empty month says so rather than showing a blank page", async () => {
    stubFetch([]);
    renderTab();

    await screen.findByText(/Belum ada kegiatan/);
    // The GRID still renders — an empty month is still a month.
    expect(screen.queryAllByTestId("kegiatan-day-15").length).toBe(1);
  });

  it("a failed fetch shows an error, not an empty calendar", async () => {
    stubFetch([], 500);
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada kegiatan/).length).toBe(0);
  });

  it("renders the weekday header Monday-first", async () => {
    stubFetch([]);
    renderTab();

    await screen.findByText("September 2026");
    const headers = screen.getAllByTestId("kegiatan-weekday").map((cell) => cell.textContent);
    expect(headers).toEqual(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]);
  });

  it("marks today, and only today", async () => {
    stubFetch([]);
    renderTab();

    await screen.findByTestId("kegiatan-day-4");
    // Hoisted to strings BEFORE the assertions below. Handing a query result
    // straight to a null-checking matcher is the shape
    // `no-hanging-dom-assertions.test.ts` forbids: on failure Bun serialises
    // the received value, and a happy-dom element takes its whole listener map
    // and parent chain with it.
    const today = screen.getByTestId("kegiatan-day-4").getAttribute("data-today");
    const notToday = screen.getByTestId("kegiatan-day-5").getAttribute("data-today");
    expect(today).toBe("true");
    expect(notToday).toBeNull();
  });

  /**
   * A day with more than two events collapses the rest into a count, the way
   * the reference does — a cell that grows with its contents breaks the grid.
   */
  it("shows at most two chips a day and counts the rest", async () => {
    stubFetch([
      anEvent({ postId: "a", title: "Satu" }),
      anEvent({ postId: "b", title: "Dua" }),
      anEvent({ postId: "c", title: "Tiga" }),
    ]);
    renderTab();

    await screen.findByTestId("kegiatan-day-15");
    const cell = screen.getByTestId("kegiatan-day-15");
    expect(cell.textContent).toContain("Satu");
    expect(cell.textContent).toContain("Dua");
    expect(cell.textContent).not.toContain("Tiga");
    expect(cell.textContent).toContain("+1 lagi");
    // All three are still in the agenda below — the cell is what is capped.
    expect(screen.getAllByText("Tiga").length).toBe(1);
  });
});
