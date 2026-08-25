import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setUserSession } from "./apiClient";
import MembershipRequests from "./MembershipRequests";

const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

const REQUEST = {
  id: "req-1",
  subscriberHandle: "andi",
  subscriberDisplayName: "Andi",
  tierName: "Gratis",
  createdAt: "2026-08-20T00:00:00.000Z",
};

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

function methodOf(init: RequestInit | undefined): string {
  return init?.method ?? "GET";
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

describe("MembershipRequests — Task 7 of free memberships, the owner's queue", () => {
  it("lists a pending request by the requester's handle", async () => {
    mockApi((url) =>
      url === "/users/me/membership-requests"
        ? jsonResponse({ requests: [REQUEST] })
        : jsonResponse({ error: `unexpected ${url}` }, 500)
    );

    render(<MembershipRequests />);

    expect(await screen.findByText("@andi")).toBeTruthy();
    expect(screen.getByText("Andi")).toBeTruthy();
    expect(screen.getByText("Gratis")).toBeTruthy();
  });

  it("requests GET /users/me/membership-requests with the bearer token", async () => {
    const calls = mockApi(() => jsonResponse({ requests: [] }));

    render(<MembershipRequests />);

    await screen.findByTestId("membership-requests-empty");
    expect(calls[0]!.url).toBe("/users/me/membership-requests");
    expect(methodOf(calls[0]!.init)).toBe("GET");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer jwt-abc");
  });

  it("says so plainly when there are no pending requests", async () => {
    mockApi(() => jsonResponse({ requests: [] }));

    render(<MembershipRequests />);

    await screen.findByText("Belum ada permintaan.");
  });

  /**
   * Asserts the REQUEST that was made, not only that the row disappeared —
   * a component wired to the wrong endpoint (or to reject instead of
   * approve) would still make the row vanish from a naive `remaining = []`
   * mock, which is exactly why this pins the URL and method too.
   */
  it("approves a request, posts to the right URL, and removes it from the list", async () => {
    let remaining = [REQUEST];
    const calls = mockApi((url, init) => {
      if (url === "/users/me/membership-requests" && methodOf(init) === "GET") {
        return jsonResponse({ requests: remaining });
      }
      if (url === "/users/me/membership-requests/req-1/approve" && methodOf(init) === "POST") {
        remaining = [];
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${methodOf(init)} ${url}` }, 500);
    });

    render(<MembershipRequests />);
    fireEvent.click(await screen.findByRole("button", { name: "Setujui" }));

    await waitFor(() => expect(screen.queryAllByText("@andi").length).toBe(0));
    const approve = calls.filter(
      (c) => c.url === "/users/me/membership-requests/req-1/approve" && methodOf(c.init) === "POST"
    );
    expect(approve.length).toBe(1);
  });

  /**
   * Written out rather than sharing a helper with the approve test above:
   * these are two different endpoints, and a helper that took the verb as a
   * parameter would pass with either one wired to both.
   */
  it("rejects a request, posts to the right URL, and removes it from the list", async () => {
    let remaining = [REQUEST];
    const calls = mockApi((url, init) => {
      if (url === "/users/me/membership-requests" && methodOf(init) === "GET") {
        return jsonResponse({ requests: remaining });
      }
      if (url === "/users/me/membership-requests/req-1/reject" && methodOf(init) === "POST") {
        remaining = [];
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${methodOf(init)} ${url}` }, 500);
    });

    render(<MembershipRequests />);
    fireEvent.click(await screen.findByRole("button", { name: "Tolak" }));

    await waitFor(() => expect(screen.queryAllByText("@andi").length).toBe(0));
    const reject = calls.filter(
      (c) => c.url === "/users/me/membership-requests/req-1/reject" && methodOf(c.init) === "POST"
    );
    expect(reject.length).toBe(1);
  });

  it("approving one request leaves the others in the list", async () => {
    const second = { ...REQUEST, id: "req-2", subscriberHandle: "rina", subscriberDisplayName: "Rina" };
    let remaining = [REQUEST, second];
    mockApi((url, init) => {
      if (url === "/users/me/membership-requests" && methodOf(init) === "GET") {
        return jsonResponse({ requests: remaining });
      }
      if (url === "/users/me/membership-requests/req-1/approve" && methodOf(init) === "POST") {
        remaining = remaining.filter((r) => r.id !== "req-1");
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${methodOf(init)} ${url}` }, 500);
    });

    render(<MembershipRequests />);
    const list = await screen.findByTestId("membership-requests-list");
    await waitFor(() => expect(within(list).queryAllByText("@andi").length).toBe(1));

    const approveButtons = screen.getAllByRole("button", { name: "Setujui" });
    fireEvent.click(approveButtons[0]!);

    await waitFor(() => expect(screen.queryAllByText("@andi").length).toBe(0));
    expect(screen.getByText("@rina")).toBeTruthy();
  });

  it("shows a Bahasa error message on a failed load, never the server's own text", async () => {
    mockApi(() => jsonResponse({ error: "internal server error" }, 500));

    render(<MembershipRequests />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal memuat permintaan keanggotaan.");
    expect(alert.textContent).not.toContain("internal server error");
  });

  it("shows a Bahasa error and keeps the row when approving fails", async () => {
    mockApi((url, init) => {
      if (url === "/users/me/membership-requests" && methodOf(init) === "GET") {
        return jsonResponse({ requests: [REQUEST] });
      }
      if (url === "/users/me/membership-requests/req-1/approve" && methodOf(init) === "POST") {
        return jsonResponse({ error: "internal server error" }, 500);
      }
      return jsonResponse({ error: `unexpected ${methodOf(init)} ${url}` }, 500);
    });

    render(<MembershipRequests />);
    fireEvent.click(await screen.findByRole("button", { name: "Setujui" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Gagal menyetujui permintaan.");
    expect(alert.textContent).not.toContain("internal server error");
    // The row is still there — a failed approve must not silently drop it.
    expect(screen.getByText("@andi")).toBeTruthy();
  });
});
