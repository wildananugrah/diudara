import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./App";

/**
 * `path="/:handleParam"` (ProfilePage) is registered LAST, right before the
 * catch-all, precisely so a single-segment dynamic route cannot shadow
 * `/signup`, `/masuk`, `/lupa-sandi` or any other one-segment static path —
 * see App.tsx's own comment on that route. React Router actually ranks
 * static segments above dynamic ones regardless of declaration order, so
 * this ordering is defensive rather than load-bearing, but the brief is
 * explicit that the failure mode ("your own login page stops resolving")
 * is worth a real test rather than trusting that reasoning blind.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
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

describe("routing — the personal-account routes", () => {
  it("resolves /masuk to the login page, not swallowed by the profile route", () => {
    renderAt("/masuk");

    expect(screen.getByRole("heading", { name: "Masuk" })).toBeTruthy();
  });

  it("resolves /signup to the signup page", () => {
    renderAt("/signup");

    expect(screen.getByRole("heading", { name: "Buat akun" })).toBeTruthy();
  });

  it("resolves /lupa-sandi to the reset request page", () => {
    renderAt("/lupa-sandi");

    expect(screen.getByRole("heading", { name: "Lupa sandi" })).toBeTruthy();
  });

  it("resolves /reset/:token to the reset complete page", () => {
    renderAt("/reset/some-token");

    expect(screen.getByRole("heading", { name: "Atur ulang sandi" })).toBeTruthy();
  });

  it("resolves /pengaturan (signed out) to a redirect to the login page", () => {
    renderAt("/pengaturan");

    expect(screen.getByRole("heading", { name: "Masuk" })).toBeTruthy();
  });

  it("resolves /@wildan to the profile page", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null, createdAt: "2026-01-01T00:00:00.000Z" })
    ) as unknown as typeof fetch;

    renderAt("/@wildan");

    expect(await screen.findByText("Wildan")).toBeTruthy();
  });

  it("still resolves the creator dashboard's own /dashboard/login, unaffected by the new routes", () => {
    renderAt("/dashboard/login");

    expect(screen.getByRole("heading", { name: "Masuk ke DIUDARA" })).toBeTruthy();
  });

  it("still resolves the public checkout route at /c/:slug", async () => {
    global.fetch = mock(async () =>
      jsonResponse({
        id: "community-1",
        name: "Kelas Bimbel Budi",
        niche: null,
        slug: "kelas-budi",
        acceptingNewMembers: true,
        accessMode: "paid",
        tiers: [],
      })
    ) as unknown as typeof fetch;

    renderAt("/c/kelas-budi");

    expect(await screen.findByText("Kelas Bimbel Budi")).toBeTruthy();
  });

  it("renders the shared 404 page for an unknown single-segment path with no leading @", () => {
    renderAt("/some-random-unknown-path");

    expect(screen.getByText("Halaman tidak ditemukan")).toBeTruthy();
  });
});

/**
 * Task 4: the app shell. `/beranda`, `/jelajah` and `/siaran` are new,
 * static, single-segment routes — the brief requires they be registered
 * BEFORE `/:handleParam` (already last, per the block above) precisely so
 * they cannot be shadowed by it. React Router ranks static segments above
 * dynamic ones regardless of declaration order, so this is defensive rather
 * than load-bearing, same reasoning as the block above — which is exactly
 * why it gets its own test rather than trust alone.
 */
describe("routing — the app shell", () => {
  it("resolves /beranda inside the shell, with Beranda's empty-state copy", () => {
    renderAt("/beranda");

    expect(screen.getByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  it("resolves /jelajah inside the shell", () => {
    renderAt("/jelajah");

    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  it("resolves /siaran inside the shell, with Siaran's empty-state copy", () => {
    renderAt("/siaran");

    expect(screen.getByText("Belum ada siaran langsung.")).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  /**
   * The one a future refactor breaks silently, per the brief: a signed-out
   * visitor on the signup page must see no navigation at all — every
   * destination behind the shell requires a session.
   */
  it("renders no navigation shell on the signed-out signup page", () => {
    renderAt("/signup");

    expect(screen.queryAllByRole("navigation").length).toBe(0);
  });

  it("renders no navigation shell on the login page", () => {
    renderAt("/masuk");

    expect(screen.queryAllByRole("navigation").length).toBe(0);
  });

  it("renders no navigation shell on a public profile page", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null, createdAt: "2026-01-01T00:00:00.000Z" })
    ) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Wildan");
    expect(screen.queryAllByRole("navigation").length).toBe(0);
  });
});
