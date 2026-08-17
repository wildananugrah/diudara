import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { getUserToken } from "./apiClient";
import LoginPage from "./LoginPage";

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderLogin(initialEntry: string | { pathname: string; state?: unknown } = "/masuk") {
  return render(
    <MemoryRouter initialEntries={[initialEntry as never]}>
      <Routes>
        <Route path="/" element={<div>home reached</div>} />
        <Route path="/masuk" element={<LoginPage />} />
        <Route path="/pengaturan" element={<div>settings page reached</div>} />
        {/* `/@:handleParam` would NOT match `/@wildan` — React Router cannot mix a
            literal and a param inside one segment (see App.tsx's own comment on
            ProfilePage's route). `/:handleParam` is the real production shape, and
            it is registered last so it cannot shadow the static routes above. */}
        <Route path="/:handleParam" element={<div>profile page reached</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function fillCredentials(email = "wildan@example.com", password = "supersecret123") {
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
  it("renders the heading and the 'Lupa sandi?' link", () => {
    renderLogin();

    expect(screen.getByRole("heading", { name: "Masuk" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lupa sandi?" })).toBeTruthy();
  });

  it("stores a session and redirects to the caller's own profile", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("profile page reached")).toBeTruthy();
    expect(getUserToken()).toBe("jwt-fresh");
  });

  it("posts to /users/login with the credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ user: USER, token: "jwt-fresh" });
    }) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    await screen.findByText("profile page reached");
    expect(calls[0]!.url).toBe("/users/login");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "wildan@example.com",
      password: "supersecret123",
    });
  });

  it("shows ONE generic message for a 401 and never says the account does not exist", async () => {
    global.fetch = mock(async () => jsonResponse({ error: "invalid email or password" }, 401)) as unknown as typeof fetch;

    renderLogin();
    fillCredentials("nobody@example.com", "wrongpassword");
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("Email atau kata sandi salah.")).toBeTruthy();
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/tidak terdaftar|belum terdaftar|tidak ditemukan|akun tidak ada/i);
  });

  it("never renders the token it just stored", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-super-secret" })) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    await screen.findByText("profile page reached");
    expect(document.body.innerHTML).not.toContain("jwt-super-secret");
  });

  it("shows the signup hand-off notice when arriving with a state message", () => {
    renderLogin({ pathname: "/masuk", state: { message: "Akun dibuat. Silakan masuk." } });

    expect(screen.getByText("Akun dibuat. Silakan masuk.")).toBeTruthy();
  });

  it("redirects an already-signed-in visitor away from the login form", () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;
    // Sign in first via a throwaway render, then remount at /masuk.
    localStorage.setItem("diudara.user.token", "jwt-existing");

    renderLogin();

    expect(screen.queryAllByRole("heading", { name: "Masuk" }).length).toBe(0);
  });

  it("redirects to a guarded page's own path when arriving via state.from", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;

    renderLogin({ pathname: "/masuk", state: { from: "/pengaturan" } });
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("settings page reached")).toBeTruthy();
  });
});
