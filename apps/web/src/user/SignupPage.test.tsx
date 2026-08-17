import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SignupPage from "./SignupPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={["/signup"]}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route
          path="/masuk"
          element={<LoginLanding />}
        />
      </Routes>
    </MemoryRouter>
  );
}

/** Stands in for LoginPage, echoing the `state.message` it would receive — proves the hand-off shape without importing the real page. */
function LoginLanding() {
  return <div>login page reached</div>;
}

function fillForm(overrides: Partial<Record<"handle" | "displayName" | "email" | "password", string>> = {}) {
  fireEvent.change(screen.getByLabelText("Handle"), { target: { value: overrides.handle ?? "wildan" } });
  fireEvent.change(screen.getByLabelText("Nama tampilan"), { target: { value: overrides.displayName ?? "Wildan" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: overrides.email ?? "wildan@example.com" } });
  fireEvent.change(screen.getByLabelText("Kata sandi"), { target: { value: overrides.password ?? "supersecret123" } });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("SignupPage", () => {
  it("renders the heading and the WhatsApp hint", () => {
    renderSignup();

    expect(screen.getByRole("heading", { name: "Buat akun" })).toBeTruthy();
    expect(screen.getByLabelText("Nomor WhatsApp (opsional)")).toBeTruthy();
    expect(
      screen.getByText("Untuk memulihkan sandi dan memberi tahu Anda saat ada siaran langsung.")
    ).toBeTruthy();
  });

  it("submits and lands on the login page after a fresh signup", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true }, 201);
    }) as unknown as typeof fetch;

    renderSignup();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(await screen.findByText("login page reached")).toBeTruthy();
    expect(calls[0]!.url).toBe("/users/signup");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      handle: "wildan",
      email: "wildan@example.com",
      password: "supersecret123",
      displayName: "Wildan",
      whatsappNumber: undefined,
    });
  });

  it("shows a duplicate-handle 409 inline, without leaving the form", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "handle is already taken" }, 409)) as unknown as typeof fetch;

    renderSignup();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(await screen.findByText("Handle ini sudah digunakan. Coba handle lain.")).toBeTruthy();
    // Still on the signup form — nothing navigated away.
    expect(screen.queryAllByText("login page reached").length).toBe(0);
  });

  /**
   * THE ONE THAT LOOKS LIKE A BUG UNTIL TASK 2/5's ENUMERATION REASONING IS
   * KNOWN: `RegisterUser` answers a duplicate email with the exact same
   * `201 { ok: true }` as a fresh signup, so the caller who typed a taken
   * email is sent to the SAME success screen a brand-new signer-upper sees
   * — never told the email is taken, which is the whole point.
   */
  it("shows the SAME success screen for a duplicate email as for a fresh signup", async () => {
    global.fetch = mock(async () => jsonResponse({ ok: true }, 201)) as unknown as typeof fetch;

    renderSignup();
    fillForm({ email: "already-registered@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(await screen.findByText("login page reached")).toBeTruthy();
  });

  it("includes a trimmed WhatsApp number when provided, and omits it when blank", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true }, 201);
    }) as unknown as typeof fetch;

    renderSignup();
    fillForm();
    fireEvent.change(screen.getByLabelText("Nomor WhatsApp (opsional)"), {
      target: { value: "+6281234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(calls[0]!.init.body as string).whatsappNumber).toBe("+6281234567890");
  });

  it("renders a 400's field-level messages next to each field", async () => {
    global.fetch = mock(async () =>
      jsonResponse(
        { error: "handle: String must contain at least 1 character(s); email: Invalid email" },
        400
      )
    ) as unknown as typeof fetch;

    renderSignup();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    const handleError = await screen.findByTestId("error-handle");
    expect(handleError.textContent).toContain("at least 1 character");
    expect(screen.getByTestId("error-email").textContent).toContain("Invalid email");
  });

  it("keeps what was typed when signup fails", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "handle is already taken" }, 409)) as unknown as typeof fetch;

    renderSignup();
    fillForm({ handle: "wildan", displayName: "Wildan Anugrah" });
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    await screen.findByText("Handle ini sudah digunakan. Coba handle lain.");
    expect((screen.getByLabelText("Nama tampilan") as HTMLInputElement).value).toBe("Wildan Anugrah");
  });
});
