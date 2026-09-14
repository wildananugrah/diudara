import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import CoBuilderModal from "./CoBuilderModal";
import { setUserSession } from "./apiClient";

const USER = { handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
  setUserSession("token-1", USER);
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

/** Prints the router's current path, so a test can see where "create" landed. */
function Probe() {
  const location = useLocation();
  return <p>path:{location.pathname}</p>;
}

function renderModal(onClose: () => void = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/discover"]}>
      <Routes>
        <Route path="/discover" element={<CoBuilderModal onClose={onClose} />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>
  );
}

function sendMessage(text: string) {
  fireEvent.change(screen.getByLabelText("Pesan"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Kirim" }));
}

describe("CoBuilderModal", () => {
  it("greets the user and offers a composer with nothing sent yet", () => {
    const fetchMock = mock(async () => jsonResponse({ reply: "unused", draft: null }));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderModal();

    expect(screen.getByText(/Ceritakan komunitas yang ingin kamu buat/)).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("posts the whole transcript and appends the assistant's reply", async () => {
    const fetchMock = mock(async (_url: string, _options?: RequestInit) =>
      jsonResponse({ reply: "Menarik! Kategorinya apa?", draft: null })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    renderModal();

    sendMessage("Kelas desain UI/UX untuk pemula");

    expect(await screen.findByText("Menarik! Kategorinya apa?")).toBeTruthy();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/communities/co-builder/chat");
    const body = JSON.parse(options!.body as string);
    expect(body.messages).toEqual([
      { role: "assistant", content: expect.stringContaining("Ceritakan komunitas") },
      { role: "user", content: "Kelas desain UI/UX untuk pemula" },
    ]);
    // No draft yet — the form must not appear.
    expect(screen.queryByRole("button", { name: "Buat komunitas" }) === null).toBe(true);
  });

  it("shows an editable, pre-filled draft form once a turn proposes one", async () => {
    global.fetch = mock(async () =>
      jsonResponse({
        reply: "Ini drafnya.",
        draft: { name: "Kelas Desain UI/UX", category: "Skill Digital", description: "Untuk pemula", tags: ["desain"] },
      })
    ) as unknown as typeof fetch;
    renderModal();

    sendMessage("Kelas desain UI/UX untuk pemula");
    await screen.findByText("Ini drafnya.");

    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).value).toBe("Kelas Desain UI/UX");
    expect((screen.getByLabelText("Kategori") as HTMLSelectElement).value).toBe("Skill Digital");
    expect((screen.getByLabelText("Deskripsi") as HTMLTextAreaElement).value).toBe("Untuk pemula");
    expect((screen.getByLabelText("Tag") as HTMLInputElement).value).toBe("desain");
  });

  it("creates the community from the draft and navigates to its page", async () => {
    const fetchMock = mock(async (url: string, _options?: RequestInit) => {
      if (url === "/communities/co-builder/chat") {
        return jsonResponse({
          reply: "Ini drafnya.",
          draft: { name: "Kelas Desain UI/UX", category: "Skill Digital" },
        });
      }
      return jsonResponse({ slug: "kelas-desain-ui-ux", name: "Kelas Desain UI/UX" }, 201);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onClose = () => {};
    renderModal(onClose);

    sendMessage("Kelas desain UI/UX untuk pemula");
    await screen.findByText("Ini drafnya.");
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    expect(await screen.findByText("path:/komunitas/kelas-desain-ui-ux")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/communities")!;
    const body = JSON.parse(createCall[1]!.body as string);
    expect(body).toEqual({ name: "Kelas Desain UI/UX", category: "Skill Digital" });
  });

  it("shows a Bahasa error and a manual-form fallback link when the chat turn fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "service unavailable" }, 503)) as unknown as typeof fetch;
    renderModal();

    sendMessage("Kelas desain UI/UX untuk pemula");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Buka formulir manual" }).getAttribute("href")).toBe(
      "/komunitas/baru"
    );
    expect(alert.textContent).not.toContain("service unavailable");
  });

  it("keeps the draft form filled and shows a Bahasa error when creating fails", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url === "/communities/co-builder/chat") {
        return jsonResponse({ reply: "Ini drafnya.", draft: { name: "Kelas Desain", category: "Skill Digital" } });
      }
      return jsonResponse({ error: "nama ini sudah dipakai komunitas lain" }, 409);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderModal();

    sendMessage("Kelas desain");
    await screen.findByText("Ini drafnya.");
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Nama itu sudah dipakai atau tidak bisa digunakan. Coba nama lain.");
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).value).toBe("Kelas Desain");
  });

  it("calls onClose when the close button is clicked", () => {
    global.fetch = mock(async () => jsonResponse({ reply: "x", draft: null })) as unknown as typeof fetch;
    let closed = false;
    renderModal(() => {
      closed = true;
    });

    fireEvent.click(screen.getByRole("button", { name: "Tutup" }));

    expect(closed).toBe(true);
  });
});
