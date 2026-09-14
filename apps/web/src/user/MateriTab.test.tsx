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

  /**
   * The lesson form's own dropzone — a copy of `DokumenTab`'s. It uploads
   * eagerly (a real document, its own id) and only THEN attaches on submit,
   * so this asserts both halves: the upload lands, and the id it returns is
   * what `createLesson` is sent.
   */
  it("uploads a dropped attachment eagerly, then attaches it when the lesson is submitted", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      let body: unknown;
      if (init?.body instanceof FormData) {
        body = "form-data";
      } else if (typeof init?.body === "string") {
        body = JSON.parse(init.body);
      }
      calls.push({ url, method, body });
      if (url.includes("/documents") && method === "POST") {
        return jsonResponse(
          { id: "doc-1", name: "Modul.pdf", byteSize: 10, createdAt: "2026-01-01T00:00:00.000Z", uploader: { handle: "wildan", displayName: "Wildan" }, membersOnly: false, mayDownload: true },
          201
        );
      }
      if (url.includes("/lessons") && method === "POST") {
        return jsonResponse({ id: "l2", title: "Baru", body: "isi", position: 2, attachment: null }, 201);
      }
      return jsonResponse({ sections: [aSection()] });
    }) as unknown as typeof fetch;
    renderTab(true);
    await screen.findByText("Minggu 1");

    const dropzone = screen.getByLabelText("Lampiran (opsional)") as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "Modul.pdf", { type: "application/pdf" });
    fireEvent.change(dropzone, { target: { files: [file] } });

    await screen.findByText("Terlampir: Modul.pdf");

    fireEvent.change(screen.getByLabelText("Judul materi"), { target: { value: "Baru" } });
    fireEvent.change(screen.getByLabelText("Isi materi"), { target: { value: "isi" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah materi" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/lessons") && call.method === "POST")).toBe(
        true
      )
    );
    const lessonCall = calls.find((call) => call.url.includes("/lessons") && call.method === "POST");
    expect((lessonCall?.body as { documentId?: string }).documentId).toBe("doc-1");
  });

  it("highlights the attachment dropzone while dragging over it, and clears on drag leave", async () => {
    stubFetch();
    const { container } = renderTab(true);
    await screen.findByText("Minggu 1");

    const dropzone = container.querySelector(".dokumen-upload") as HTMLElement;
    fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain("dokumen-upload-dragging");

    fireEvent.dragLeave(dropzone, { relatedTarget: document.body });
    expect(dropzone.className).not.toContain("dokumen-upload-dragging");
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

  it("offers a quick link to the next lesson in the same section, and it navigates", async () => {
    stubFetch({
      sections: [
        aSection({
          lessonCount: 2,
          lessons: [
            { id: "l1", title: "Pengenalan", body: "mulai dari sini", position: 1, attachment: null },
            { id: "l2", title: "Lanjutan", body: "lanjut ke sini", position: 2, attachment: null },
          ],
        }),
      ],
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Pengenalan/ }));
    await screen.findByText("mulai dari sini");

    fireEvent.click(screen.getByRole("button", { name: /Materi selanjutnya/ }));

    await screen.findByText("lanjut ke sini");
  });

  it("the last lesson in a section offers no next-lesson link", async () => {
    stubFetch({
      sections: [
        aSection({
          lessonCount: 2,
          lessons: [
            { id: "l1", title: "Pengenalan", body: "mulai dari sini", position: 1, attachment: null },
            { id: "l2", title: "Lanjutan", body: "lanjut ke sini", position: 2, attachment: null },
          ],
        }),
      ],
    });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /Lanjutan/ }));
    await screen.findByText("lanjut ke sini");

    expect(screen.queryAllByRole("button", { name: /Materi selanjutnya/ }).length).toBe(0);
  });

  it("a failed load shows an error, not an empty syllabus", async () => {
    stubFetch({ status: 500 });
    renderTab();

    await screen.findByRole("alert");
    expect(screen.queryAllByText(/Belum ada materi/).length).toBe(0);
  });
});
