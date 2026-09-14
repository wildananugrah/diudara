import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import KegiatanTab from "./KegiatanTab";
import { setUserSession, type CommunityEventRow } from "./apiClient";

/**
 * The Kegiatan tab — the month grid and the agenda below it, from ONE fetch,
 * plus (since the add/view/edit/delete modal) the calendar's OWN writes.
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

function aPostView(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    body: "kelas tatap muka daring",
    createdAt: "2026-09-15T00:00:00.000Z",
    editedAt: null,
    author: { handle: "pakandi", displayName: "Pak Andi" },
    media: [],
    membersOnly: false,
    lockedMediaCount: 0,
    type: "kegiatan",
    commentCount: 0,
    event: { title: "Trigonometri lanjutan", startsAt: STARTS_AT, endsAt: null, location: null },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

/**
 * Routes every request the tab and the modal it opens can make:
 *  - GET `.../events` — the calendar's own read.
 *  - GET `/users/posts/:id` — the detail modal's own read on open.
 *  - POST `.../communities/:slug/posts` — create.
 *  - PATCH `/users/posts/:id` — edit.
 *  - DELETE `/users/posts/:id` — delete.
 * `postDetail` is what every write/detail-read answers with (echoing the
 * request body's own `body`/`event` back, the way the real API's `toPostView`
 * does) — one fixture, since these tests are about the TAB folding a
 * response into `events`, not about the API's own behaviour (that is
 * `write-post.test.ts`'s and `posts.test.ts`'s job).
 */
function stubFetch(
  options: {
    events?: CommunityEventRow[];
    eventsStatus?: number;
    postDetail?: Record<string, unknown>;
  } = {}
): string[] {
  const calls: string[] = [];
  const post = options.postDetail ?? aPostView();
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/events")) {
      return jsonResponse(
        options.eventsStatus === undefined || options.eventsStatus === 200
          ? { events: options.events ?? [] }
          : { error: "nope" },
        options.eventsStatus ?? 200
      );
    }
    if (url.includes("/communities/") && url.includes("/posts") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { body: string; event?: unknown };
      return jsonResponse({ ...post, body: body.body, event: body.event ?? post.event }, 201);
    }
    if (url.includes("/users/posts/") && init?.method === "DELETE") {
      return jsonResponse({ deleted: true });
    }
    if (url.includes("/users/posts/") && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as { body: string; event?: unknown };
      return jsonResponse({ ...post, body: body.body, event: body.event ?? post.event });
    }
    // GET /users/posts/:id — the detail modal's own read.
    return jsonResponse(post);
  }) as unknown as typeof fetch;
  return calls;
}

function renderTab(viewerIsOwner = false) {
  return render(
    <MemoryRouter>
      <KegiatanTab slug="kelas-fisika" viewerIsOwner={viewerIsOwner} now={NOW} />
    </MemoryRouter>
  );
}

describe("KegiatanTab", () => {
  it("asks for the WIB month containing now, and names it", async () => {
    const calls = stubFetch();
    renderTab();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toContain("month=2026-09");
    expect(screen.getByText("September 2026")).toBeTruthy();
  });

  it("renders the agenda from the same fetch the grid uses", async () => {
    stubFetch({
      events: [anEvent(), anEvent({ postId: "post-2", title: "Sesi alumni", startsAt: "2026-09-20T13:00:00.000Z" })],
    });
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
    stubFetch({ events: [anEvent({ startsAt: "2026-09-15T17:30:00.000Z" })] });
    renderTab();

    await screen.findByTestId("kegiatan-day-16");
    const cell = screen.getByTestId("kegiatan-day-16");
    expect(cell.textContent).toContain("Trigonometri lanjutan");
    expect(screen.getByTestId("kegiatan-day-15").textContent).not.toContain("Trigonometri");
  });

  it("shows the WIB time on the agenda row", async () => {
    stubFetch({ events: [anEvent()] });
    renderTab();

    // 09:00Z is 16.00 in Jakarta.
    await screen.findByText(/16\.00 WIB/);
  });

  it("moves to the next month and refetches", async () => {
    const calls = stubFetch();
    renderTab();
    await waitFor(() => expect(calls.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Bulan berikutnya" }));

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toContain("month=2026-10");
    expect(screen.getByText("Oktober 2026")).toBeTruthy();
  });

  it("moves to the previous month, rolling the year at January", async () => {
    const calls = stubFetch();
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
    stubFetch();
    renderTab();

    await screen.findByText(/Belum ada kegiatan/);
    // The GRID still renders — an empty month is still a month.
    expect(screen.queryAllByTestId("kegiatan-day-15").length).toBe(1);
  });

  it("a failed fetch shows an error, not an empty calendar", async () => {
    stubFetch({ eventsStatus: 500 });
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada kegiatan/).length).toBe(0);
  });

  it("renders the weekday header Monday-first", async () => {
    stubFetch();
    renderTab();

    await screen.findByText("September 2026");
    const headers = screen.getAllByTestId("kegiatan-weekday").map((cell) => cell.textContent);
    expect(headers).toEqual(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]);
  });

  it("marks today, and only today", async () => {
    stubFetch();
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
    stubFetch({
      events: [
        anEvent({ postId: "a", title: "Satu" }),
        anEvent({ postId: "b", title: "Dua" }),
        anEvent({ postId: "c", title: "Tiga" }),
      ],
    });
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

describe("KegiatanTab — clicking a date to add a kegiatan", () => {
  it("an owner's day cells are clickable and open the add modal seeded with that date", async () => {
    stubFetch();
    renderTab(true);

    await screen.findByTestId("kegiatan-day-15");
    expect(screen.getByTestId("kegiatan-day-15").getAttribute("role")).toBe("button");

    fireEvent.click(screen.getByTestId("kegiatan-day-15"));

    await screen.findByRole("dialog");
    expect(screen.getByText("Tambah kegiatan").textContent).toBe("Tambah kegiatan");
    expect((screen.getByLabelText("Tanggal") as HTMLInputElement).value).toBe("2026-09-15");
  });

  it("a non-owner's day cells are not clickable at all", async () => {
    stubFetch();
    renderTab(false);

    await screen.findByTestId("kegiatan-day-15");
    expect(screen.getByTestId("kegiatan-day-15").getAttribute("role")).toBeNull();

    fireEvent.click(screen.getByTestId("kegiatan-day-15"));
    expect(screen.queryAllByRole("dialog").length).toBe(0);
  });

  it("creates a kegiatan and appends it to the calendar, with no refetch of the month", async () => {
    stubFetch();
    renderTab(true);
    await screen.findByTestId("kegiatan-day-20");

    fireEvent.click(screen.getByTestId("kegiatan-day-20"));
    await screen.findByRole("dialog");

    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Sesi Baru" } });
    fireEvent.change(screen.getByLabelText("Waktu mulai"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Deskripsi"), { target: { value: "kelas tambahan" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat kegiatan" }));

    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    // On screen without the tab ever re-asking `GET .../events`.
    expect(screen.getAllByText("Sesi Baru").length).toBe(2); // chip + agenda row
  });
});

describe("KegiatanTab — viewing, editing and deleting an existing kegiatan", () => {
  it("clicking a chip opens the detail modal with the event's own information", async () => {
    stubFetch({ events: [anEvent()] });
    renderTab();

    await screen.findByTestId("kegiatan-day-15");
    fireEvent.click(screen.getByRole("button", { name: "Trigonometri lanjutan" }));

    await screen.findByRole("dialog");
    expect(screen.getByText("kelas tatap muka daring").textContent).toBe("kelas tatap muka daring");
    expect(screen.getByText(/Pak Andi/).textContent).toContain("pakandi");
  });

  it("clicking the agenda row opens the same detail modal", async () => {
    stubFetch({ events: [anEvent()] });
    renderTab();

    await screen.findByText("16.00 WIB");
    // Two rows carry the title — the chip and the agenda row. The agenda
    // row's own button is the LAST one in document order.
    const buttons = screen.getAllByRole("button", { name: /Trigonometri lanjutan/ });
    fireEvent.click(buttons[buttons.length - 1]!);

    await screen.findByRole("dialog");
    expect(screen.getByText("kelas tatap muka daring").textContent).toBe("kelas tatap muka daring");
  });

  it("gives the author Edit and Hapus; a stranger sees neither", async () => {
    stubFetch({ events: [anEvent()] });
    renderTab();
    await screen.findByTestId("kegiatan-day-15");
    fireEvent.click(screen.getByRole("button", { name: "Trigonometri lanjutan" }));
    await screen.findByRole("dialog");

    // No session at all — `isOwnHandle` reads `getSessionUser()`, which is
    // null with nothing signed in (this file never calls `setUserSession`).
    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  it("editing rewrites the agenda row's title, with no refetch of the month", async () => {
    setUserSession("token-1", { handle: "pakandi", displayName: "Pak Andi", email: "pak@example.com" });
    stubFetch({ events: [anEvent()] });
    renderTab();
    await screen.findByTestId("kegiatan-day-15");
    fireEvent.click(screen.getByRole("button", { name: "Trigonometri lanjutan" }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Jadwal Baru" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    expect(screen.getAllByText("Jadwal Baru").length).toBe(2);
    expect(screen.queryAllByText("Trigonometri lanjutan").length).toBe(0);
  });

  it("deleting removes the event from the calendar entirely", async () => {
    setUserSession("token-1", { handle: "pakandi", displayName: "Pak Andi", email: "pak@example.com" });
    stubFetch({ events: [anEvent()] });
    renderTab();
    await screen.findByTestId("kegiatan-day-15");
    fireEvent.click(screen.getByRole("button", { name: "Trigonometri lanjutan" }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    expect(screen.queryAllByText("Trigonometri lanjutan").length).toBe(0);
    await screen.findByText(/Belum ada kegiatan/);
  });
});
