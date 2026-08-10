import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import ChannelsPage from "./ChannelsPage";
import { renderPage, stubFetch, TEST_COMMUNITY } from "../testing";

const CHANNELS_PATH = `/communities/${TEST_COMMUNITY.id}/channels`;

const TELEGRAM_CHANNEL = {
  id: "channel-1",
  communityId: TEST_COMMUNITY.id,
  platform: "telegram",
  externalGroupId: "-1001234567890",
  inviteLink: null,
  botStatus: "disconnected",
};

function render() {
  return renderPage(<ChannelsPage />, {
    path: "/dashboard/c/:communityId/channels",
    at: `/dashboard/c/${TEST_COMMUNITY.id}/channels`,
  });
}

function fillGroupId(value: string) {
  fireEvent.change(screen.getByLabelText(/ID grup/), { target: { value } });
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

describe("ChannelsPage", () => {
  it("lists the connected groups", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [TELEGRAM_CHANNEL] },
    ]);

    render();

    // By role: "Telegram" is also the label of the connect form's platform option,
    // and a bare text query would not say which of the two it found.
    expect(await screen.findByRole("heading", { name: "Telegram" })).toBeTruthy();
    expect(screen.getByText("-1001234567890")).toBeTruthy();
  });

  it("shows an empty state that says what to do next", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
    ]);

    render();

    expect(await screen.findByText(/Belum ada grup terhubung/)).toBeTruthy();
  });

  it("says on the form that Telegram needs the NUMERIC chat id and where to find it", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);

    const hint = screen.getByTestId("telegram-chat-id-hint").textContent ?? "";
    // The creator's instinct is @username — it is what Telegram shows them, and it
    // even works for the outbound half. Phase 4 constrained this so a join can be
    // matched back for revocation, so the form has to say so BEFORE they submit.
    expect(hint).toMatch(/angka|numerik/i);
    expect(hint).toContain("@");
    expect(hint).toMatch(/-100/);
    // Where to find it.
    expect(hint).toMatch(/getChat|bot info|info grup/i);
    // What they lose if they get it wrong.
    expect(hint).toMatch(/dikeluarkan|dicabut|revoke/i);
  });

  it("refuses an @username for Telegram without asking the API", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);

    fillGroupId("@kelasbudi");
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan grup/ }));

    expect((await screen.findByTestId("error-externalGroupId")).textContent).toMatch(/angka|numerik/i);
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("accepts a numeric Telegram chat id", async () => {
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
      { method: "POST", path: CHANNELS_PATH, status: 201, body: TELEGRAM_CHANNEL },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);

    fillGroupId("-1001234567890");
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan grup/ }));

    expect(await screen.findByText("-1001234567890")).toBeTruthy();
    const post = stub.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ platform: "telegram", externalGroupId: "-1001234567890" });
  });

  it("does not impose the numeric rule on WhatsApp group ids", async () => {
    const whatsapp = {
      ...TELEGRAM_CHANNEL,
      id: "channel-2",
      platform: "whatsapp",
      externalGroupId: "120363123456789@g.us",
    };
    const stub = stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
      { method: "POST", path: CHANNELS_PATH, status: 201, body: whatsapp },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);

    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "whatsapp" } });
    fillGroupId("120363123456789@g.us");
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan grup/ }));

    expect(await screen.findByText("120363123456789@g.us")).toBeTruthy();
    expect(stub.calls.find((c) => c.method === "POST")!.body).toEqual({
      platform: "whatsapp",
      externalGroupId: "120363123456789@g.us",
    });
  });

  it("says WhatsApp cannot remove members automatically", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      {
        path: CHANNELS_PATH,
        body: [{ ...TELEGRAM_CHANNEL, platform: "whatsapp", externalGroupId: "120363@g.us" }],
      },
    ]);

    render();

    expect(await screen.findByText(/tidak dapat mengeluarkan anggota secara otomatis/)).toBeTruthy();
  });

  it("renders a 409 inline with the form still filled in", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
      {
        method: "POST",
        path: CHANNELS_PATH,
        status: 409,
        body: { error: "this group is already connected to a community" },
      },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);
    fillGroupId("-1001234567890");
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan grup/ }));

    expect(await screen.findByText(/sudah terhubung ke sebuah komunitas/)).toBeTruthy();
    expect((screen.getByLabelText(/ID grup/) as HTMLInputElement).value).toBe("-1001234567890");
  });

  it("surfaces the API's own numeric-chat-id message if it ever gets past the form", async () => {
    stubFetch([
      { path: "/communities", body: [TEST_COMMUNITY] },
      { path: CHANNELS_PATH, body: [] },
      {
        method: "POST",
        path: CHANNELS_PATH,
        status: 400,
        body: { error: "externalGroupId: telegram requires the group's NUMERIC chat id" },
      },
    ]);

    render();
    await screen.findByText(/Belum ada grup terhubung/);
    // Bypass the client-side guard the way a paste with stray whitespace could:
    // the point is that the server's answer is still rendered on the field.
    fillGroupId("-100123");
    fireEvent.click(screen.getByRole("button", { name: /Hubungkan grup/ }));

    await waitFor(() => {
      const el = screen.queryByTestId("error-externalGroupId");
      expect(el?.textContent).toContain("NUMERIC chat id");
    });
  });
});
