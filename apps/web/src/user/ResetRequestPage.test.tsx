import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ResetRequestPage from "./ResetRequestPage";

const SAME_MESSAGE = "Kami akan mengirim tautan pemulihan jika akun dengan data tersebut ada.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/lupa-sandi"]}>
      <Routes>
        <Route path="/lupa-sandi" element={<ResetRequestPage />} />
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

async function submit(email: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Kirim tautan pemulihan" }));
  return screen.findByText(SAME_MESSAGE);
}

describe("ResetRequestPage", () => {
  it("posts the email to /users/password-reset/request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    renderPage();
    await submit("wildan@example.com");

    expect(calls[0]!.url).toBe("/users/password-reset/request");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "wildan@example.com" });
  });

  /**
   * THE ENUMERATION-SAFETY ASSERTION, on the UI side. `RequestPasswordReset`
   * answers `200 { ok: true }` identically whether the account exists, is
   * over its rate limit, or has no channel at all (Task 5) — this test
   * proves the page shows the exact same sentence for an address that is
   * obviously fake and one that looks real, because the API gives it no way
   * to tell them apart.
   */
  it("shows the identical success message for any email — a known-looking one and an obviously unregistered one", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    renderPage();
    await submit("definitely-not-a-real-account-anywhere@example.com");

    expect(screen.getByText(SAME_MESSAGE)).toBeTruthy();
    cleanup();

    renderPage();
    await submit("also-arbitrary@example.com");

    expect(screen.getByText(SAME_MESSAGE)).toBeTruthy();
  });

  it("never shows a different message for an email that looks unregistered", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    renderPage();
    await submit("nobody@example.com");

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/tidak ditemukan|tidak terdaftar|akun tidak ada/i);
  });

  it("shows a generic failure message on a network/server error, and lets the visitor retry", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "internal server error" }, 500)) as unknown as typeof fetch;

    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "wildan@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim tautan pemulihan" }));

    expect(await screen.findByText("Permintaan gagal dikirim. Coba lagi.")).toBeTruthy();
    // The form is still there — a retry is possible.
    expect(screen.getByRole("button", { name: "Kirim tautan pemulihan" })).toBeTruthy();
  });

  it("links back to the login page", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "Kembali ke halaman masuk" })).toBeTruthy();
  });
});
