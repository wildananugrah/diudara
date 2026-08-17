import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ResetCompletePage from "./ResetCompletePage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/reset/${token}`]}>
      <Routes>
        <Route path="/reset/:token" element={<ResetCompletePage />} />
        <Route path="/masuk" element={<div>login page reached</div>} />
      </Routes>
    </MemoryRouter>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("ResetCompletePage", () => {
  it("posts the token from the URL and the new password", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    renderAt("abc123token");
    fireEvent.change(screen.getByLabelText("Kata sandi baru"), { target: { value: "newpassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti sandi" }));

    expect(await screen.findByText("Sandi berhasil diganti. Silakan masuk.")).toBeTruthy();
    expect(calls[0]!.url).toBe("/users/password-reset/complete");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      token: "abc123token",
      newPassword: "newpassword1",
    });
  });

  it("shows one identical message for an invalid or expired token", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired reset link" }, 401)) as unknown as typeof fetch;

    renderAt("bad-token");
    fireEvent.change(screen.getByLabelText("Kata sandi baru"), { target: { value: "newpassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti sandi" }));

    expect(
      await screen.findByText("Tautan ini sudah tidak berlaku. Silakan minta tautan baru.")
    ).toBeTruthy();
  });

  it("shows the same identical message whether the token is expired or already used", async () => {
    // The API cannot be told apart from here — both are a plain 401 with the
    // same body. This asserts the UI renders the SAME sentence for both
    // calls, never inferring which case it was.
    global.fetch = mock(async () => jsonResponse({ error: "invalid or expired reset link" }, 401)) as unknown as typeof fetch;

    renderAt("expired-token");
    fireEvent.change(screen.getByLabelText("Kata sandi baru"), { target: { value: "newpassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti sandi" }));
    const expiredMessage = await screen.findByText("Tautan ini sudah tidak berlaku. Silakan minta tautan baru.");
    expect(expiredMessage).toBeTruthy();

    cleanup();
    renderAt("used-token");
    fireEvent.change(screen.getByLabelText("Kata sandi baru"), { target: { value: "newpassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti sandi" }));
    expect(
      await screen.findByText("Tautan ini sudah tidak berlaku. Silakan minta tautan baru.")
    ).toBeTruthy();
  });

  it("links to the login page once the reset succeeds", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    renderAt("abc123token");
    fireEvent.change(screen.getByLabelText("Kata sandi baru"), { target: { value: "newpassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Ganti sandi" }));

    await screen.findByText("Sandi berhasil diganti. Silakan masuk.");
    fireEvent.click(screen.getByRole("link", { name: "Ke halaman masuk" }));

    expect(await screen.findByText("login page reached")).toBeTruthy();
  });
});
