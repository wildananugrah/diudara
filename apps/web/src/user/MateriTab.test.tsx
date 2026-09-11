import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MateriTab from "./MateriTab";
import { setUserSession, type SectionRow } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`).
 */

const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function aSection(overrides: Partial<SectionRow> = {}): SectionRow {
  return {
    id: "s1",
    title: "Minggu 1",
    position: 1,
    lessonCount: 1,
    lessons: [
      {
        id: "l1",
        title: "Pengenalan",
        body: "mulai dari sini",
        position: 1,
        attachment: null,
      },
    ],
    ...overrides,
  };
}

let originalFetch: typeof fetch;
let originalConfirm: typeof window.confirm;

beforeEach(() => {
  originalFetch = global.fetch;
  originalConfirm = window.confirm;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  localStorage.clear();
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(options: { sections?: SectionRow[]; status?: number } = {}): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return jsonResponse({ id: "new" }, 201);
    if (init?.method === "DELETE") return jsonResponse({ deleted: true });
    if (url.includes("/documents/")) return new Response(new Uint8Array([1]), { status: 200 });
    if (options.status !== undefined && options.status !== 200) {
      return jsonResponse({ error: "boom" }, options.status);
    }
    return jsonResponse({ sections: options.sections ?? [aSection()] });
  }) as unknown as typeof fetch;
  return calls;
}

function renderTab(viewerIsOwner = false) {
  return render(<MateriTab slug="kelas-fisika" viewerIsOwner={viewerIsOwner} />);
}

describe("MateriTab", () => {
  it("lists sections with their real lesson count", async () => {
    stubFetch({ sections: [aSection({ lessonCount: 6 })] });
    renderTab();

    await screen.findByText("Minggu 1");
    expect(screen.getByText(/6 materi/).textContent).toContain("6 materi");
  });

  it("an empty syllabus says so", async () => {
    stubFetch({ sections: [] });
    renderTab();

    await screen.findByText(/Belum ada materi/);
  });

  it("choosing a lesson shows its body", async () => {
    stubFetch();
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Pengenalan/ }));

    await screen.findByText("mulai dari sini");
  });

  /**
   * The seam with Phase 4a: the lock is the DOCUMENT's, reported by the
   * server. This tab renders it and adds no gate of its own.
   */
  it("offers a download for an open attachment", async () => {
    const calls = stubFetch({
      sections: [
        aSection({
          lessons: [
            {
              id: "l1",
              title: "Modul",
              body: "baca",
              position: 1,
              attachment: {
                documentId: "d1",
                name: "Modul.pdf",
                byteSize: 2_516_582,
                membersOnly: false,
              },
            },
          ],
        }),
      ],
    });
    setUserSession("token-123", USER);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Modul$/ }));
    const download = await screen.findByRole("button", { name: /Unduh Modul\.pdf/ });
    // The size is rendered with the Indonesian comma, via formatBytes.
    expect(download.textContent).toContain("2,4 MB");

    fireEvent.click(download);
    await waitFor(() => expect(calls.some((call) => call.includes("/documents/d1"))).toBe(true));
  });

  it("shows a locked attachment as a pointer, never a download button", async () => {
    stubFetch({
      sections: [
        aSection({
          lessons: [
            {
              id: "l1",
              title: "Khusus",
              body: "baca",
              position: 1,
              attachment: {
                documentId: "d1",
                name: "Rahasia.pdf",
                byteSize: 100,
                membersOnly: true,
              },
            },
          ],
        }),
      ],
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Khusus/ }));

    // Never a control for an action the server would 404.
    await screen.findByText(/khusus anggota berbayar/i);
    expect(screen.queryAllByRole("button", { name: /Unduh/ }).length).toBe(0);
  });

  it("a lesson with no attachment offers nothing to download", async () => {
    stubFetch();
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Pengenalan/ }));

    await screen.findByText("mulai dari sini");
    expect(screen.queryAllByRole("button", { name: /Unduh/ }).length).toBe(0);
  });

  it("hides every authoring control from a non-owner", async () => {
    stubFetch();
    renderTab(false);

    await screen.findByText("Minggu 1");
    expect(screen.queryAllByLabelText("Bagian baru").length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  it("the owner adds a section and the syllabus refreshes", async () => {
    const calls = stubFetch();
    renderTab(true);
    await screen.findByText("Minggu 1");

    fireEvent.change(screen.getByLabelText("Bagian baru"), { target: { value: "Minggu 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah bagian" }));

    await waitFor(() => expect(calls.some((call) => call.includes("POST"))).toBe(true));
    expect(calls.filter((call) => call.startsWith("GET")).length).toBeGreaterThan(1);
  });

  /** Deleting a whole section takes its lessons, so it asks first. */
  it("deleting a section confirms, and a cancel sends nothing", async () => {
    window.confirm = mock(() => false) as unknown as typeof window.confirm;
    const calls = stubFetch();
    renderTab(true);
    await screen.findByText("Minggu 1");

    fireEvent.click(screen.getByRole("button", { name: "Hapus bagian" }));

    expect(calls.filter((call) => call.startsWith("DELETE")).length).toBe(0);
  });

  it("a failed load shows an error, not an empty syllabus", async () => {
    stubFetch({ status: 500 });
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada materi/).length).toBe(0);
  });
});
