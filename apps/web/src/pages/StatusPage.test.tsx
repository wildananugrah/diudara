import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StatusPage from "./StatusPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Small timings so the test suite doesn't sit around for real minutes. */
function renderAt(subscriptionId: string, opts: { pollIntervalMs?: number; timeoutMs?: number } = {}) {
  return render(
    <MemoryRouter initialEntries={[`/c/kelas-budi/status/${subscriptionId}`]}>
      <Routes>
        <Route
          path="/c/:slug/status/:subscriptionId"
          element={<StatusPage pollIntervalMs={opts.pollIntervalMs ?? 10} timeoutMs={opts.timeoutMs ?? 1000} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("StatusPage", () => {
  it("shows a pending state while the subscription is not yet active", async () => {
    global.fetch = mock(async () => jsonResponse({ status: "pending" })) as unknown as typeof fetch;

    renderAt("sub-1");

    expect(await screen.findByText(/menunggu pembayaran/i)).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith("/c/subscription/sub-1/status");
  });

  it("shows success once the endpoint reports active", async () => {
    global.fetch = mock(async () => jsonResponse({ status: "active" })) as unknown as typeof fetch;

    renderAt("sub-1");

    expect(await screen.findByText(/berhasil/i)).toBeTruthy();
  });

  it("polls repeatedly, then flips to active once a later poll reports it", async () => {
    let call = 0;
    global.fetch = mock(async () => {
      call += 1;
      return jsonResponse({ status: call < 3 ? "pending" : "active" });
    }) as unknown as typeof fetch;

    renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 5000 });

    expect(await screen.findByText(/menunggu pembayaran/i)).toBeTruthy();
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(3));
    expect(await screen.findByText(/berhasil/i)).toBeTruthy();
  });

  it("stops polling and shows guidance after the timeout if it never goes active", async () => {
    const fetchMock = mock(async () => jsonResponse({ status: "pending" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 50 });

    // Tells the member something actionable, not just "still waiting".
    await waitFor(() => expect(document.body.textContent).toMatch(/belum kami terima/i));
    expect(document.body.textContent).toMatch(/hubungi|coba lagi/i);

    const callsAtTimeout = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    // No more calls after the timeout fired — the interval was cleared.
    expect(fetchMock.mock.calls.length).toBe(callsAtTimeout);
  });

  it("renders a not-found state for a 404 instead of polling forever", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "subscription not found" }, 404)) as unknown as typeof fetch;

    renderAt("sub-unknown");

    expect(await screen.findByText(/tidak ditemukan/i)).toBeTruthy();
  });
});
