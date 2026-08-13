import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RequestStatusPage from "./RequestStatusPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(slug: string, joinRequestId: string) {
  return render(
    <MemoryRouter initialEntries={[`/c/${slug}/request/${joinRequestId}`]}>
      <Routes>
        <Route path="/c/:slug/request/:joinRequestId" element={<RequestStatusPage />} />
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

describe("RequestStatusPage", () => {
  it("renders the pending copy while the owner has not decided yet", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ status: "pending", communitySlug: "kelas-budi", subscriptionId: null })
    ) as unknown as typeof fetch;

    renderAt("kelas-budi", "jr-1");

    expect(
      await screen.findByText(
        "Permintaan Anda sudah dikirim dan menunggu persetujuan pemilik komunitas. Anda akan menerima tautan undangan grup lewat WhatsApp setelah disetujui."
      )
    ).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith("/c/kelas-budi/request/jr-1");
    // No link to a subscription status page while still pending.
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  it("renders the approved copy plus exactly one link to the subscription status page", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ status: "approved", communitySlug: "kelas-budi", subscriptionId: "sub-1" })
    ) as unknown as typeof fetch;

    renderAt("kelas-budi", "jr-1");

    expect(
      await screen.findByText("Permintaan Anda disetujui. Cek WhatsApp Anda untuk tautan undangan grup.")
    ).toBeTruthy();

    const links = screen.getAllByRole("link");
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute("href")).toBe("/c/kelas-budi/status/sub-1");
  });

  it("renders the approved copy but no link when subscriptionId is null (revoked)", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ status: "approved", communitySlug: "kelas-budi", subscriptionId: null })
    ) as unknown as typeof fetch;

    renderAt("kelas-budi", "jr-1");

    expect(
      await screen.findByText("Permintaan Anda disetujui. Cek WhatsApp Anda untuk tautan undangan grup.")
    ).toBeTruthy();
    // A link built from a null id would 404 for a member who did nothing wrong.
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  it("renders the rejected copy with no reason given", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ status: "rejected", communitySlug: "kelas-budi", subscriptionId: null })
    ) as unknown as typeof fetch;

    renderAt("kelas-budi", "jr-1");

    expect(await screen.findByText("Permintaan Anda belum dapat disetujui saat ini.")).toBeTruthy();
    expect(screen.queryAllByRole("link").length).toBe(0);
  });

  it("renders a not-found state for a 404 instead of crashing", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "join request not found" }, 404)) as unknown as typeof fetch;

    renderAt("kelas-budi", "jr-unknown");

    expect(await screen.findByText(/tidak ditemukan/)).toBeTruthy();
  });
});
