import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { COMMUNITY_CATEGORIES } from "@diudara/shared";
import CommunityCreatePage from "./CommunityCreatePage";
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
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

/** Prints the router's current path, so a test can see where a submit landed. */
function Probe() {
  const location = useLocation();
  return <p>path:{location.pathname}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/komunitas/baru"]}>
      <Routes>
        <Route path="/komunitas/baru" element={<CommunityCreatePage />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>
  );
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Nama komunitas"), {
    target: { value: "Kelas Desain" },
  });
  fireEvent.change(screen.getByLabelText("Kategori"), {
    target: { value: "Skill Digital" },
  });
}

describe("CommunityCreatePage", () => {
  it("asks for a name, a category and a description", () => {
    setUserSession("token-1", USER);
    renderPage();

    expect(screen.getByLabelText("Nama komunitas")).toBeTruthy();
    expect(screen.getByLabelText("Kategori")).toBeTruthy();
    expect(screen.getByLabelText("Deskripsi")).toBeTruthy();
  });

  it("offers exactly the six categories, and no seventh", () => {
    setUserSession("token-1", USER);
    renderPage();

    const select = screen.getByLabelText("Kategori") as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value).filter((v) => v !== "");
    expect(values.join(" | ")).toBe(COMMUNITY_CATEGORIES.join(" | "));
  });

  it("navigates to the new community once it is created", async () => {
    setUserSession("token-1", USER);
    global.fetch = mock(async () =>
      jsonResponse({ slug: "kelas-desain", name: "Kelas Desain" }, 201)
    ) as unknown as typeof fetch;
    renderPage();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    expect(await screen.findByText("path:/komunitas/kelas-desain")).toBeTruthy();
  });

  it("splits and trims the tag field before sending it", async () => {
    setUserSession("token-1", USER);
    const fetchMock = mock(async (_url: string, _options?: RequestInit) =>
      jsonResponse({ slug: "kelas-desain", name: "Kelas Desain" }, 201)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    renderPage();

    fillForm();
    fireEvent.change(screen.getByLabelText("Tag"), {
      target: { value: "Desain, UI ,  , Belajar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    await screen.findByText("path:/komunitas/kelas-desain");
    const [, options] = fetchMock.mock.calls.find((call) => call[0] === "/communities")!;
    const body = JSON.parse(options!.body as string);
    expect(body.tags).toEqual(["Desain", "UI", "Belajar"]);
  });

  it("omits tags entirely when the field is left blank", async () => {
    setUserSession("token-1", USER);
    const fetchMock = mock(async (_url: string, _options?: RequestInit) =>
      jsonResponse({ slug: "kelas-desain", name: "Kelas Desain" }, 201)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    renderPage();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    await screen.findByText("path:/komunitas/kelas-desain");
    const [, options] = fetchMock.mock.calls.find((call) => call[0] === "/communities")!;
    const body = JSON.parse(options!.body as string);
    expect(body.tags).toBeUndefined();
  });

  it("keeps what the user typed when the name is already taken", async () => {
    setUserSession("token-1", USER);
    global.fetch = mock(async () =>
      jsonResponse({ error: "nama ini sudah dipakai komunitas lain" }, 409)
    ) as unknown as typeof fetch;
    renderPage();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Buat komunitas" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Nama itu sudah dipakai atau tidak bisa digunakan. Coba nama lain."
    );
    // The whole point: the form is still filled in, so the fix is one edit
    // rather than retyping everything.
    expect((screen.getByLabelText("Nama komunitas") as HTMLInputElement).value).toBe(
      "Kelas Desain"
    );
    expect((screen.getByLabelText("Kategori") as HTMLSelectElement).value).toBe("Skill Digital");
  });

  it("sends a signed-out visitor to sign in rather than showing them the form", async () => {
    renderPage();

    expect(await screen.findByText("path:/masuk")).toBeTruthy();
    expect(screen.queryAllByLabelText("Nama komunitas").length).toBe(0);
  });
});
