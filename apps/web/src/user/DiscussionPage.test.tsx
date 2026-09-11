import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DiscussionPage from "./DiscussionPage";
import { setUserSession } from "./apiClient";

const USER = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const POST = {
  id: "post-1",
  body: "Bagaimana memulai desain?",
  createdAt: "2026-09-01T00:00:00.000Z",
  editedAt: null,
  media: [],
  author: { handle: "wildan", displayName: "Wildan" },
  membersOnly: false,
  lockedMediaCount: 0,
  type: "diskusi",
  commentCount: 0,
};

const COMMUNITY = {
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: "Belajar desain dari nol.",
  memberCount: 4,
  ownerHandle: "wildan",
  ownerDisplayName: "Wildan",
  viewerIsMember: true as boolean | null,
  viewerIsOwner: false,
  createdAt: "2026-02-01T00:00:00.000Z",
};

const COMMENTS = [
  {
    id: "c1",
    body: "Mulai dari sketsa tangan.",
    createdAt: "2026-09-02T00:00:00.000Z",
    author: { handle: "budi", displayName: "Budi" },
  },
];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

/**
 * Answers the three reads the page makes — the post, the community detail, and
 * the comment thread — plus the comment POST. `overrides` patches the community
 * detail; `postStatus` / `communityStatus` force a failure on either gate.
 */
function stubFetch(
  options: {
    overrides?: Partial<typeof COMMUNITY>;
    /** Phase 3: overrides on the POST the stub answers with, so an event test can vary it. */
    post?: Record<string, unknown>;
    postStatus?: number;
    communityStatus?: number;
    calls?: string[];
  } = {}
) {
  const calls = options.calls ?? [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/comments")) {
      if (init?.method === "POST") {
        return jsonResponse(
          {
            id: "c2",
            body: "Terima kasih, sangat membantu.",
            createdAt: "2026-09-03T00:00:00.000Z",
            author: { handle: "rina", displayName: "Rina" },
          },
          201
        );
      }
      return jsonResponse(COMMENTS);
    }
    if (url.includes("/communities/")) {
      if (options.communityStatus !== undefined && options.communityStatus !== 200) {
        return jsonResponse({ error: "boom" }, options.communityStatus);
      }
      return jsonResponse({ ...COMMUNITY, ...options.overrides });
    }
    // The post read.
    if (options.postStatus !== undefined && options.postStatus !== 200) {
      return jsonResponse({ error: "boom" }, options.postStatus);
    }
    return jsonResponse({ ...POST, ...options.post });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage(entry = "/komunitas/kelas-desain/diskusi/post-1") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/komunitas/:slug/diskusi/:postId" element={<DiscussionPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("DiscussionPage", () => {
  it("renders the post body and its author", async () => {
    stubFetch();
    renderPage();

    expect((await screen.findByText("Bagaimana memulai desain?")).textContent).toBe(
      "Bagaimana memulai desain?"
    );
    expect(screen.getByText("@wildan").textContent).toBe("@wildan");
  });

  it("renders the comment thread below the post", async () => {
    stubFetch();
    renderPage();

    await screen.findByText("Bagaimana memulai desain?");
    expect(screen.getByText("Mulai dari sketsa tangan.").textContent).toBe(
      "Mulai dari sketsa tangan."
    );
  });

  it("renders the shared not-found page for an unknown post id", async () => {
    stubFetch({ postStatus: 404 });
    renderPage();

    expect((await screen.findByText("Halaman tidak ditemukan")).textContent).toBe(
      "Halaman tidak ditemukan"
    );
  });

  it("renders the shared not-found page for an unknown community slug", async () => {
    stubFetch({ communityStatus: 404 });
    renderPage();

    expect((await screen.findByText("Halaman tidak ditemukan")).textContent).toBe(
      "Halaman tidak ditemukan"
    );
  });

  it("announces a failed load with copy of its own, never the server's", async () => {
    stubFetch({ postStatus: 500 });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Server sedang bermasalah. Coba lagi sebentar lagi.");
  });

  it("shows a submitted comment without a refetch", async () => {
    setUserSession("token-1", USER);
    const calls = stubFetch();
    renderPage();

    await screen.findByText("Bagaimana memulai desain?");

    fireEvent.change(screen.getByRole("textbox", { name: "Tulis komentar" }), {
      target: { value: "Terima kasih, sangat membantu." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    // The appended row joins the thread (queried by list structure, not by the
    // textarea that briefly held the same text).
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows[1]).toContain("Terima kasih, sangat membantu.");
    // The thread was read exactly once — the append is local, no reload.
    expect(calls.filter((call) => call === "GET /users/posts/post-1/comments").length).toBe(1);
  });
});

/** 15 September 2026, 16:00 WIB. */
const AN_EVENT = {
  title: "Trigonometri lanjutan",
  startsAt: "2026-09-15T09:00:00.000Z",
  endsAt: null,
  location: null,
};

function renderEventPage(entry = "/komunitas/kelas-desain/kegiatan/post-1") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/komunitas/:slug/kegiatan/:postId"
          element={<DiscussionPage variant="kegiatan" />}
        />
      </Routes>
    </MemoryRouter>
  );
}

/**
 * Phase 3 — the SAME component under `variant="kegiatan"`. A separate
 * `EventPage` would be a second copy of the two-read gate, the thread state
 * and the three early returns, kept in sync by hand.
 */
describe("DiscussionPage — the kegiatan variant", () => {
  it("renders the schedule, through the card that already knows how", async () => {
    stubFetch({ post: { type: "kegiatan", event: AN_EVENT } });
    renderEventPage();

    expect((await screen.findByText("Trigonometri lanjutan")).textContent).toBe(
      "Trigonometri lanjutan"
    );
    // WIB, not UTC.
    expect(screen.getByText(/16\.00 WIB/).textContent).toContain("16.00 WIB");
  });

  it("keeps the comment thread — an event is a post, so the thread is free", async () => {
    stubFetch({ post: { type: "kegiatan", event: AN_EVENT } });
    renderEventPage();

    expect((await screen.findByText("Mulai dari sketsa tangan.")).textContent).toBe(
      "Mulai dari sketsa tangan."
    );
    expect(screen.getByText("1 komentar").textContent).toBe("1 komentar");
  });

  /**
   * A discussion id typed into an event URL. The page cannot render a
   * schedule it has no date for, and redirecting to the discussion would make
   * two URLs for one post.
   */
  it("is NotFound for a post that carries no event", async () => {
    stubFetch({ post: { type: "diskusi", event: null } });
    renderEventPage();

    await screen.findByText(/Halaman tidak ditemukan/i);
    expect(screen.queryAllByText("Bagaimana memulai desain?").length).toBe(0);
  });

  it("is still NotFound for an unknown post id", async () => {
    stubFetch({ postStatus: 404 });
    renderEventPage();

    await screen.findByText(/Halaman tidak ditemukan/i);
  });

  /**
   * The other direction, and the one that protects every shipped page: the
   * diskusi variant must NOT start 404ing posts that have no event.
   */
  it("the diskusi variant is unaffected by a post with no event", async () => {
    stubFetch({ post: { type: "diskusi", event: null } });
    renderPage();

    expect((await screen.findByText("Bagaimana memulai desain?")).textContent).toBe(
      "Bagaimana memulai desain?"
    );
  });
});
