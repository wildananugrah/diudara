import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CommunityTagsEditor from "./CommunityTagsEditor";
import { setUserSession } from "./apiClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  setUserSession("token-1", { handle: "wildan", displayName: "Wildan", email: "w@example.com" });
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
  localStorage.clear();
});

describe("CommunityTagsEditor", () => {
  it("renders the current tags as removable chips", () => {
    render(<CommunityTagsEditor slug="kelas-desain" initialTags={["desain", "ui"]} />);

    expect(screen.getByText("#desain", { exact: false }).textContent).toContain("#desain");
    expect(screen.getByText("#ui", { exact: false }).textContent).toContain("#ui");
  });

  it("adds a tag through the API and shows the server's normalised result", async () => {
    global.fetch = mock(async () => jsonResponse({ tags: ["desain", "baru"] })) as unknown as typeof fetch;
    render(<CommunityTagsEditor slug="kelas-desain" initialTags={["desain"]} />);

    fireEvent.change(screen.getByLabelText("Tambah tag"), { target: { value: "  Baru " } });
    fireEvent.click(screen.getByRole("button", { name: "Tambah" }));

    expect(await screen.findByText("#baru")).toBeTruthy();
  });

  it("removes a tag through the API", async () => {
    global.fetch = mock(async () => jsonResponse({ tags: [] })) as unknown as typeof fetch;
    render(<CommunityTagsEditor slug="kelas-desain" initialTags={["desain"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Hapus tag desain" }));

    await screen.findByText("Belum ada tag.");
  });

  it("shows an error and keeps the tag when the request fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "gagal" }, 500)) as unknown as typeof fetch;
    render(<CommunityTagsEditor slug="kelas-desain" initialTags={["desain"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Hapus tag desain" }));

    await screen.findByRole("alert");
    expect(screen.getByText("#desain", { exact: false }).textContent).toContain("#desain");
  });
});
