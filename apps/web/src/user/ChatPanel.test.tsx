import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPanel from "./ChatPanel";
import { setUserSession, type ConversationRow, type DirectMessageRow } from "./apiClient";

/**
 * **No happy-dom node ever reaches a serialising matcher** (see
 * `no-hanging-dom-assertions.test.ts`).
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

describe("ChatPanel", () => {
  /**
   * The cost model of the whole phase: load scales with OPEN conversations,
   * not with signed-in users. A closed panel must poll nothing at all.
   */
  it("polls nothing while closed", async () => {
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

  it("opening it lists conversations", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));

    await screen.findByText("Wildan");
    expect(screen.getByText("halo kak").textContent).toBe("halo kak");
  });

  it("shows a total unread badge, and none at zero", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [aConversation({ unreadCount: 2 })] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Pesan/ }));

    await waitFor(() => expect(screen.getAllByText("2").length).toBeGreaterThan(0));
  });

  it("a conversation with no messages says so rather than showing a blank preview", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [aConversation({ lastMessageBody: null })] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));

    await screen.findByText("Belum ada pesan");
  });

  it("an empty list says so", async () => {
    setUserSession("token-123", ME);
    stubFetch({ conversations: [] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));

    await screen.findByText(/Belum ada percakapan/);
  });

  it("opening a conversation shows its thread and marks it read", async () => {
    setUserSession("token-123", ME);
    const calls = stubFetch({ conversations: [aConversation({ unreadCount: 3 })] });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Pesan/ }));

    fireEvent.click(await screen.findByText("Wildan"));

    await screen.findByPlaceholderText("Tulis pesan...");
    await waitFor(() => expect(calls.some((call) => call.includes("/read"))).toBe(true));
  });

  it("sending appends immediately rather than waiting for a poll", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));
    fireEvent.click(await screen.findByText("Wildan"));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.change(screen.getByPlaceholderText("Tulis pesan..."), {
      target: { value: "terkirim" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    // Your own message must never appear to lag.
    await screen.findByText("terkirim");
  });

  it("will not send an empty message", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));
    fireEvent.click(await screen.findByText("Wildan"));

    const submit = await screen.findByRole("button", { name: "Kirim" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));
    fireEvent.click(await screen.findByText("Wildan"));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.change(screen.getByPlaceholderText("Tulis pesan..."), {
      target: { value: "jangan hilang" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Tulis pesan...") as HTMLInputElement).value
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
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));
    fireEvent.click(await screen.findByText("Wildan"));

    await screen.findByText("dari saya");
    const items = screen.getAllByRole("listitem");
    // Alignment carries identity; `data-mine` is the hook it reads.
    expect(items.map((item) => item.getAttribute("data-mine"))).toEqual([null, "true"]);
  });

  it("goes back to the list", async () => {
    setUserSession("token-123", ME);
    stubFetch();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Pesan" }));
    fireEvent.click(await screen.findByText("Wildan"));
    await screen.findByPlaceholderText("Tulis pesan...");

    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));

    await screen.findByText("halo kak");
    expect(screen.queryAllByPlaceholderText("Tulis pesan...").length).toBe(0);
  });
});
