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
        {/* Still here on purpose: "/" is where a signed-in visitor used to be
            sent, so it must remain reachable in this harness for the tests
            below to be able to prove they DON'T land on it. */}
        <Route path="/" element={<div>home reached</div>} />
        <Route path="/beranda" element={<div>beranda reached</div>} />
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

  /**
   * One rule for "signed in, no particular destination asked for": /beranda.
   * This used to land on the caller's own profile while the already-signed-in
   * guard below landed on "/" — two answers to the same question, and neither
   * was the feed.
   */
  it("stores a session and redirects to /beranda", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;

    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("beranda reached")).toBeTruthy();
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

    // Waited on only as the "login finished" signal — this test is about the
    // request, not the destination, which has its own test above.
    await screen.findByText("beranda reached");
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

    // Waited on only as the "login finished" signal — this test is about the
    // request, not the destination, which has its own test above.
    await screen.findByText("beranda reached");
    expect(document.body.innerHTML).not.toContain("jwt-super-secret");
  });

  it("shows the signup hand-off notice when arriving with a state message", () => {
    renderLogin({ pathname: "/masuk", state: { message: "Akun dibuat. Silakan masuk." } });

    expect(screen.getByText("Akun dibuat. Silakan masuk.")).toBeTruthy();
  });

  /*
   * The "already signed in -> /beranda" test used to live here, rendering
   * LoginPage directly. That check is no longer LoginPage's: it moved to
   * `RedirectIfSignedIn`, applied to this route in App.tsx, and its test
   * moved with it to App.test.tsx's "pages that turn a signed-in visitor
   * away" block — where it runs against the real route table rather than a
   * component in isolation, and so also proves the wiring.
   *
   * Worth remembering what the old version of that test looked like: it was
   * called "redirects an already-signed-in visitor away from the login form"
   * and asserted only that the "Masuk" heading was absent. That is true of
   * every destination, including the landing page it actually sent people to.
   */

  /**
   * `state.from` still outranks the /beranda default: a visitor bounced off a
   * guarded page returns to THAT page, not the feed. This is the assertion
   * that stops the change above from flattening every login into /beranda.
   */
  it("redirects to a guarded page's own path when arriving via state.from", async () => {
    global.fetch = mock(async () => jsonResponse({ user: USER, token: "jwt-fresh" })) as unknown as typeof fetch;

    renderLogin({ pathname: "/masuk", state: { from: "/pengaturan" } });
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));

    expect(await screen.findByText("settings page reached")).toBeTruthy();
  });
});
