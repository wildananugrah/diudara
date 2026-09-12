import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DiscoverPage from "./DiscoverPage";
import type { CommunityListRow } from "./apiClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDiscover(entry = "/discover") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <DiscoverPage />
    </MemoryRouter>
  );
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

describe("DiscoverPage", () => {
  const COMMUNITIES: CommunityListRow[] = [
    {
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
      memberCount: 3,
      tags: [],
      trending: false,
      price: null,
      live: null,
    },
    {
      slug: "bimbel-sbmptn",
      name: "Bimbel SBMPTN",
      category: "Bimbel & Ujian",
      description: null,
      memberCount: 9,
      tags: [],
      trending: false,
      price: null,
      live: null,
    },
  ];

  const POPULAR_TAGS = ["desain", "bisnis"];

  function stubCommunityFetch(
    calls: string[] = [],
    options: { communities?: CommunityListRow[]; popularTags?: string[] } = {}
  ) {
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      const all = options.communities ?? COMMUNITIES;
      const wanted =
        url.includes("q=bimbel") || url.includes("Bimbel")
          ? all.filter((c) => c.slug === "bimbel-sbmptn")
          : all;
      return jsonResponse({
        communities: wanted,
        popularTags: options.popularTags ?? POPULAR_TAGS,
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  it("renders a card per community from the API", async () => {
    stubCommunityFetch();
    renderDiscover();

    expect(await screen.findByRole("link", { name: "Kelas Desain" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Bimbel SBMPTN" })).toBeTruthy();
    expect(screen.getByText("3 anggota").textContent).toBe("3 anggota");
  });

  it("searches on submit, not on every keystroke", async () => {
    const calls = stubCommunityFetch();
    renderDiscover();
    await screen.findByRole("link", { name: "Kelas Desain" });

    const before = calls.length;
    fireEvent.change(screen.getByLabelText("Cari komunitas"), { target: { value: "bimbel" } });
    // Typing alone must not have gone to the network.
    expect(calls.length).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Cari Komunitas" }));
    await waitFor(() => {
      expect(calls.some((url) => url.includes("q=bimbel"))).toBe(true);
    });
  });

  it("filters by category when a chip is tapped", async () => {
    const calls = stubCommunityFetch();
    renderDiscover();
    await screen.findByRole("link", { name: "Kelas Desain" });

    fireEvent.click(screen.getByRole("button", { name: "Bimbel & Ujian" }));

    await waitFor(() => {
      expect(calls.some((url) => url.includes("category=Bimbel"))).toBe(true);
    });
  });

  it("shows an error message if the request fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "server error" }, 500)) as unknown as typeof fetch;

    renderDiscover();

    await waitFor(() => {
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });
  });

  it("renders the site's popular tags in the sidebar", async () => {
    stubCommunityFetch();
    renderDiscover();

    expect(await screen.findByText("#desain")).toBeTruthy();
    expect(screen.getByText("#bisnis")).toBeTruthy();
  });

  it("links the 'own a community' CTA to the real creation flow", async () => {
    stubCommunityFetch();
    renderDiscover();
    await screen.findByRole("link", { name: "Kelas Desain" });

    const cta = screen.getByRole("link", { name: /Mulai sekarang/ });
    expect(cta.getAttribute("href")).toBe("/komunitas/baru");
  });

  it("shows no live-now strip when nothing is live", async () => {
    stubCommunityFetch();
    renderDiscover();
    await screen.findByRole("link", { name: "Kelas Desain" });

    expect(screen.queryAllByText("Sedang berlangsung").length).toBe(0);
  });

  describe("the live-now strip", () => {
    const LIVE_COMMUNITIES: CommunityListRow[] = [
      {
        ...COMMUNITIES[0]!,
        live: { streamId: "stream-1", viewerCount: 128 },
      },
      COMMUNITIES[1]!,
    ];

    it("shows only the communities currently live, with their viewer count", async () => {
      stubCommunityFetch([], { communities: LIVE_COMMUNITIES });
      renderDiscover();

      await screen.findByText("Sedang berlangsung");
      expect(screen.getByText("128 nonton")).toBeTruthy();
      // Bimbel SBMPTN is not live — it must appear in the grid below, not here.
      const liveStrip = screen.getByText("Sedang berlangsung").closest("section")!;
      expect(liveStrip.textContent).toContain("Kelas Desain");
      expect(liveStrip.textContent).not.toContain("Bimbel SBMPTN");
    });

    it("links a live card to its live room", async () => {
      stubCommunityFetch([], { communities: LIVE_COMMUNITIES });
      renderDiscover();

      await screen.findByText("Sedang berlangsung");
      const liveStrip = screen.getByText("Sedang berlangsung").closest("section")!;
      const link = within(liveStrip).getByRole("link", { name: /Kelas Desain/ });
      expect(link.getAttribute("href")).toBe("/siaran/stream-1");
    });
  });
});
