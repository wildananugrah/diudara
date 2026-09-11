import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotificationBell from "./NotificationBell";
import { setUserSession, type NotificationRow } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`).
 */

const NOW = new Date("2026-09-12T00:00:00.000Z");
const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function aRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n1",
    kind: "follow",
    actor: { handle: "rina", displayName: "Rina" },
    postId: null,
    communitySlug: null,
    read: false,
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  localStorage.clear();
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  options: { rows?: NotificationRow[]; unreadCount?: number; status?: number } = {}
): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/read")) return jsonResponse({ read: true });
    if (options.status !== undefined && options.status !== 200) {
      return jsonResponse({ error: "nope" }, options.status);
    }
    return jsonResponse({
      notifications: options.rows ?? [aRow()],
      unreadCount: options.unreadCount ?? 1,
    });
  }) as unknown as typeof fetch;
  return calls;
}

function signIn() {
  setUserSession("token-123", USER);
}

function renderBell() {
  return render(
    <MemoryRouter>
      <NotificationBell now={NOW} />
    </MemoryRouter>
  );
}

describe("NotificationBell", () => {
  it("shows the unread count", async () => {
    signIn();
    stubFetch({ unreadCount: 3 });
    renderBell();

    await screen.findByText("3");
  });

  it("shows no badge at zero rather than a nought", async () => {
    signIn();
    stubFetch({ unreadCount: 0 });
    renderBell();

    await screen.findByRole("button", { name: "Notifikasi" });
    expect(screen.queryAllByText("0").length).toBe(0);
  });

  /**
   * A visitor with no session has nothing to be notified about, and asking an
   * authenticated endpoint every minute to be told 401 is a request nobody
   * needed.
   */
  it("renders nothing and asks for nothing when signed out", async () => {
    const calls = stubFetch();
    renderBell();

    await waitFor(() => expect(document.body.textContent).not.toContain("Notifikasi"));
    expect(calls.length).toBe(0);
  });

  it("opening it lists what happened, and marks everything read", async () => {
    signIn();
    const calls = stubFetch({ unreadCount: 1 });
    renderBell();
    await screen.findByText("1");

    fireEvent.click(screen.getByRole("button", { name: /Notifikasi/ }));

    await screen.findByText("Rina");
    expect(screen.getByText(/mulai mengikuti Anda/).textContent).toContain("mulai mengikuti Anda");
    await waitFor(() => expect(calls.some((call) => call.includes("/read"))).toBe(true));
    // The badge clears optimistically — it must not linger while the request
    // is in flight.
    expect(screen.queryAllByText("1").length).toBe(0);
  });

  it("an empty bell says so", async () => {
    signIn();
    stubFetch({ rows: [], unreadCount: 0 });
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: "Notifikasi" }));

    await screen.findByText(/Belum ada notifikasi/);
  });

  /**
   * The link is built from the kind and the ids — the server sends no href,
   * because a URL in a response outlives the route it names.
   */
  it.each([
    [
      "a comment",
      aRow({ kind: "comment", postId: "p1", communitySlug: "kelas-fisika" }),
      "/komunitas/kelas-fisika/diskusi/p1",
    ],
    ["a join", aRow({ kind: "join", communitySlug: "kelas-fisika" }), "/komunitas/kelas-fisika"],
    ["a follow", aRow({ kind: "follow" }), "/@rina"],
  ])("links %s where it belongs", async (_label, row, href) => {
    signIn();
    stubFetch({ rows: [row] });
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifikasi/ }));

    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe(href);
  });

  /**
   * A subject can be deleted after the notification was written, so a row
   * with a missing id must not render a dead link.
   */
  it("falls back to the actor when a comment's subject is gone", async () => {
    signIn();
    stubFetch({ rows: [aRow({ kind: "comment", postId: null, communitySlug: null })] });
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifikasi/ }));

    expect((await screen.findByRole("link")).getAttribute("href")).toBe("/@rina");
  });

  it("a failed poll hides the bell rather than putting an error in every header", async () => {
    signIn();
    stubFetch({ status: 500 });
    renderBell();

    await waitFor(() => expect(document.body.textContent).not.toContain("Notifikasi"));
  });

  it("an unknown kind still reads as something, not as a blank", async () => {
    signIn();
    stubFetch({ rows: [aRow({ kind: "sesuatu-baru" })] });
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifikasi/ }));

    await screen.findByText(/melakukan sesuatu/);
  });
});
