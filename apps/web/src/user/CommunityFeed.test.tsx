import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityFeed from "./CommunityFeed";
import { setUserSession, type PostView } from "./apiClient";

/**
 * `CommunityFeed` — the Diskusi tab (spec §"The web app"). Props are the three
 * values `CommunityPage` already holds from its `CommunityDetail` fetch; it
 * does not re-fetch the community.
 *
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`): negatives are `queryAllBy…().length`,
 * values are `.textContent` / `.getAttribute(...)` / arrays of strings.
 */

const USER = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makePost(id: string, body: string): PostView {
  return {
    id,
    body,
    createdAt: "2026-09-01T00:00:00.000Z",
    editedAt: null,
    media: [],
    author: { handle: "wildan", displayName: "Wildan" },
    membersOnly: false,
    lockedMediaCount: 0,
    type: "diskusi",
    commentCount: 0,
  };
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

/** Answers the feed read; a POST returns `created`. Records every call as "METHOD url". */
function stubFetch(
  opts: { posts?: PostView[]; feedStatus?: number; created?: PostView } = {}
): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") {
      return jsonResponse(opts.created ?? makePost("new", "baru"), 201);
    }
    if (opts.feedStatus !== undefined && opts.feedStatus >= 400) {
      return jsonResponse({ error: "boom" }, opts.feedStatus);
    }
    return jsonResponse({ posts: opts.posts ?? [], nextCursor: null });
  }) as unknown as typeof fetch;
  return calls;
}

function renderFeed(props: Partial<Parameters<typeof CommunityFeed>[0]> = {}) {
  return render(
    <MemoryRouter>
      <CommunityFeed slug="kelas-fisika" viewerIsMember={null} viewerIsOwner={false} {...props} />
    </MemoryRouter>
  );
}

describe("CommunityFeed", () => {
  it("gives a member the composer above the feed", async () => {
    setUserSession("t", USER);
    stubFetch();
    renderFeed({ viewerIsMember: true });

    expect(await screen.findByLabelText("Apa yang terjadi?")).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: "Masuk untuk gabung" }).length).toBe(0);
  });

  it("shows a non-member a guest note where the composer would be — no join button in the feed", async () => {
    setUserSession("t", USER);
    stubFetch();
    renderFeed({ viewerIsMember: false });

    // The join control itself lives in CommunityPage's banner (R12); the feed
    // only points at it.
    expect(await screen.findByText("Gabung untuk ikut diskusi.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Gabung" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Keluar" }).length).toBe(0);
    expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
  });

  it("shows a signed-out visitor a sign-in note where the composer would be — no button in the feed", async () => {
    stubFetch();
    renderFeed({ viewerIsMember: null });

    expect(await screen.findByText("Masuk untuk gabung.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Gabung" }).length).toBe(0);
    expect(screen.queryAllByLabelText("Apa yang terjadi?").length).toBe(0);
  });

  it("shows the owner a post-type selector; a plain member gets none", async () => {
    setUserSession("t", USER);
    stubFetch();
    const { rerender } = renderFeed({ viewerIsMember: true, viewerIsOwner: true });

    await screen.findByRole("combobox", { name: "Jenis kiriman" });
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Diskusi", "Pengumuman"]);

    rerender(
      <MemoryRouter>
        <CommunityFeed slug="kelas-fisika" viewerIsMember={true} viewerIsOwner={false} />
      </MemoryRouter>
    );
    expect(screen.queryAllByRole("combobox").length).toBe(0);
  });

  it("puts a just-submitted post at the top without re-reading the feed", async () => {
    setUserSession("t", USER);
    const calls = stubFetch({
      posts: [makePost("p1", "Kiriman lama")],
      created: makePost("p2", "Kiriman baru"),
    });
    renderFeed({ viewerIsMember: true });

    await screen.findByText("Kiriman lama");
    const feedReadsBefore = calls.filter(
      (call) => call === "GET /communities/kelas-fisika/posts"
    ).length;

    fireEvent.change(screen.getByLabelText("Apa yang terjadi?"), {
      target: { value: "Kiriman baru" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    expect(await screen.findByText("Kiriman baru")).toBeTruthy();
    const feedReadsAfter = calls.filter(
      (call) => call === "GET /communities/kelas-fisika/posts"
    ).length;
    expect(feedReadsAfter).toBe(feedReadsBefore);
    expect(calls.some((call) => call === "POST /communities/kelas-fisika/posts")).toBe(true);
  });

  it("announces a failed feed load with copy of its own, never the server's", async () => {
    stubFetch({ feedStatus: 500 });
    renderFeed({ viewerIsMember: null });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
  });

  it("shows the empty message when the community has no posts yet", async () => {
    stubFetch({ posts: [] });
    renderFeed({ viewerIsMember: null });

    expect(await screen.findByText("Belum ada diskusi di komunitas ini.")).toBeTruthy();
  });

  it("gives each feed card a comment-count link to that post's discussion (R11)", async () => {
    stubFetch({ posts: [{ ...makePost("p7", "Kiriman lama"), commentCount: 3 }] });
    renderFeed({ viewerIsMember: null });

    await screen.findByText("Kiriman lama");
    const link = screen.getByRole("link", { name: /3 komentar/ });
    // A STRING off the node, never the node itself.
    expect(link.getAttribute("href")).toBe("/komunitas/kelas-fisika/diskusi/p7");
  });
});
