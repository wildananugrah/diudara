import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPanel from "./ChatPanel";
import { ChatProvider, useChatContext } from "./ChatContext";
import { setUserSession, type ConversationRow, type DirectMessageRow } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`). Everything below asserts on strings,
 * numbers or booleans pulled out of a node, never on the node itself.
 *
 * The dock renders the roster and any number of chat windows AT THE SAME
 * TIME, so a display name can appear two or three times on screen at once.
 * Every query here therefore goes through an unambiguous accessible name
 * (`Buka/Kecilkan/Tutup percakapan dengan ...`) rather than `findByText`,
 * which the single-sheet panel could get away with and this one cannot.
 */

const NOW = new Date("2026-09-12T12:00:00.000Z");
const ME = { handle: "rina", displayName: "Rina", email: "rina@example.com" };

function aConversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "c1",
    other: { handle: "wildan", displayName: "Wildan" },
    lastMessageBody: "halo kak",
    lastMessageAt: "2026-09-12T11:00:00.000Z",
    unreadCount: 0,
    ...overrides,
  };
}

function aMessage(overrides: Partial<DirectMessageRow> = {}): DirectMessageRow {
  return {
    id: "m1",
    senderHandle: "wildan",
    body: "halo kak",
    createdAt: "2026-09-12T11:00:00.000Z",
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  localStorage.clear();
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  options: { conversations?: ConversationRow[]; messages?: DirectMessageRow[] } = {}
): string[] {
  const calls: string[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/read")) return jsonResponse({ read: true });
    if (url.includes("/messages") && init?.method === "POST") {
      return jsonResponse(aMessage({ id: "m-new", senderHandle: "rina", body: "terkirim" }), 201);
    }
    if (url.includes("/messages")) {
      return jsonResponse({ messages: options.messages ?? [aMessage()] });
    }
    return jsonResponse({ conversations: options.conversations ?? [aConversation()] });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPanel() {
  return render(<ChatPanel now={NOW} />);
}

/** Expands the roster and waits for the first conversation row to land. */
async function openRoster(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /^Pesan/ }));
}

/** Stands in for the Anggota roster's "message this member" button. */
function RequestButton({ handle }: { handle: string }) {
  const { requestConversation } = useChatContext();
  return (
    <button type="button" onClick={() => requestConversation(handle)}>
      Kirim pesan ke {handle}
    </button>
  );
}

function renderPanelWithRequester(handle: string) {
  return render(
    <ChatProvider>
      <RequestButton handle={handle} />
      <ChatPanel now={NOW} />
    </ChatProvider>
  );
}

describe("ChatPanel", () => {
  /**
   * The cost model of the whole phase, unchanged by the redesign: load scales
   * with what is OPEN, not with signed-in users. A collapsed roster with no
   * chat window must poll nothing at all.
   */
  it("polls nothing while collapsed with no window open", async () => {
    setUserSession("token-123", ME);
    const calls = stubFetch();
    renderPanel();

    await screen.findByRole("button", { name: "Pesan" });
    expect(calls.length).toBe(0);
  });

  it("renders nothing and asks nothing when signed out", async () => {
    const calls = stubFetch();
    renderPanel();

    await waitFor(() => expect(document.body.textContent).not.toContain("Pesan"));
    expect(calls.length).toBe(0);
  });

  it("expanding the roster lists conversations", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();

    await openRoster();

    await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" });
    expect(screen.getByText("halo kak").textContent).toBe("halo kak");
  });

  it("shows a total unread badge, and none at zero", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [aConversation({ unreadCount: 2 })] });
    renderPanel();

    await openRoster();

    await screen.findByRole("button", { name: "Pesan, 2 belum dibaca" });
  });

  it("a conversation with no messages says so rather than showing a blank preview", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [aConversation({ lastMessageBody: null })] });
    renderPanel();

    await openRoster();

    await screen.findByText("Belum ada pesan");
  });

  it("an empty list says so", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [] });
    renderPanel();

    await openRoster();

    await screen.findByText(/Belum ada percakapan/);
  });

  it("the search box filters the list", async () => {
    setUserSession("token-123", ME);
    stubFetch({
      conversations: [
        aConversation(),
        aConversation({ id: "c2", other: { handle: "budi", displayName: "Budi" } }),
      ],
    });
    renderPanel();
    await openRoster();
    await screen.findByRole("button", { name: "Buka percakapan dengan Budi" });

    fireEvent.change(screen.getByPlaceholderText("Cari pesan"), { target: { value: "bud" } });

    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Buka percakapan dengan Wildan" }).length).toBe(0)
    );
    expect(screen.queryAllByRole("button", { name: "Buka percakapan dengan Budi" }).length).toBe(1);
  });

  it("a search matching nobody says so", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" });

    fireEvent.change(screen.getByPlaceholderText("Cari pesan"), { target: { value: "zzz" } });

    await screen.findByText(/Tidak ada percakapan ditemukan/);
  });

  it("opening a conversation opens a window and marks it read", async () => {
    setUserSession("token-123", ME);
    const calls = stubFetch({ conversations: [aConversation({ unreadCount: 3 })] });
    renderPanel();
    await openRoster();

    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));

    await screen.findByPlaceholderText("Tulis pesan...");
    await screen.findByRole("button", { name: "Tutup percakapan dengan Wildan" });
    await waitFor(() => expect(calls.some((call) => call.includes("/read"))).toBe(true));
  });

  it("opening the same conversation twice keeps one window", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    const row = await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" });

    fireEvent.click(row);
    await screen.findByPlaceholderText("Tulis pesan...");
    fireEvent.click(row);

    await waitFor(() => expect(screen.getAllByPlaceholderText("Tulis pesan...").length).toBe(1));
  });

  /** LinkedIn caps the stack; so does the reference mockup, at three. */
  it("keeps at most three windows open", async () => {
    setUserSession("token-123", ME);
    stubFetch({
      conversations: [
        aConversation({ id: "c1", other: { handle: "a", displayName: "Ana" } }),
        aConversation({ id: "c2", other: { handle: "b", displayName: "Budi" } }),
        aConversation({ id: "c3", other: { handle: "c", displayName: "Cita" } }),
        aConversation({ id: "c4", other: { handle: "d", displayName: "Dewi" } }),
      ],
    });
    renderPanel();
    await openRoster();
    for (const name of ["Ana", "Budi", "Cita", "Dewi"]) {
      fireEvent.click(await screen.findByRole("button", { name: `Buka percakapan dengan ${name}` }));
    }

    await waitFor(() => expect(screen.getAllByPlaceholderText("Tulis pesan...").length).toBe(3));
    // The oldest is the one dropped, so the most recently opened stays.
    expect(screen.queryAllByRole("button", { name: "Tutup percakapan dengan Dewi" }).length).toBe(1);
    expect(screen.queryAllByRole("button", { name: "Tutup percakapan dengan Ana" }).length).toBe(0);
  });

  it("minimising a window hides its thread, restoring brings it back", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.click(screen.getByRole("button", { name: "Kecilkan percakapan dengan Wildan" }));

    await waitFor(() => expect(screen.queryAllByPlaceholderText("Tulis pesan...").length).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "Perbesar percakapan dengan Wildan" }));
    await screen.findByPlaceholderText("Tulis pesan...");
  });

  it("closing a window removes it", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.click(screen.getByRole("button", { name: "Tutup percakapan dengan Wildan" }));

    await waitFor(() => expect(screen.queryAllByPlaceholderText("Tulis pesan...").length).toBe(0));
  });

  it("sending appends immediately rather than waiting for a poll", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.change(screen.getByPlaceholderText("Tulis pesan..."), {
      target: { value: "terkirim" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    // Your own message must never appear to lag.
    await screen.findByText("terkirim");
  });

  /** A textarea that swallowed Enter would make every send a mouse trip. */
  it("Enter sends and Shift+Enter does not", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    const draft = await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.change(draft, { target: { value: "terkirim" } });
    fireEvent.keyDown(draft, { key: "Enter", shiftKey: true });
    expect((draft as HTMLTextAreaElement).value).toBe("terkirim");

    fireEvent.keyDown(draft, { key: "Enter" });
    await screen.findByText("terkirim");
    await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe(""));
  });

  it("will not send an empty message", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));

    const submit = await screen.findByRole("button", { name: "Kirim" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("the emoji picker appends to the draft", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    const draft = await screen.findByPlaceholderText("Tulis pesan...");
    fireEvent.change(draft, { target: { value: "oke" } });

    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    fireEvent.click(await screen.findByRole("button", { name: "👍" }));

    await waitFor(() => expect((draft as HTMLTextAreaElement).value).toBe("oke👍"));
  });

  /** A failed send must not eat what somebody typed. */
  it("a failed send says so and gives the text back", async () => {
    setUserSession("token-123", ME);
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      if (url.includes("/messages") && init?.method === "POST") {
        return jsonResponse({ error: "boom" }, 500);
      }
      if (url.includes("/read")) return jsonResponse({ read: true });
      if (url.includes("/messages")) return jsonResponse({ messages: [aMessage()] });
      return jsonResponse({ conversations: [aConversation()] });
    }) as unknown as typeof fetch;
    renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.change(screen.getByPlaceholderText("Tulis pesan..."), {
      target: { value: "jangan hilang" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Tulis pesan...") as HTMLTextAreaElement).value
      ).toBe("jangan hilang")
    );
  });

  it("tells your own messages from theirs", async () => {
    setUserSession("token-123", ME);
    stubFetch({
      messages: [
        aMessage({ id: "theirs", senderHandle: "wildan", body: "dari dia" }),
        aMessage({ id: "mine", senderHandle: "rina", body: "dari saya" }),
      ],
    });
    const { container } = renderPanel();
    await openRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Buka percakapan dengan Wildan" }));

    await screen.findByText("dari saya");
    // Alignment carries identity; `data-mine` is the hook it reads. Scoped to
    // the thread because the roster's own <li> rows are on screen too.
    const marks = Array.from(container.querySelectorAll(".chat-thread li")).map((item) =>
      item.getAttribute("data-mine")
    );
    expect(marks).toEqual([null, "true"]);
  });

  it("opens straight into a window requested through ChatContext", async () => {
    setUserSession("token-123", ME);
    const calls: string[] = [];
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/conversations") && init?.method === "POST") {
        return jsonResponse({ id: "c-new" }, 201);
      }
      if (url.includes("/read")) return jsonResponse({ read: true });
      if (url.includes("/messages")) return jsonResponse({ messages: [aMessage()] });
      return jsonResponse({ conversations: [aConversation({ id: "c-new" })] });
    }) as unknown as typeof fetch;
    renderPanelWithRequester("wildan");

    fireEvent.click(screen.getByRole("button", { name: "Kirim pesan ke wildan" }));

    await screen.findByPlaceholderText("Tulis pesan...");
    expect(
      calls.some((call) => call.startsWith("POST") && call.includes("/users/me/conversations"))
    ).toBe(true);
    // The thread loads from the window's own polling effect, one tick after
    // the window itself renders — hence `find`, not `get`.
    expect((await screen.findByText("halo kak")).textContent).toBe("halo kak");
  });

  it("does nothing when the panel has no ChatProvider above it", async () => {
    setUserSession("token-123", ME);
    const calls = stubFetch();
    renderPanel();

    await screen.findByRole("button", { name: "Pesan" });
    // The default (provider-less) context carries no request, so the dock
    // stays collapsed and reads nothing — exactly as before this change.
    expect(calls.length).toBe(0);
  });
});
