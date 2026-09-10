import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CommunityPage from "./CommunityPage";
import { setUserSession } from "./apiClient";

const USER = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DETAIL = {
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: "Belajar desain dari nol.",
  memberCount: 4,
  ownerHandle: "wildan",
  ownerDisplayName: "Wildan",
  viewerIsMember: null as boolean | null,
  viewerIsOwner: false,
  createdAt: "2026-02-01T00:00:00.000Z",
};

const MEMBERS = {
  members: [
    {
      handle: "wildan",
      displayName: "Wildan",
      bio: null,
      role: "owner",
      joinedAt: "2026-02-01T00:00:00.000Z",
    },
    {
      handle: "rina",
      displayName: "Rina",
      bio: null,
      role: "member",
      joinedAt: "2026-02-02T00:00:00.000Z",
    },
  ],
  capped: false,
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

/** Answers the detail and roster reads; `overrides` patches the detail. */
function stubFetch(overrides: Partial<typeof DETAIL> = {}, calls: string[] = []) {
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/members")) return jsonResponse(MEMBERS);
    if (init?.method === "POST") return jsonResponse({ member: true });
    if (init?.method === "DELETE") return jsonResponse({ member: false });
    return jsonResponse({ ...DETAIL, ...overrides });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/komunitas/kelas-desain"]}>
      <Routes>
        <Route path="/komunitas/:slug" element={<CommunityPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("CommunityPage", () => {
  it("banners the name with its member count and category", async () => {
    stubFetch();
    renderPage();

    expect((await screen.findAllByText("Kelas Desain")).length).toBeGreaterThan(0);
    expect(screen.getByText("4 anggota · Skill Digital").textContent).toBe(
      "4 anggota · Skill Digital"
    );
  });

  it("offers a signed-out visitor a link to sign in, never a button that cannot work", async () => {
    stubFetch({ viewerIsMember: null });
    renderPage();

    const link = await screen.findByRole("link", { name: "Masuk untuk gabung" });
    expect(link.getAttribute("href")).toBe("/masuk");
    expect(screen.queryAllByRole("button", { name: "Gabung" }).length).toBe(0);
  });

  it("lets a signed-in non-member join, and the control becomes Keluar", async () => {
    setUserSession("token-1", USER);
    stubFetch({ viewerIsMember: false });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Gabung" }));

    expect(await screen.findByRole("button", { name: "Keluar" })).toBeTruthy();
  });

  it("lets a member leave, and the control becomes Gabung", async () => {
    setUserSession("token-1", USER);
    stubFetch({ viewerIsMember: true });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Keluar" }));

    expect(await screen.findByRole("button", { name: "Gabung" })).toBeTruthy();
  });

  it("shows the owner NO join or leave control at all — not a disabled one", async () => {
    setUserSession("token-1", { ...USER, handle: "wildan", displayName: "Wildan" });
    stubFetch({ viewerIsMember: true, viewerIsOwner: true });
    renderPage();

    await screen.findByText("4 anggota · Skill Digital");

    expect(screen.queryAllByRole("button", { name: "Keluar" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Gabung" }).length).toBe(0);
    expect(screen.queryAllByRole("link", { name: "Masuk untuk gabung" }).length).toBe(0);
  });

  it("lists the roster with the owner first", async () => {
    stubFetch();
    renderPage();

    const rows = await screen.findAllByRole("link", { name: /Wildan|Rina/ });
    expect(rows.map((row) => row.getAttribute("href")).join(",")).toBe("/@wildan,/@rina");
  });

  it("renders the shared not-found page for a slug nobody holds", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "community not found" }, 404)
    ) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Halaman tidak ditemukan")).toBeTruthy();
  });

  it("announces a failed load with copy of its own, never the server's", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "boom" }, 500)
    ) as unknown as typeof fetch;
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
  });
});
