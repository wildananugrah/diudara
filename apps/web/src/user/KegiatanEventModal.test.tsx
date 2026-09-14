import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import KegiatanEventModal from "./KegiatanEventModal";
import { setUserSession } from "./apiClient";

/**
 * `KegiatanEventModal` — the Kegiatan tab's own add/view/edit/delete modal.
 * `KegiatanTab.test.tsx` covers the INTEGRATION (a click opens this, a save
 * folds back into the calendar); this file covers what that one does not:
 * validation, the detail read's own loading/error states, edit pre-fill, and
 * the delete confirmation's cancel/error paths.
 *
 * **No happy-dom node ever reaches a serialising matcher** — see
 * `no-hanging-dom-assertions.test.ts`.
 */

const AUTHOR = { handle: "pakandi", displayName: "Pak Andi" };

function aPostView(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    body: "kelas tatap muka daring",
    createdAt: "2026-09-15T00:00:00.000Z",
    editedAt: null,
    author: AUTHOR,
    media: [],
    membersOnly: false,
    lockedMediaCount: 0,
    type: "kegiatan",
    commentCount: 0,
    event: {
      title: "Trigonometri lanjutan",
      startsAt: "2026-09-15T09:00:00.000Z",
      endsAt: "2026-09-15T11:00:00.000Z",
      location: "Online via Zoom",
    },
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

function noop() {}

describe("KegiatanEventModal — create mode", () => {
  it("seeds the date field from the clicked day and leaves everything else blank", () => {
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "create", date: "2026-09-20" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    expect((screen.getByLabelText("Tanggal") as HTMLInputElement).value).toBe("2026-09-20");
    expect((screen.getByLabelText("Judul kegiatan") as HTMLInputElement).value).toBe("");
  });

  it("disables the submit button until a title, date and start time are all present", () => {
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "create", date: "2026-09-20" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    const submit = screen.getByRole("button", { name: "Buat kegiatan" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Sesi baru" } });
    fireEvent.change(screen.getByLabelText("Waktu mulai"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Deskripsi"), { target: { value: "deskripsi" } });

    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("an end time before the start time keeps submit disabled", () => {
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "create", date: "2026-09-20" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Sesi baru" } });
    fireEvent.change(screen.getByLabelText("Waktu mulai"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Waktu selesai"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Deskripsi"), { target: { value: "deskripsi" } });

    expect((screen.getByRole("button", { name: "Buat kegiatan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits the full draft and reports the created event, then closes", async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined });
      return jsonResponse(aPostView({ body: "deskripsi", event: { title: "Sesi baru", startsAt: "2026-09-20T02:00:00.000Z", endsAt: null, location: null } }), 201);
    }) as unknown as typeof fetch;

    let created: unknown = null;
    let closed = false;
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "create", date: "2026-09-20" }}
        onClose={() => {
          closed = true;
        }}
        onCreated={(event) => {
          created = event;
        }}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Sesi baru" } });
    fireEvent.change(screen.getByLabelText("Waktu mulai"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Deskripsi"), { target: { value: "deskripsi" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat kegiatan" }));

    await waitFor(() => expect(closed).toBe(true));
    expect(calls).toEqual([
      {
        url: "/communities/kelas-fisika/posts",
        body: { body: "deskripsi", type: "kegiatan", event: { title: "Sesi baru", startsAt: "2026-09-20T02:00:00.000Z" } },
      },
    ]);
    expect((created as { postId: string }).postId).toBe("post-1");
  });

  it("shows an alert and stays open when the create request fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "create", date: "2026-09-20" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Sesi baru" } });
    fireEvent.change(screen.getByLabelText("Waktu mulai"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Deskripsi"), { target: { value: "deskripsi" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat kegiatan" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    await screen.findByRole("dialog");
  });
});

describe("KegiatanEventModal — detail mode", () => {
  it("shows a loading state, then the event's own information", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    expect(screen.getByText("Memuat...").textContent).toBe("Memuat...");
    await screen.findByText("Trigonometri lanjutan");
    expect(screen.getByText("kelas tatap muka daring").textContent).toBe("kelas tatap muka daring");
    expect(screen.getByText(/Online via Zoom/).textContent).toContain("Online via Zoom");
  });

  it("shows an alert instead of the detail when the read fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
  });

  it("links to the full discussion page", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    const link = (await screen.findByRole("link", { name: /Lihat diskusi/ })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/komunitas/kelas-fisika/kegiatan/post-1");
  });

  it("hides Edit and Hapus from a viewer who is not the author", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;
    setUserSession("token-1", { handle: "rina", displayName: "Rina", email: "rina@example.com" });

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    expect(screen.queryAllByRole("button", { name: "Edit" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Hapus" }).length).toBe(0);
  });

  it("Edit pre-fills the form from the post's own schedule, including endTime and location", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Judul kegiatan") as HTMLInputElement).value).toBe("Trigonometri lanjutan");
    expect((screen.getByLabelText("Tanggal") as HTMLInputElement).value).toBe("2026-09-15");
    expect((screen.getByLabelText("Waktu mulai") as HTMLInputElement).value).toBe("16:00");
    expect((screen.getByLabelText("Waktu selesai") as HTMLInputElement).value).toBe("18:00");
    expect((screen.getByLabelText("Lokasi") as HTMLInputElement).value).toBe("Online via Zoom");
    expect((screen.getByLabelText("Deskripsi") as HTMLTextAreaElement).value).toBe("kelas tatap muka daring");
  });

  it("Batal from the edit form returns to the read-only view without saving", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(screen.queryAllByLabelText("Judul kegiatan").length).toBe(0);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("saves the edit and reports the updated event, then closes", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined });
      if (method === "PATCH") {
        return jsonResponse(
          aPostView({
            body: "kelas tatap muka daring",
            event: { title: "Jadwal baru", startsAt: "2026-09-20T02:00:00.000Z", endsAt: null, location: null },
          })
        );
      }
      return jsonResponse(aPostView());
    }) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    let updated: unknown = null;
    let closed = false;
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={() => {
          closed = true;
        }}
        onCreated={noop}
        onUpdated={(event) => {
          updated = event;
        }}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Judul kegiatan"), { target: { value: "Jadwal baru" } });
    fireEvent.change(screen.getByLabelText("Waktu selesai"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Lokasi"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(closed).toBe(true));
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect((patchCall?.body as { event: { title: string } }).event.title).toBe("Jadwal baru");
    expect((updated as { title: string }).title).toBe("Jadwal baru");
  });

  it("Batal on the delete confirmation keeps the event", async () => {
    global.fetch = mock(async () => jsonResponse(aPostView())) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));

    expect(screen.queryAllByText("Yakin ingin menghapus kegiatan ini?").length).toBe(0);
    expect(screen.getByText("Trigonometri lanjutan")).toBeTruthy();
  });

  it("confirming delete reports the deleted postId and closes", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "DELETE") return jsonResponse({ deleted: true });
      return jsonResponse(aPostView());
    }) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    // An object, not a bare `let string | null` — TS narrows a bare one to
    // its literal `null` initial value at the read site below, since the
    // reassignment only happens inside a callback its control-flow analysis
    // cannot see as having run.
    const result: { deletedId: string | null } = { deletedId: null };
    let closed = false;
    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={() => {
          closed = true;
        }}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={(id) => {
          result.deletedId = id;
        }}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    await waitFor(() => expect(closed).toBe(true));
    expect(result.deletedId).toBe("post-1");
    expect(calls).toContain("DELETE /users/posts/post-1");
  });

  it("a failed delete shows an alert and leaves the modal open", async () => {
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ error: "boom" }, 500);
      return jsonResponse(aPostView());
    }) as unknown as typeof fetch;
    setUserSession("token-1", { handle: AUTHOR.handle, displayName: AUTHOR.displayName, email: "pak@example.com" });

    render(
      <KegiatanEventModal
        slug="kelas-fisika"
        target={{ mode: "detail", postId: "post-1" }}
        onClose={noop}
        onCreated={noop}
        onUpdated={noop}
        onDeleted={noop}
      />
    );

    await screen.findByText("Trigonometri lanjutan");
    fireEvent.click(screen.getByRole("button", { name: "Hapus" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, hapus" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
    await screen.findByRole("dialog");
  });
});
