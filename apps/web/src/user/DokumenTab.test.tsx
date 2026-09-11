import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DokumenTab from "./DokumenTab";
import type { CommunityDocumentRow } from "./apiClient";

/**
 * The Dokumen tab — an open list with member-gated bytes.
 *
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / `.getAttribute(...)` / arrays of strings.
 */

const NOW = new Date("2026-09-11T00:00:00.000Z");

function aDocument(overrides: Partial<CommunityDocumentRow> = {}): CommunityDocumentRow {
  return {
    id: "doc-1",
    name: "Rangkuman Trigonometri.pdf",
    contentType: "application/pdf",
    byteSize: 2_516_582,
    createdAt: "2026-09-08T00:00:00.000Z",
    uploader: { handle: "wildan", displayName: "Wildan" },
    membersOnly: false,
    mayDownload: false,
    ...overrides,
  };
}

let originalFetch: typeof fetch;
let originalConfirm: typeof window.confirm;

beforeEach(() => {
  originalFetch = global.fetch;
  originalConfirm = window.confirm;
});

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  cleanup();
});

function stubFetch(
  options: {
    documents?: CommunityDocumentRow[];
    viewerMayDownload?: boolean;
    status?: number;
    created?: CommunityDocumentRow;
  } = {}
): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") {
      return jsonResponse(options.created ?? aDocument({ id: "doc-new", name: "Baru.pdf" }), 201);
    }
    if (init?.method === "DELETE") return jsonResponse({ deleted: true });
    if (options.status !== undefined && options.status !== 200) {
      return jsonResponse({ error: "boom" }, options.status);
    }
    return jsonResponse({
      documents:
        options.documents ??
        [aDocument({ mayDownload: options.viewerMayDownload ?? false })],
    });
  }) as unknown as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderTab(props: { viewerIsOwner?: boolean; viewerIsMember?: boolean | null } = {}) {
  return render(
    <MemoryRouter>
      <DokumenTab
        slug="kelas-fisika"
        viewerIsOwner={props.viewerIsOwner ?? false}
        // `in`, NOT `??`. `viewerIsMember` is THREE-STATE — true member, false
        // signed-in non-member, null signed out — and `props.viewerIsMember ??
        // false` turns an explicitly passed `null` into `false`, so every
        // signed-out case silently tested the non-member one instead.
        viewerIsMember={"viewerIsMember" in props ? (props.viewerIsMember ?? null) : false}
        now={NOW}
      />
    </MemoryRouter>
  );
}

describe("DokumenTab", () => {
  it("lists every document with its name, size and date", async () => {
    stubFetch();
    renderTab();

    await screen.findByText("Rangkuman Trigonometri.pdf");
    // 2_516_582 bytes, Indonesian decimal comma.
    expect(screen.getByText(/2,4 MB/).textContent).toContain("2,4 MB");
    expect(screen.getByText(/3h/).textContent).toContain("3h");
  });

  /**
   * **The download must be an authenticated FETCH, not a plain navigation.**
   *
   * The route is member-gated behind an `Authorization: Bearer` header built
   * from localStorage, and a plain `<a href>` cannot carry one — every
   * member's click would reach the API anonymous and be refused. The cookie
   * that solves this for `<img src>` is scoped `Path=/users/media` precisely
   * so it cannot become an ambient session, so it is not available here.
   *
   * Asserted on the REQUEST the click produces, not on a rendered href: an
   * href assertion passes for exactly the broken implementation this replaced.
   */
  it("downloads through the authenticated client, not a bare link", async () => {
    const calls = stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    // Not a link at all — a link here is the bug.
    expect(screen.queryAllByRole("link", { name: /Unduh/ }).length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /Unduh/ }));

    await waitFor(() =>
      expect(calls.some((call) => call.includes("/documents/doc-1"))).toBe(true)
    );
  });

  it("a failed download says so and leaves the list alone", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.includes("/documents/doc-1")) return jsonResponse({ error: "nope" }, 404);
      return jsonResponse({ documents: [aDocument({ mayDownload: true })] });
    }) as unknown as typeof fetch;
    renderTab({ viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Unduh/ }));

    await screen.findByRole("alert");
    expect(screen.queryAllByText("Rangkuman Trigonometri.pdf").length).toBe(1);
  });

  /**
   * The rule Phase 1 set when it cut the tab bar: never render a control for
   * an action that would fail. The server says whether this viewer may
   * download, so the client never has to guess.
   */
  /**
   * The copy differs per state and that is the point: signing in and joining
   * are different actions. This used to assert `/Gabung/` for both, which
   * passed only because the render helper collapsed an explicit `null` into
   * `false` — so the signed-out case was never actually exercised.
   */
  it.each([
    ["a signed-in non-member", false as boolean | null, "Gabung untuk unduh"],
    ["a signed-out visitor", null as boolean | null, "Masuk untuk unduh"],
  ])("shows %s the list but no download control", async (_label, viewerIsMember, expected) => {
    stubFetch({ viewerMayDownload: false });
    renderTab({ viewerIsMember });

    await screen.findByText("Rangkuman Trigonometri.pdf");
    expect(screen.queryAllByRole("button", { name: /Unduh/ }).length).toBe(0);
    expect(screen.getByText(expected).textContent).toBe(expected);
  });

  it("an empty library says so", async () => {
    stubFetch({ documents: [] });
    renderTab();

    await screen.findByText(/Belum ada dokumen/);
  });

  it("a failed fetch shows an error, not an empty library", async () => {
    stubFetch({ status: 500 });
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada dokumen/).length).toBe(0);
  });

  it("hides the upload control from everyone but the owner", async () => {
    stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsMember: true });

    await screen.findByText("Rangkuman Trigonometri.pdf");
    expect(screen.queryAllByLabelText("Unggah dokumen").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: /Hapus/ }).length).toBe(0);
  });

  it("the owner uploads, and the new document appears without a refetch", async () => {
    const calls = stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    const input = screen.getByLabelText("Unggah dokumen") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1])], "Baru.pdf", { type: "application/pdf" })] },
    });

    await screen.findByText("Baru.pdf");
    // One list read and one POST — the new row is prepended, not refetched.
    expect(calls.filter((call) => call.startsWith("GET")).length).toBe(1);
    expect(calls.filter((call) => call.startsWith("POST")).length).toBe(1);
  });

  it("refuses a file over the cap in the browser, naming the limit", async () => {
    stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    const oversized = new File([new Uint8Array(1)], "Besar.pdf", { type: "application/pdf" });
    // `size` is read-only on File, so it is stubbed rather than built from
    // 25 MB of real bytes — allocating that in a test would be the slowest
    // thing in the suite for no extra coverage.
    Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Unggah dokumen"), { target: { files: [oversized] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("25 MB");
  });

  it("refuses an unsupported type in the browser, before any request", async () => {
    const calls = stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    fireEvent.change(screen.getByLabelText("Unggah dokumen"), {
      target: { files: [new File([new Uint8Array([1])], "evil.html", { type: "text/html" })] },
    });

    await screen.findByRole("alert");
    expect(calls.filter((call) => call.startsWith("POST")).length).toBe(0);
  });

  it("the owner deletes after confirming, and the row goes", async () => {
    window.confirm = mock(() => true) as unknown as typeof window.confirm;
    stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Hapus/ }));

    await waitFor(() =>
      expect(screen.queryAllByText("Rangkuman Trigonometri.pdf").length).toBe(0)
    );
  });

  /**
   * The order `PostCard.onDeleteRequested`'s docstring records, after that
   * callback was once named as though the row were already gone: confirm,
   * then send, then remove.
   */
  it("a cancelled confirmation deletes nothing", async () => {
    window.confirm = mock(() => false) as unknown as typeof window.confirm;
    const calls = stubFetch({ viewerMayDownload: true });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Hapus/ }));

    expect(calls.filter((call) => call.startsWith("DELETE")).length).toBe(0);
    expect(screen.queryAllByText("Rangkuman Trigonometri.pdf").length).toBe(1);
  });

  it("a failed delete leaves the row on screen and says why", async () => {
    window.confirm = mock(() => true) as unknown as typeof window.confirm;
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ documents: [aDocument({ mayDownload: true })] });
    }) as unknown as typeof fetch;
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Rangkuman Trigonometri.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Hapus/ }));

    await screen.findByRole("alert");
    // The row is still there — removing it on a failed DELETE would show the
    // owner a deletion the server never performed.
    expect(screen.queryAllByText("Rangkuman Trigonometri.pdf").length).toBe(1);
  });
});

/**
 * Phase 5 — the members-only gate on screen. The server decides
 * `mayDownload`; this component only has to render the right control and the
 * right REASON, because three different answers need three different actions.
 */
describe("DokumenTab — members-only documents", () => {
  const OPEN = aDocument({ id: "open", name: "Terbuka.pdf", mayDownload: true });
  const LOCKED = aDocument({
    id: "locked",
    name: "Khusus.pdf",
    membersOnly: true,
    mayDownload: false,
  });

  it("shows a download for what this viewer may open and a reason for what they may not", async () => {
    stubFetch({ documents: [OPEN, LOCKED] });
    renderTab({ viewerIsMember: true });

    await screen.findByText("Terbuka.pdf");
    expect(screen.getAllByRole("button", { name: /Unduh/ }).length).toBe(1);
    // A member who only needs to subscribe must be told that, not handed a
    // generic refusal they cannot act on.
    expect(screen.getByText("Khusus anggota berbayar").textContent).toBe(
      "Khusus anggota berbayar"
    );
  });

  it.each([
    ["a signed-out visitor", null as boolean | null, "Masuk untuk unduh"],
    ["a signed-in non-member", false as boolean | null, "Gabung untuk unduh"],
  ])("tells %s what to do instead", async (_label, viewerIsMember, expected) => {
    stubFetch({ documents: [aDocument({ membersOnly: true, mayDownload: false })] });
    renderTab({ viewerIsMember });

    await screen.findByText("Rangkuman Trigonometri.pdf");
    expect(screen.getByText(expected).textContent).toBe(expected);
  });

  it("the owner's upload sends the members-only flag only when ticked", async () => {
    const calls = stubFetch({ documents: [OPEN] });
    renderTab({ viewerIsOwner: true, viewerIsMember: true });
    await screen.findByText("Terbuka.pdf");

    fireEvent.click(screen.getByLabelText("Khusus anggota berbayar"));
    fireEvent.change(screen.getByLabelText("Unggah dokumen"), {
      target: {
        files: [new File([new Uint8Array([1])], "Baru.pdf", { type: "application/pdf" })],
      },
    });

    await waitFor(() => expect(calls.some((call) => call.startsWith("POST"))).toBe(true));
  });

  it("a non-owner never sees the members-only checkbox", async () => {
    stubFetch({ documents: [OPEN] });
    renderTab({ viewerIsMember: true });

    await screen.findByText("Terbuka.pdf");
    expect(screen.queryAllByLabelText("Khusus anggota berbayar").length).toBe(0);
  });
});
