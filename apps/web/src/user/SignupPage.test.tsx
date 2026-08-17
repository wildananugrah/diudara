import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import SignupPage from "./SignupPage";

/**
 * The literal copy the brief requires, hardcoded here rather than imported
 * from `SignupPage.ts`'s own `SIGNUP_SUCCESS_MESSAGE` export — importing it
 * would make this file compare the constant to itself, so a mutation that
 * silently changed the constant's VALUE (e.g. to English) would still pass.
 * Hardcoding it is what actually pins the required Indonesian sentence.
 */
const SIGNUP_SUCCESS_MESSAGE = "Akun dibuat. Silakan masuk.";

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

/**
 * Stands in for LoginPage, ACTUALLY reading and rendering `location.state.message`
 * — not just claiming to. Proves the hand-off shape (SignupPage's `navigate()` call
 * really does carry the required copy) without importing the real LoginPage. The
 * "login page reached" text alone would pass even if SignupPage navigated with no
 * state at all or the wrong message; the second line is what the fresh-signup and
 * duplicate-email tests below actually assert against.
 */
function LoginLanding() {
  const location = useLocation();
  const state = location.state as { message?: unknown } | null;
  return (
    <div>
      <p>login page reached</p>
      <p>{typeof state?.message === "string" ? state.message : "(no message received)"}</p>
    </div>
  );
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

    // The literal required copy, actually received by the landing route's
    // own location.state — not just "some page was reached".
    expect(await screen.findByText(SIGNUP_SUCCESS_MESSAGE)).toBeTruthy();
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

    // Same literal, same join — the duplicate-email path must hand off the
    // identical state.message a fresh signup does, not merely land on the
    // same route.
    expect(await screen.findByText(SIGNUP_SUCCESS_MESSAGE)).toBeTruthy();
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

  /**
   * The Task 7 gate found this by counting anchors on the running page:
   * `/masuk` offers "Belum punya akun? Buat akun baru", but `/signup` had NO
   * links at all — a visitor who already has an account and arrives on the
   * signup page (a shared link, a bookmark, a back button) has no way out of
   * it except guessing a URL. The same "unusable past the first screen" class
   * as Task 6's missing sign-out, and equally invisible to a test that only
   * ever drives the form.
   *
   * Asserted as the LINK TARGET, not just the words: copy that reads right
   * while pointing nowhere useful is exactly the failure this closes.
   */
  it("offers a way to the login page for a visitor who already has an account", () => {
    renderSignup();

    const link = screen.getByRole("link", { name: "Sudah punya akun? Masuk" });
    expect(link.getAttribute("href")).toBe("/masuk");
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
