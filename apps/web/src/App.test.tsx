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

  /**
   * Review round 2, Important 1: `FollowListPage.test.tsx` renders the
   * component against its OWN local `<Routes>`, which never touches
   * `App.tsx`'s real table — so a typo in either literal path segment below
   * (or the routes simply missing from `AppRoutes`) would pass every
   * existing test and typecheck, and only be discovered by clicking a
   * profile's follower/following count in a real browser. Registered as
   * TWO-segment paths ahead of the bare `/:handleParam` profile route (see
   * that route's own comment on why more segments always wins regardless of
   * declaration order) — these two confirm that wiring against the actual
   * route table, not a stand-in one.
   */
  it("resolves /@wildan/pengikut to the follower list, against the real route table", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pengikut" })).toBeTruthy();
  });

  it("resolves /@wildan/mengikuti to the following list, against the real route table", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mengikuti" })).toBeTruthy();
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

  it("resolves /jelajah inside the shell", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ results: [], newest: [], mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderAt("/jelajah");

    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    // Lets JelajahPage's own explore fetch resolve inside this test's `act`
    // scope, rather than after it — an unmocked `fetch` here previously hit
    // the real network and updated state outside any `act(...)`.
    await screen.findAllByText("Belum ada akun.");
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

  /**
   * Review finding (IMPORTANT 1): the two password-reset pages had content
   * assertions but no navigation-absence assertion, so moving either one
   * inside the AppShell route block left the whole suite green. Mutation-
   * confirmed fixed: both cases below fail if `/lupa-sandi` or
   * `/reset/:token` is nested under `<Route element={<AppShell />}>` in
   * App.tsx.
   */
  it("renders no navigation shell on /lupa-sandi", () => {
    renderAt("/lupa-sandi");

    expect(screen.getByRole("heading", { name: "Lupa sandi" })).toBeTruthy();
    expect(screen.queryAllByRole("navigation").length).toBe(0);
  });

  it("renders no navigation shell on /reset/:token", () => {
    renderAt("/reset/some-token");

    expect(screen.getByRole("heading", { name: "Atur ulang sandi" })).toBeTruthy();
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
