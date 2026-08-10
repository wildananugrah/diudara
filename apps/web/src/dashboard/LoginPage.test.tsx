import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { getToken } from "./auth";
import LoginPage from "./LoginPage";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/login"]}>
      <Routes>
        <Route path="/dashboard/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div>Komunitas Anda</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function fillCredentials(email = "budi@example.com", password = "supersecret123") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Kata sandi"), { target: { value: password } });
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

describe("LoginPage", () => {
  it("stores the token and lands on the community list", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ creator: CREATOR, token: "jwt-fresh" })
    ) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("Komunitas Anda")).toBeTruthy();
    expect(getToken()).toBe("jwt-fresh");
  });

  it("posts to /auth/login with the credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ creator: CREATOR, token: "jwt-fresh" });
    }) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe("/auth/login");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "budi@example.com",
      password: "supersecret123",
    });
  });

  it("shows ONE generic message for a 401 and never says the account does not exist", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid email or password" }, 401)
    ) as unknown as typeof fetch;

    renderLogin();
    fillCredentials("nobody@example.com", "wrongpassword");
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("Email atau kata sandi salah.")).toBeTruthy();
    // The API returns the same error for an unknown email and a wrong password on
    // purpose (Phase 2, anti-enumeration). The UI must not undo that.
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/tidak terdaftar|belum terdaftar|tidak ditemukan|akun tidak ada/i);
    expect(rendered).not.toMatch(/kata sandi salah untuk/i);
  });

  it("renders a 400 as a field-level message next to the field", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "email: Invalid email; password: String must contain at least 1 character(s)" }, 400)
    ) as unknown as typeof fetch;

    renderLogin();
    fillCredentials("not-an-email", "x");
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    const emailError = await screen.findByTestId("error-email");
    expect(emailError.textContent).toContain("Invalid email");
    expect(screen.getByTestId("error-password").textContent).toContain("at least 1 character");
  });

  it("keeps what was typed when the credentials are refused", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "invalid email or password" }, 401)
    ) as unknown as typeof fetch;

    renderLogin();
    fillCredentials("budi@example.com", "wrongpassword");
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    await screen.findByText("Email atau kata sandi salah.");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("budi@example.com");
  });

  it("never renders the token it just stored", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ creator: CREATOR, token: "jwt-super-secret" })
    ) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    await screen.findByText("Komunitas Anda");
    expect(document.body.innerHTML).not.toContain("jwt-super-secret");
  });

  it("can sign up a new creator and lands logged in", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ creator: CREATOR, token: "jwt-new" }, 201);
    }) as unknown as typeof fetch;

    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: /Daftar akun baru/ }));
    fireEvent.change(screen.getByLabelText("Nama"), { target: { value: "Budi" } });
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(await screen.findByText("Komunitas Anda")).toBeTruthy();
    expect(calls).toEqual(["/auth/signup"]);
    expect(getToken()).toBe("jwt-new");
  });

  it("renders a signup 409 inline without losing the form", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "email is already registered" }, 409)
    ) as unknown as typeof fetch;

    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: /Daftar akun baru/ }));
    fireEvent.change(screen.getByLabelText("Nama"), { target: { value: "Budi" } });
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Daftar" }));

    expect(await screen.findByText(/sudah terdaftar/)).toBeTruthy();
    expect((screen.getByLabelText("Nama") as HTMLInputElement).value).toBe("Budi");
  });
});
