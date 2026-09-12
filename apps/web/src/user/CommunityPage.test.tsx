import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
  tags: [],
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

/** Answers the detail, roster and feed reads; `overrides` patches the detail. */
function stubFetch(overrides: Partial<typeof DETAIL> = {}, calls: string[] = []) {
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/members")) return jsonResponse(MEMBERS);
    // The Diskusi tab's CommunityFeed reads this — an empty page keeps the
    // default view quiet in the banner/join tests below (Phase 2).
    if (url.includes("/posts")) return jsonResponse({ posts: [], nextCursor: null });
    // Phase 3's Kegiatan tab. An empty month keeps the tab quiet in the
    // banner/join tests, exactly as the empty feed page above does.
    if (url.includes("/events")) return jsonResponse({ events: [] });
    // Phase 4a's Dokumen tab. An empty library keeps the tab quiet in the
    // banner/join tests, as the empty feed and empty month above do.
    if (url.includes("/documents")) return jsonResponse({ documents: [] });
    // Phase 5's Keanggotaan tab. An empty offer keeps the tab quiet in the
    // banner/join tests, as the empty feed, month and library above do.
    if (url.includes("/tiers")) return jsonResponse({ tiers: [] });
    // Phase 4b's Materi tab. An empty syllabus keeps the tab quiet in the
    // banner/join tests, as every other empty payload above does.
    if (url.includes("/syllabus")) return jsonResponse({ sections: [] });
    // Phase 6's Statistik tab, owner-only.
    if (url.includes("/stats")) {
      return jsonResponse({
        totalRevenue: 0,
        memberCount: 4,
        newMembersThisMonth: 0,
        paymentSuccessRate: null,
        churnRate: null,
        revenueByMonth: [],
        tierDistribution: [],
        recentMembers: [],
      });
    }
    if (init?.method === "POST") return jsonResponse({ member: true });
    if (init?.method === "DELETE") return jsonResponse({ member: false });
    return jsonResponse({ ...DETAIL, ...overrides });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage(initialEntry = "/komunitas/kelas-desain") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/komunitas/:slug" element={<CommunityPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Renders the page beside a probe that prints the router's current search string. */
function renderPageWithSearch(initialEntry = "/komunitas/kelas-desain") {
  function Search() {
    return <span data-testid="search">{useLocation().search}</span>;
  }
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/komunitas/:slug"
          element={
            <>
              <CommunityPage />
              <Search />
            </>
          }
        />
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
    // roster moved under a tab in Phase 2 — Diskusi is the default, so this
    // renders at ?tab=anggota to still see it.
    renderPage("/komunitas/kelas-desain?tab=anggota");

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

/**
 * Task 8 — the tab bar Phase 1 cut. Two tabs, Jelajah's pattern: `.feed-tabs`
 * markup, `aria-current`, the tab in the URL as `?tab=`, and only the active
 * half mounted (the inactive one issues no request).
 */
describe("CommunityPage — the Diskusi / Kegiatan / Anggota tab bar", () => {
  it("has the six tabs, with Diskusi current by default, and reads no roster", async () => {
    const calls = stubFetch();
    renderPage();

    await screen.findByText("4 anggota · Skill Digital");
    const diskusi = screen.getByRole("button", { name: "Diskusi" });
    const kegiatan = screen.getByRole("button", { name: "Kegiatan" });
    const dokumen = screen.getByRole("button", { name: "Dokumen" });
    const keanggotaan = screen.getByRole("button", { name: "Keanggotaan" });
    const materi = screen.getByRole("button", { name: "Materi" });
    const anggota = screen.getByRole("button", { name: "Anggota" });
    expect(diskusi.getAttribute("aria-current")).toBe("true");
    expect(kegiatan.getAttribute("aria-current")).toBe("false");
    expect(dokumen.getAttribute("aria-current")).toBe("false");
    expect(keanggotaan.getAttribute("aria-current")).toBe("false");
    expect(materi.getAttribute("aria-current")).toBe("false");
    expect(anggota.getAttribute("aria-current")).toBe("false");
    // Symmetric with the tab tests below: only the active tab mounts, so the
    // default view reads neither the roster, nor the calendar, nor the library.
    expect(calls.some((call) => call.includes("/members"))).toBe(false);
    expect(calls.some((call) => call.includes("/events"))).toBe(false);
    expect(calls.some((call) => call.includes("/documents"))).toBe(false);
    expect(calls.some((call) => call.includes("/tiers"))).toBe(false);
    expect(calls.some((call) => call.includes("/syllabus"))).toBe(false);
  });

  it("shows the syllabus and not the feed at ?tab=materi", async () => {
    const calls = stubFetch();
    renderPage("/komunitas/kelas-desain?tab=materi");

    await screen.findByText(/Belum ada materi/);
    expect(screen.getByRole("button", { name: "Materi" }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(calls.some((call) => call.includes("/posts"))).toBe(false);
  });

  /**
   * ABSENT, not disabled — the rule Phase 1 set when it cut the tab bar
   * rather than render tabs with nothing behind them. The server refuses a
   * non-owner with 403 regardless; this is what stops it being offered.
   */
  it("hides the Statistik tab from everyone but the owner", async () => {
    stubFetch({ viewerIsOwner: false });
    renderPage();

    await screen.findByText("4 anggota · Skill Digital");
    expect(screen.queryAllByRole("button", { name: "Statistik" }).length).toBe(0);
  });

  it("shows the owner the Statistik tab, and its numbers at ?tab=statistik", async () => {
    stubFetch({ viewerIsOwner: true });
    renderPage("/komunitas/kelas-desain?tab=statistik");

    await screen.findByText("Pendapatan");
    expect(screen.getByRole("button", { name: "Statistik" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it("shows the membership offer and not the feed at ?tab=keanggotaan", async () => {
    const calls = stubFetch();
    renderPage("/komunitas/kelas-desain?tab=keanggotaan");

    await screen.findByText(/Belum ada tingkatan/);
    expect(screen.getByRole("button", { name: "Keanggotaan" }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(calls.some((call) => call.includes("/posts"))).toBe(false);
    expect(calls.some((call) => call.includes("/documents"))).toBe(false);
  });

  it("shows the library and not the feed at ?tab=dokumen", async () => {
    const calls = stubFetch();
    renderPage("/komunitas/kelas-desain?tab=dokumen");

    await screen.findByText(/Belum ada dokumen/);
    expect(screen.getByRole("button", { name: "Dokumen" }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(calls.some((call) => call.includes("/posts"))).toBe(false);
    expect(calls.some((call) => call.includes("/events"))).toBe(false);
  });

  it("shows the calendar and not the feed at ?tab=kegiatan", async () => {
    const calls = stubFetch();
    renderPage("/komunitas/kelas-desain?tab=kegiatan");

    await screen.findByText(/Belum ada kegiatan/);
    expect(screen.getByRole("button", { name: "Kegiatan" }).getAttribute("aria-current")).toBe(
      "true"
    );
    // Only the active half mounts — neither the feed nor the roster is read.
    expect(calls.some((call) => call.includes("/posts"))).toBe(false);
    expect(calls.some((call) => call.includes("/members"))).toBe(false);
  });

  it("an unknown ?tab= falls back to Diskusi rather than showing nothing", async () => {
    stubFetch();
    renderPage("/komunitas/kelas-desain?tab=entahlah");

    await screen.findByText("4 anggota · Skill Digital");
    expect(screen.getByRole("button", { name: "Diskusi" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it("shows the roster and not the feed at ?tab=anggota, and does not read the feed", async () => {
    const calls = stubFetch();
    renderPage("/komunitas/kelas-desain?tab=anggota");

    const rows = await screen.findAllByRole("link", { name: /Wildan|Rina/ });
    expect(rows.map((row) => row.getAttribute("href")).join(",")).toBe("/@wildan,/@rina");
    expect(screen.getByRole("button", { name: "Anggota" }).getAttribute("aria-current")).toBe("true");
    // Only the active half mounts — the feed endpoint is never hit.
    expect(calls.some((call) => call.includes("/posts"))).toBe(false);
    expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
  });

  it("puts the tab in the URL when Anggota is clicked", async () => {
    stubFetch();
    renderPageWithSearch();

    await screen.findByText("4 anggota · Skill Digital");
    fireEvent.click(screen.getByRole("button", { name: "Anggota" }));

    expect(screen.getByTestId("search").textContent).toBe("?tab=anggota");
    await screen.findAllByRole("link", { name: /Wildan|Rina/ });
  });
});
