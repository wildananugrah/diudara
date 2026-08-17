import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setUserSession } from "./apiClient";
import SettingsPage from "./SettingsPage";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

const OWN_PROFILE = {
  handle: "wildan",
  displayName: "Wildan",
  bio: "Bio lama",
  createdAt: "2026-01-01T00:00:00.000Z",
  email: "wildan@example.com",
  whatsappNumber: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/pengaturan"]}>
      <Routes>
        <Route path="/pengaturan" element={<SettingsPage />} />
        <Route path="/masuk" element={<div>login page reached</div>} />
      </Routes>
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

describe("SettingsPage", () => {
  it("redirects a signed-out visitor to the login page", () => {
    renderSettings();

    expect(screen.getByText("login page reached")).toBeTruthy();
    expect(screen.queryAllByText("Pengaturan akun").length).toBe(0);
  });

  it("loads and prefills the caller's own profile when signed in", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async () => jsonResponse(OWN_PROFILE)) as unknown as typeof fetch;

    renderSettings();

    expect(await screen.findByDisplayValue("Wildan")).toBeTruthy();
    expect(screen.getByDisplayValue("Bio lama")).toBeTruthy();
    expect(screen.getByText("wildan@example.com")).toBeTruthy();
  });

  it("updates the display name and shows a confirmation", async () => {
    setUserSession("jwt-abc", USER);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if ((init?.method ?? "GET") === "PATCH") {
        return jsonResponse({ ...OWN_PROFILE, displayName: "Wildan Anugrah" });
      }
      return jsonResponse(OWN_PROFILE);
    }) as unknown as typeof fetch;

    renderSettings();
    await screen.findByDisplayValue("Wildan");

    fireEvent.change(screen.getByLabelText("Nama tampilan"), { target: { value: "Wildan Anugrah" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan perubahan" }));

    expect(await screen.findByText("Perubahan disimpan.")).toBeTruthy();
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(patch.url).toBe("/users/me");
    expect(JSON.parse(patch.init.body as string)).toEqual({ displayName: "Wildan Anugrah", bio: "Bio lama" });
  });

  it("shows an error message when saving fails, without losing what was typed", async () => {
    setUserSession("jwt-abc", USER);
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        return jsonResponse({ error: "displayName: String must contain at least 1 character(s)" }, 400);
      }
      return jsonResponse(OWN_PROFILE);
    }) as unknown as typeof fetch;

    renderSettings();
    await screen.findByDisplayValue("Wildan");

    fireEvent.change(screen.getByLabelText("Nama tampilan"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan perubahan" }));

    const err = await screen.findByTestId("error-displayName");
    expect(err.textContent).toContain("at least 1 character");
    expect((screen.getByLabelText("Nama tampilan") as HTMLInputElement).value).toBe("");
  });

  it("redirects to login when the session expires mid-visit (a 401 from /users/me)", async () => {
    setUserSession("jwt-stale", USER);
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired token" }, 401)) as unknown as typeof fetch;

    renderSettings();

    await waitFor(() => expect(screen.queryAllByText("login page reached").length).toBeGreaterThan(0));
  });
});
