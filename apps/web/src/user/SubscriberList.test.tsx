import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setUserSession } from "./apiClient";
import SubscriberList from "./SubscriberList";

const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };
const NOW = new Date("2026-08-21T12:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Installs a `fetch` mock and returns the list it records every call into. */
function mockApi(handler: (url: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  setUserSession("jwt-abc", USER);
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("SubscriberList — removing a member", () => {
  const FREE = { handle: "budi", displayName: "Budi", since: "2026-08-01T00:00:00.000Z", kind: "free" };
  const PAID = { handle: "andi", displayName: "Andi", since: "2026-08-01T00:00:00.000Z", kind: "paid" };

  /**
   * The button is offered for a FREE membership only. A paid one cannot be
   * revoked — stopping it mid-period takes money for a service that then
   * stops, and this product has no refund path — so the server answers 409.
   * Rendering the button anyway would offer an action that fails.
   */
  it("offers Keluarkan for a free member and not for a paying one", async () => {
    mockApi((url) =>
      url === "/users/me/subscribers"
        ? jsonResponse({ subscribers: [FREE, PAID] })
        : jsonResponse({ error: `unexpected ${url}` }, 500)
    );

    render(<SubscriberList now={NOW} />);

    await screen.findByText("Budi");
    expect(screen.getByTestId("revoke-budi")).toBeTruthy();
    // `=== null` rather than handing the node to a matcher: a failure prints a
    // boolean, not a serialised DOM tree.
    expect(screen.queryByTestId("revoke-andi") === null).toBe(true);
  });

  /**
   * Asserts the REQUEST, not just that the row vanished. A list that re-read
   * an unchanged server would empty just as convincingly if the button were
   * wired to the wrong endpoint — or to nothing at all.
   */
  it("POSTs the revoke, then re-reads the list from the server", async () => {
    let removed = false;
    const calls = mockApi((url, init) => {
      if (url === "/users/me/subscribers/budi/revoke" && (init?.method ?? "GET") === "POST") {
        removed = true;
        return jsonResponse({ ok: true });
      }
      if (url === "/users/me/subscribers") {
        return jsonResponse({ subscribers: removed ? [] : [FREE] });
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    render(<SubscriberList now={NOW} />);
    fireEvent.click(await screen.findByTestId("revoke-budi"));

    await waitFor(() => expect(screen.queryByText("Budi") === null).toBe(true));
    expect(
      calls.some(
        (call) =>
          call.url === "/users/me/subscribers/budi/revoke" && (call.init?.method ?? "GET") === "POST"
      )
    ).toBe(true);
    // Re-READ, not spliced: the listing was fetched twice.
    expect(calls.filter((call) => call.url === "/users/me/subscribers").length).toBe(2);
  });

  it("keeps the member on screen and says why when the server refuses", async () => {
    mockApi((url) => {
      if (url.endsWith("/revoke")) {
        return jsonResponse({ error: "Keanggotaan berbayar tidak dapat dihentikan dari sini." }, 409);
      }
      return url === "/users/me/subscribers"
        ? jsonResponse({ subscribers: [FREE] })
        : jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    render(<SubscriberList now={NOW} />);
    fireEvent.click(await screen.findByTestId("revoke-budi"));

    await screen.findByRole("alert");
    // Still a member: a refused removal must not look like a successful one.
    expect(screen.getByText("Budi")).toBeTruthy();
  });
});

describe("SubscriberList (Task 6 of Phase 5b)", () => {
  it("shows a loading state, then the list of current subscribers", async () => {
    mockApi((url) => {
      if (url === "/users/me/subscribers") {
        return jsonResponse({
          subscribers: [
            { handle: "bob", displayName: "Bob", since: "2026-08-01T00:00:00.000Z" },
          ],
        });
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    render(<SubscriberList now={NOW} />);

    expect(screen.getByText("Memuat daftar pelanggan...")).toBeTruthy();
    await screen.findByText("Bob");
    expect(screen.getByText("@bob")).toBeTruthy();
  });

  it("requests GET /users/me/subscribers with the bearer token", async () => {
    const calls = mockApi(() => jsonResponse({ subscribers: [] }));

    render(<SubscriberList now={NOW} />);

    await screen.findByTestId("subscriber-list-empty");
    expect(calls[0]!.url).toBe("/users/me/subscribers");
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("shows a Bahasa empty state for a creator with no current subscribers", async () => {
    mockApi(() => jsonResponse({ subscribers: [] }));

    render(<SubscriberList now={NOW} />);

    await screen.findByText("Belum ada pelanggan yang berlangganan saat ini.");
  });

  it("shows a Bahasa error message on failure, never the server's own text", async () => {
    mockApi(() => jsonResponse({ error: "internal server error" }, 500));

    render(<SubscriberList now={NOW} />);

    const alert = await screen.findByRole("alert");
    // Both directions: the Bahasa context sentence is present, AND the raw
    // server string never reached the screen — a queryAllByText check alone
    // cannot see a sentence the screen appends to its own.
    expect(alert.textContent).toContain("Gagal memuat daftar pelanggan.");
    expect(alert.textContent).not.toContain("internal server error");
  });

  it("renders multiple subscribers, each with handle, display name, and when they joined", async () => {
    mockApi(() =>
      jsonResponse({
        subscribers: [
          { handle: "bob", displayName: "Bob", since: "2026-08-01T00:00:00.000Z" },
          { handle: "rina", displayName: "Rina", since: "2026-07-01T00:00:00.000Z" },
        ],
      })
    );

    render(<SubscriberList now={NOW} />);

    await waitFor(() => expect(screen.getByTestId("subscriber-list")).toBeTruthy());
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("@bob")).toBeTruthy();
    expect(screen.getByText("Rina")).toBeTruthy();
    expect(screen.getByText("@rina")).toBeTruthy();
    // The absolute Indonesian date `formatRelativeTime` produces at 7+ days —
    // pins that `since` actually reaches the screen, not merely that SOME
    // text renders.
    expect(screen.getByText("Sejak 1 Agu 2026")).toBeTruthy();
    expect(screen.getByText("Sejak 1 Jul 2026")).toBeTruthy();
  });

  /**
   * NEVER an email, a whatsapp_number, or a payout id — even if one somehow
   * arrived on the wire (a server regression), this component reads exactly
   * `handle`/`displayName`/`since` off each row and renders nothing else, so
   * an extra field on the response could not reach the screen through this
   * path.
   *
   * Fix round 1, M-1 (review): the ORIGINAL version of this test asserted
   * `queryAllByText("bob@example.com").length === 0`, which uses an EXACT
   * text match against each element's own normalised text — so a component
   * rendering `JSON.stringify(subscriber)` inside one `<span>` (email and
   * all) left every element's text as one long JSON string, which does not
   * exactly equal `"bob@example.com"`, and the assertion passed anyway. The
   * reviewer proved this by planting exactly that mutation; all 6 tests in
   * this file stayed green.
   *
   * Fixed by reading `textContent` off the list container — a STRING, never
   * a DOM node, on either side of the assertion (`no-hanging-dom-assertions
   * .test.ts`) — and asserting a SUBSTRING check in both directions: the
   * three real fields are present, and a planted email/whatsapp number is
   * absent. `.not.toContain(...)` sees an email embedded anywhere inside a
   * longer string; `queryAllByText`'s exact matcher never could.
   */
  it("renders only handle, displayName, and since — an extra field on the wire cannot reach the screen", async () => {
    mockApi(() =>
      jsonResponse({
        subscribers: [
          {
            handle: "bob",
            displayName: "Bob",
            since: "2026-08-01T00:00:00.000Z",
            email: "bob@example.com",
            whatsappNumber: "+628123456789",
          },
        ],
      })
    );

    render(<SubscriberList now={NOW} />);

    await screen.findByTestId("subscriber-list");
    const listText = screen.getByTestId("subscriber-list").textContent ?? "";

    // Present: the three fields the projection actually carries.
    expect(listText).toContain("Bob");
    expect(listText).toContain("bob");
    expect(listText).toContain("Agu");

    // Absent: an email or WhatsApp number, wherever in the markup it might
    // have leaked — not merely as an exact standalone text node.
    expect(listText).not.toContain("bob@example.com");
    expect(listText).not.toContain("+628123456789");
  });
});
