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

  describe("the 'Tonton sekarang' link (Task 8)", () => {
    it("shows a watch link once active, when the API supplies a watchUrl", async () => {
      global.fetch = mock(async () =>
        jsonResponse({ status: "active", watchUrl: "/watch/abc123" })
      ) as unknown as typeof fetch;

      renderAt("sub-1");

      const link = await screen.findByRole("link", { name: /tonton sekarang/i });
      expect(link.getAttribute("href")).toBe("/watch/abc123");
    });

    it("shows no watch link when active but the API supplies no watchUrl", async () => {
      global.fetch = mock(async () => jsonResponse({ status: "active" })) as unknown as typeof fetch;

      renderAt("sub-1");

      await screen.findByText(/berhasil/i);
      // Counted, not asserted with `.toBeNull()` — see
      // src/test/no-hanging-dom-assertions.test.ts for why a failing
      // `toBeNull()` on a DOM element hangs the whole suite instead of
      // failing it.
      expect(screen.queryAllByRole("link", { name: /tonton sekarang/i }).length).toBe(0);
    });

    it("shows no watch link while still pending, even if a watchUrl were ever present", async () => {
      global.fetch = mock(async () => jsonResponse({ status: "pending" })) as unknown as typeof fetch;

      renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 50 });

      await screen.findByText(/menunggu pembayaran/i);
      expect(screen.queryAllByRole("link", { name: /tonton sekarang/i }).length).toBe(0);
    });

    /**
     * Review finding: a member who pays BEFORE the creator goes live used to
     * see `{status:"active"}` with no `watchUrl`, stop polling permanently,
     * and never see the link even once the creator went live in the SAME
     * tab. This page is "the only place a member can reach a stream until
     * Fonnte is configured" (brief) — permanently giving up here contradicts
     * that.
     */
    it("keeps polling for a watchUrl after becoming active, and shows the link once one appears", async () => {
      let call = 0;
      global.fetch = mock(async () => {
        call += 1;
        // active immediately, but no watchUrl for the first few polls —
        // the community goes live only partway through this member's visit.
        return jsonResponse({ status: "active", watchUrl: call < 3 ? undefined : "/watch/late-link" });
      }) as unknown as typeof fetch;

      renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 5000 });

      expect(await screen.findByText(/berhasil/i)).toBeTruthy();
      expect(screen.queryAllByRole("link", { name: /tonton sekarang/i }).length).toBe(0);

      const link = await screen.findByRole("link", { name: /tonton sekarang/i });
      expect(link.getAttribute("href")).toBe("/watch/late-link");
    });

    it("stays on the success screen — not timed-out, not an error — if no watchUrl ever appears before the deadline", async () => {
      const fetchMock = mock(async () => jsonResponse({ status: "active" }));
      global.fetch = fetchMock as unknown as typeof fetch;

      renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 50 });

      expect(await screen.findByText(/berhasil/i)).toBeTruthy();

      const callsAtSomePoint = fetchMock.mock.calls.length;
      await new Promise((r) => setTimeout(r, 150)); // well past the 50ms deadline

      // Still the success screen — never downgraded to "timed-out" or "error".
      expect(screen.queryAllByText(/berhasil/i).length).toBe(1);
      expect(screen.queryAllByText(/belum kami terima/i).length).toBe(0);
      expect(screen.queryAllByText(/gagal memeriksa status/i).length).toBe(0);
      // Polling genuinely stopped at the deadline rather than continuing forever.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsAtSomePoint);
      const callsAfterWait = fetchMock.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(fetchMock.mock.calls.length).toBe(callsAfterWait);
    });

    it("stays on the success screen even if a later poll (while waiting for a watchUrl) errors", async () => {
      // Keyed on the URL rather than on a call counter: StatusPage also looks
      // up its community once (to choose paid vs free wording), and a counter
      // would score that lookup as one of the polls this test is arranging.
      let polls = 0;
      global.fetch = mock(async (url: string) => {
        if (!url.startsWith("/c/subscription/")) return jsonResponse({ accessMode: "paid" });
        polls += 1;
        if (polls === 1) return jsonResponse({ status: "active" });
        throw new Error("transient network blip");
      }) as unknown as typeof fetch;

      renderAt("sub-1", { pollIntervalMs: 10, timeoutMs: 200 });

      expect(await screen.findByText(/berhasil/i)).toBeTruthy();
      await new Promise((r) => setTimeout(r, 250));

      expect(screen.queryAllByText(/berhasil/i).length).toBe(1);
      expect(screen.queryAllByText(/gagal memeriksa status/i).length).toBe(0);
    });
  });
});

/**
 * The gate's item A. `RequestStatusPage` deliberately links an APPROVED free
 * member here ("Lihat status keanggotaan"), and this page then told them a
 * payment they never made had succeeded — deterministic for every approved free
 * member, not a corner case: `GET /c/subscription/<id>/status` returns
 * `{"status":"active"}` and the first poll renders the `active` phase.
 *
 * The `checking` phase is on the same common path: it renders before the first
 * poll resolves, so a free member sees "Menunggu pembayaran..." every time too.
 */
describe("StatusPage — a member who joined for free (gate fix round)", () => {
  /** Answers the subscription poll and the community lookup separately. */
  function stubBoth(subscriptionBody: unknown, community: unknown, communityStatus = 200) {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/c/subscription/")) return jsonResponse(subscriptionBody);
      return jsonResponse(community, communityStatus);
    }) as unknown as typeof fetch;
  }

  const FREE = { accessMode: "request", name: "Kelas Gratis", slug: "kelas-budi", tiers: [] };
  const PAID = { accessMode: "paid", name: "Kelas Budi", slug: "kelas-budi", tiers: [] };

  it("never claims a payment succeeded for a free membership", async () => {
    stubBoth({ status: "active" }, FREE);

    renderAt("sub-1");

    expect(await screen.findByText(/keanggotaan anda sudah aktif/i)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryAllByText(/pembayaran berhasil/i).length).toBe(0);
    });
  });

  it("still says a payment succeeded for a PAID membership", async () => {
    stubBoth({ status: "active" }, PAID);

    renderAt("sub-1");

    expect(await screen.findByText(/pembayaran berhasil/i)).toBeTruthy();
  });

  it("does not say 'menunggu pembayaran' to a free member while the first poll is in flight", async () => {
    stubBoth({ status: "pending" }, FREE);

    renderAt("sub-1");

    expect(await screen.findByText(/menunggu persetujuan/i)).toBeTruthy();
    expect(screen.queryAllByText(/menunggu pembayaran/i).length).toBe(0);
  });

  it("does not tell a free member to go and pay after the timeout", async () => {
    stubBoth({ status: "churned" }, FREE);

    renderAt("sub-1", { pollIntervalMs: 5, timeoutMs: 20 });

    // Wait for the timed-out phase itself first — asserting on absence while the
    // page is still in `checking` would pass for the wrong reason.
    expect(await screen.findByText(/keanggotaan ini belum aktif/i)).toBeTruthy();
    expect(screen.getByText(/hubungi penyelenggara komunitas/i)).toBeTruthy();
    // The instruction a free member cannot follow: there is no checkout to retry.
    expect(screen.queryAllByText(/tautan checkout/i).length).toBe(0);
    expect(screen.queryAllByText(/sudah membayar/i).length).toBe(0);
  });

  it("falls back to the paid wording when the community cannot be read at all", async () => {
    // An archived community 404s its public page. A PAYING member is the
    // overwhelmingly likely reader of a status URL in that state, so the paid
    // wording is the safer default — and it is what this page always said.
    stubBoth({ status: "active" }, { error: "community not found" }, 404);

    renderAt("sub-1");

    expect(await screen.findByText(/pembayaran berhasil/i)).toBeTruthy();
  });
});
