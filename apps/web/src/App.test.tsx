import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Children, isValidElement, type ReactNode } from "react";
import App, { AppRoutes } from "./App";
import AppShell from "./user/AppShell";
import RedirectIfSignedIn from "./user/RedirectIfSignedIn";
import { USER_TOKEN_STORAGE_KEY } from "./user/apiClient";

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

/**
 * Task 7 fix round 1. `App` (unlike every other test in this file) renders
 * its OWN `<BrowserRouter>`, which reads `window.location` — happy-dom's
 * default is `about:blank` (`window.location.pathname` is literally the
 * string `"blank"`), which matches no route at all, not even the catch-all.
 * `window.history.pushState` cannot fix this: a relative URL silently no-ops
 * against `about:blank`'s location, and an absolute one throws
 * `SecurityError` (origin `null` vs `http://localhost`) — both measured.
 *
 * `happyDOM.setURL` is happy-dom's own escape hatch for exactly this ("sets
 * the URL without navigating the browser"), and it is used here — rendering
 * the REAL `App`, not a parallel harness component — precisely because a
 * harness that mirrors `App`'s effect can silently stop matching production
 * the moment `App` changes and the harness does not.
 *
 * Reset after every test in the describe block below: happy-dom's window is
 * ONE instance shared by every test in this `bun test` invocation (not just
 * this file), so a location left on `/@wildan` would otherwise leak into
 * whatever runs next.
 */
function setBrowserPath(path: string): void {
  (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
    `http://localhost${path}`
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
  it("the old dashboard routes are gone — /dashboard falls through to not-found", async () => {
    renderAt("/dashboard");
    // NotFoundPage has NO data-testid — assert on the copy it actually renders.
    expect(await screen.findByText("Halaman tidak ditemukan")).toBeTruthy();
  });

  it("the landing page still renders at /", async () => {
    renderAt("/");
    expect(document.body.textContent).toContain("DIUDARA");
  });

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
  it("resolves /beranda inside the shell, with Beranda's empty-state copy", async () => {
    // Task 5: Beranda now LOADS its feed, so its empty-state copy only appears
    // once the first page resolves. Mocked and awaited for exactly the reason
    // the /jelajah test below gives — an unmocked `fetch` here hits the real
    // network and updates state outside any `act(...)`.
    global.fetch = mock(async () =>
      jsonResponse({ posts: [], nextCursor: null })
    ) as unknown as typeof fetch;

    renderAt("/beranda");

    expect(await screen.findByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  it("resolves /jelajah inside the shell", async () => {
    // Phase 1 made KOMUNITAS the default tab, so bare `/jelajah` loads
    // `GET /communities` rather than `/users/explore`. One mock answering both
    // shapes, since which one is asked for is the page's business, not this
    // routing test's.
    global.fetch = mock(async (url: string) =>
      url.startsWith("/communities")
        ? jsonResponse({ communities: [] })
        : jsonResponse({ results: [], newest: [], mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderAt("/jelajah");

    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    // Lets JelajahPage's own fetch resolve inside this test's `act` scope,
    // rather than after it — an unmocked `fetch` here previously hit the real
    // network and updated state outside any `act(...)`.
    await screen.findByText("Belum ada komunitas di sini.");
  });

  it("resolves /jelajah?tab=orang onto the people half", async () => {
    global.fetch = mock(async (url: string) =>
      url.startsWith("/communities")
        ? jsonResponse({ communities: [] })
        : jsonResponse({ results: [], newest: [], mostFollowed: [] })
    ) as unknown as typeof fetch;

    renderAt("/jelajah?tab=orang");

    await screen.findAllByText("Belum ada akun.");
  });

  it("resolves /siaran inside the shell, with Siaran's empty-state copy", async () => {
    // Task 7: Siaran now LOADS `GET /streams`, so its empty-state copy only
    // appears once that first fetch resolves — same reasoning, and same
    // fix, as the /beranda and /jelajah tests just above.
    global.fetch = mock(async () => jsonResponse({ streams: [] })) as unknown as typeof fetch;

    renderAt("/siaran");

    expect(await screen.findByText("Belum ada siaran langsung.")).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });

  /**
   * The shell used to wrap each page's own `<main className="user-page">` in a
   * SECOND `<main className="app-shell-main">` — visible as `main > main` in
   * any inspector. Nested `<main>` is invalid HTML and hands assistive
   * technology two "main" landmarks to choose between. The wrapper is a
   * `<div>`; it keeps the same class, so every CSS rule keyed on
   * `.app-shell-main` (the 768px `margin-left: 220px`, the 72px bottom
   * padding that clears the fixed bottom bar) is untouched.
   *
   * Asserted on the TAG rather than the ARIA role: the role is what breaks
   * for a screen reader, but the tag is what makes the document invalid, and
   * a `role="main"` added by hand somewhere should not be able to satisfy it.
   */
  it("renders exactly one main landmark inside the shell, not a nested pair", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [], nextCursor: null })
    ) as unknown as typeof fetch;

    renderAt("/beranda");

    await screen.findByText("Belum ada kiriman untuk ditampilkan.");
    expect(document.querySelectorAll("main").length).toBe(1);
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

  /**
   * REVERSED DELIBERATELY on 2026-08-25 — this test asserted the exact
   * opposite, and the reasoning it rested on had expired.
   *
   * Spec §3's rule is "no navigation when there is no session", and the
   * public profile was placed outside the shell under it. That rule predates
   * `useDestinations`, which now computes the fourth destination FROM whether
   * a session exists: signed out it reads "Masuk" -> /masuk. A nav on a
   * public page therefore no longer promises something tapping it cannot
   * deliver, which was the rule's whole purpose. Note §3 itself names only
   * signup, login and the two reset pages — `/@handle` was added to that list
   * by a later ruling that generalised the rule past what it said.
   *
   * The auth pages stay outside for a DIFFERENT reason that has not expired:
   * a nav there is noise, and its fourth item would point at the page you are
   * already standing on.
   *
   * What forced the reversal: `/@handle` is where a member buys a membership,
   * and with no navigation of any kind it is a dead end — on a phone the only
   * way out is the browser's own Back button.
   *
   * Two, not one: `AppShell` renders one destinations array as both a bottom
   * bar and a side rail, and happy-dom does not evaluate the media query that
   * hides one of them — so the count also pins "one source, two shapes".
   */
  it("renders the navigation shell on a public profile page", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ handle: "wildan", displayName: "Wildan", bio: null, createdAt: "2026-01-01T00:00:00.000Z" })
    ) as unknown as typeof fetch;

    renderAt("/@wildan");

    await screen.findByText("Wildan");
    expect(screen.getAllByRole("navigation", { name: "Navigasi utama" }).length).toBe(2);
  });

  /**
   * These two follow the profile across the boundary, for the reason they
   * exist: both are reached ONLY by tapping a follower/following count on a
   * profile, so leaving them outside while the profile moved inside would
   * make the navigation appear, vanish on tap, and reappear on Back.
   *
   * Their previous "no navigation" assertions were added by a final review
   * that measured a real hole — moving either route inside the shell left all
   * 448 web tests green at HEAD `11b8848`. That hole is now closed by the
   * route-table partition test at the bottom of this file, which asserts the
   * whole boundary rather than sampling it, and which is what forced this
   * change to be deliberate rather than quiet.
   */
  it("renders the navigation shell on /@handle/pengikut", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Navigasi utama" }).length).toBe(2);
  });

  it("renders the navigation shell on /@handle/mengikuti", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Navigasi utama" }).length).toBe(2);
  });
});

/**
 * Task 7. `App` (not `AppRoutes`) is the one component with the repair
 * `useEffect`, so it — and its own `<BrowserRouter>` — must actually be
 * rendered here, unlike every other test in this file which renders
 * `AppRoutes` inside a `MemoryRouter`. `App` brings its own router, so it is
 * NOT wrapped in another one.
 */
describe("App — repairs a split session once, above the router (Task 7)", () => {
  afterEach(() => {
    // See `setBrowserPath`'s own docstring: happy-dom's window (and
    // therefore its location) is shared process-wide, so a path set by the
    // race-condition test below must not leak into whatever test — in this
    // file or another — runs next.
    setBrowserPath("/");
  });

  it("triggers exactly one /users/me request when the session is split", async () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        handle: "wildan",
        displayName: "Wildan",
        bio: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        email: "wildan@example.com",
        whatsappNumber: null,
      });
    }) as unknown as typeof fetch;

    render(<App />);

    // The WHOLE call list, sorted — not a filtered count. Fix round 1, Minor 3:
    // filtering dropped the "and nothing else" half of this assertion, which is
    // exactly the half that notices a new fetch being added to the boot effect.
    // Both requests are issued synchronously by that one effect, so the total is
    // deterministic; sorted because their completion order is not the point.
    // Strings, so a failure prints two short arrays.
    await waitFor(() => expect(calls.length).toBe(2));
    expect([...calls].sort()).toEqual(["/users/limits", "/users/me"]);
    // Holds only because this test renders `<App />` directly, not through
    // `main.tsx`'s `<StrictMode>` wrapper. StrictMode double-invokes effects
    // in development, so a real dev session issues TWO `/users/me` requests
    // here — harmless (`repairSplitSession` is idempotent: the second call's
    // `getSessionUser() !== null` guard bails immediately) but worth naming,
    // since "exactly one" is a property of this test's harness, not of
    // `repairSplitSession` itself.
  });

  it("triggers no /users/me request when there is no session at all", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;

    // Wrapped in `act`: `repairSplitSession` returns before ever awaiting
    // when there is no token, but its `.then(() => setRepaired(...))` (fix
    // round 1) still fires as a microtask once the promise settles — inside
    // `act` so that update isn't reported outside React's control, rather
    // than because it needs to be observed here.
    await act(async () => {
      render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // No `/users/me` — there is no session to repair — and the boot effect's
    // other request, and nothing else. Fix round 1, Minor 3: this used to assert
    // "this page load makes no requests at all", which was the assertion that
    // would have caught `/users/limits` being added.
    expect(calls).toEqual(["/users/limits"]);
  });

  /**
   * Task 8, spec §6. The web is a static build and cannot read the API's
   * `MAX_POST_IMAGES`, so the app asks for it ONCE here, at boot, above the
   * router — the composer then reads the answer from a store rather than
   * fetching it per mount. Asked with no session too: the route is public, and
   * a visitor who signs in on this page load must not be left with a composer
   * running on the fallback.
   */
  it("asks GET /users/limits once at boot, session or no session", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({ maxPostImages: 5 });
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(calls.filter((url) => url === "/users/limits").length).toBe(1);
  });

  /**
   * Fix round 1, IMPORTANT 1. `repairSplitSession` fixing `localStorage` was
   * never the whole job: the three `getSessionUser()` consumers
   * (`FollowButton.tsx`, `ProfilePage.tsx`, `BerandaPage.tsx`) are plain,
   * unsubscribed render-time reads, and the only `useSyncExternalStore`
   * subscribers snapshot `isUserSignedIn()`/`getUserToken()` — values that do
   * NOT change across the repair, since the token was already present. So
   * `notify()` firing was not enough to make React re-render anything, and
   * whether the stale "Ikuti" disappeared was a pure race against
   * `ProfilePage`'s own `/users/by-handle/...` fetch — which React's
   * child-before-parent effect ordering loses BY DEFAULT.
   *
   * This is the slow-`/users/me` half of that race — the reviewer's
   * measured-broken case — not the fast half the first test above already
   * covers well enough by other means. `/users/me` is gated on a promise
   * this test controls directly, so the ordering is deterministic rather
   * than timing-dependent: the profile and its posts resolve FIRST, the
   * stale "Ikuti" is confirmed on screen, and only then is `/users/me`
   * allowed to resolve.
   */
  it("removes the stale Ikuti button once the repair lands, even when /users/me resolves AFTER the profile fetch", async () => {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-abc");
    setBrowserPath("/@wildan");

    let resolveMe: (() => void) | null = null;
    const meGate = new Promise<void>((resolve) => {
      resolveMe = resolve;
    });

    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/users/by-handle/")) {
        return jsonResponse({
          handle: "wildan",
          displayName: "Wildan",
          bio: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          followerCount: 0,
          followingCount: 0,
          viewerFollows: false,
        });
      }
      if (url.startsWith("/users/wildan/posts")) {
        return jsonResponse({ posts: [], nextCursor: null });
      }
      if (url === "/users/me") {
        // Deliberately resolves AFTER the caller awaits `meGate` below — the
        // losing half of the race.
        await meGate;
        return jsonResponse({
          handle: "wildan",
          displayName: "Wildan",
          bio: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          email: "wildan@example.com",
          whatsappNumber: null,
        });
      }
      throw new Error(`unexpected fetch in this test: ${url}`);
    }) as unknown as typeof fetch;

    render(<App />);

    // Guard: the stale render happens first — this IS the Phase-2 bug,
    // reproduced. If this assertion itself ever fails, the test below it is
    // not exercising the race it claims to.
    expect(await screen.findByRole("button", { name: "Ikuti" })).toBeTruthy();

    // Let /users/me resolve now that the profile has already rendered.
    resolveMe!();

    // The real assertion: the repair landing must force a re-render, so the
    // now-stale "Ikuti" (this IS your own profile) disappears without a
    // page reload.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Ikuti" }) === null).toBe(true);
    });
  });
});

/**
 * "Signed in, but standing on a page meant for people who are not."
 *
 * `/masuk` answered this on its own and answered it wrong for months
 * (redirecting to the marketing landing page); `/signup` did not answer it at
 * all and offered a signed-in visitor an account they already have. The rule
 * now lives in ONE component, `RedirectIfSignedIn`, applied at the route
 * table — so these tests exercise the real wiring, not each page's private
 * copy of a guard.
 */
describe("routing — pages that turn a signed-in visitor away", () => {
  function signIn() {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, "jwt-existing");
  }

  function mockFeed() {
    global.fetch = mock(async () =>
      jsonResponse({ posts: [], nextCursor: null })
    ) as unknown as typeof fetch;
  }

  it("sends a signed-in visitor from /signup to the feed", async () => {
    signIn();
    mockFeed();

    renderAt("/signup");

    expect(await screen.findByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { name: "Buat akun" }).length).toBe(0);
  });

  it("sends a signed-in visitor from /masuk to the feed", async () => {
    signIn();
    mockFeed();

    renderAt("/masuk");

    expect(await screen.findByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { name: "Masuk" }).length).toBe(0);
  });

  /**
   * DELIBERATELY NOT GUARDED, and this test is the reason it stays that way.
   *
   * `SettingsPage` offers no password change — checked, not assumed — so
   * `/lupa-sandi` is the ONLY route to a new password, and `/reset/:token` is
   * where the emailed link lands. Forgetting a password does not end an
   * existing browser session, so a signed-in visitor is exactly who arrives
   * here. Turning them away would lock them out of password recovery with no
   * alternative; guarding both would make it impossible outright.
   *
   * If a password change is ever added to Settings, these two assertions are
   * the ones to revisit — not to delete quietly.
   */
  it("lets a signed-in visitor reach /lupa-sandi — it is the only way to a new password", () => {
    signIn();

    renderAt("/lupa-sandi");

    expect(screen.getByRole("heading", { name: "Lupa sandi" })).toBeTruthy();
  });

  it("lets a signed-in visitor reach /reset/:token — the emailed link must still work", () => {
    signIn();

    renderAt("/reset/some-token");

    expect(screen.getByRole("heading", { name: "Atur ulang sandi" })).toBeTruthy();
  });
});

/**
 * One `<Route>` in the real table, flattened: its `path` and whether it sits
 * under the path-less `<Route element={<AppShell />}>` layout route.
 */
interface FlatRoute {
  path: string;
  insideShell: boolean;
  /** Wrapped in `RedirectIfSignedIn` — i.e. closed to a signed-in visitor. */
  guarded: boolean;
}

/**
 * Reads `AppRoutes`' REAL element tree — not a stand-in table — and returns
 * every top-level route plus every child of the `AppShell` layout route.
 *
 * `AppRoutes` is called as a plain function rather than rendered: it takes no
 * props and calls no hooks, so the `<Routes>` element it returns can be walked
 * directly, and walking it is the only way to see the SHAPE of the table (a
 * rendered tree shows one matched route at a time, which is why five separate
 * `renderAt` assertions were needed to cover five routes, and why a sixth
 * route could arrive uncovered).
 *
 * A route that has BOTH a `path` and children would be recorded with its
 * children skipped — no route in the current table does this (the old
 * `/dashboard` nesting was retired in Phase 8's Task 1), but the branch is
 * kept so a future nested route does not silently vanish from the flattened
 * list instead of failing loudly.
 */
function flattenRouteTable(): FlatRoute[] {
  const table = AppRoutes();
  const flat: FlatRoute[] = [];
  Children.forEach((table.props as { children?: ReactNode }).children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { path?: string; element?: ReactNode; children?: ReactNode };
    if (typeof props.path === "string") {
      const guarded =
        isValidElement(props.element) && props.element.type === RedirectIfSignedIn;
      flat.push({ path: props.path, insideShell: false, guarded });
      return;
    }
    // A path-less layout route. `AppShell` is the only one this app has; any
    // other would land here with `insideShell: false` for its children and
    // fail the assertions below, which is the correct outcome — a second
    // layout route is a decision that must be made deliberately.
    const isShell = isValidElement(props.element) && props.element.type === AppShell;
    Children.forEach(props.children, (grandchild) => {
      if (!isValidElement(grandchild)) return;
      const grandchildProps = grandchild.props as { path?: string };
      if (typeof grandchildProps.path === "string") {
        // Shell children are never wrapped: everything behind the shell is
        // reachable signed in by definition.
        flat.push({ path: grandchildProps.path, insideShell: isShell, guarded: false });
      }
    });
  });
  return flat;
}

/**
 * Final-review recommendation, closing the CLASS rather than the instance.
 *
 * Twice now — Task 4's I1 (`/lupa-sandi`, `/reset/:token`) and the final
 * review's I1 (`/:handleParam/pengikut`, `/:handleParam/mengikuti`) — a new
 * outside-shell route has arrived with nothing holding it outside, and both
 * times the fix was to hand-write the missing per-route assertion. Those
 * assertions cannot cover a route that does not exist yet; this one can,
 * because it asserts the whole PARTITION rather than sampling it.
 *
 * IT IS MEANT TO FAIL when the route table changes. That is not brittleness,
 * it is the point: adding a route, or moving one across the shell boundary,
 * must be a deliberate edit to the expected list below and a deliberate
 * decision about whether the new page renders navigation.
 *
 * It did its job on 2026-08-25: moving the profile and the two follow lists
 * INSIDE the shell could not be done quietly — it failed here and forced this
 * list to be rewritten by hand. The boundary now falls where spec §3 actually
 * draws it, around the four pages you reach without a session: signup, login,
 * and the two reset pages. `/` has the landing's own header and `*` is the
 * 404. Everything else — including the public profile, which is where a
 * membership is bought — carries navigation, because `useDestinations`
 * renders "Masuk" rather than "Profil" when there is no session and so cannot
 * offer a signed-out visitor a door that is not there.
 */
/**
 * The same shape as the shell partition below, for the other boundary a page
 * can sit on: closed to a signed-in visitor, or open to one.
 *
 * This asserts the whole set, not a sample, because the failure it exists to
 * catch is a route ARRIVING — `/signup` sat unguarded from the day it was
 * written, offering a signed-in visitor an account they already had, and no
 * per-page test could have caught a page nobody thought to write a test for.
 *
 * It is meant to fail when the set changes. Adding a page here must be a
 * deliberate edit to one of these two lists.
 */
describe("routing — which pages turn a signed-in visitor away", () => {
  it("guards EXACTLY /signup and /masuk", () => {
    const guarded = flattenRouteTable()
      .filter((route) => route.guarded)
      .map((route) => route.path)
      .sort();

    expect(guarded).toEqual(["/masuk", "/signup"]);
  });

  /**
   * The password-recovery pair, named here so that leaving them open reads as
   * a decision rather than an omission. `SettingsPage` has no password
   * change, so these two are the ONLY route to a new password, and a
   * forgotten password does not end an existing browser session. Guarding
   * them would lock a signed-in user out of recovery.
   *
   * Revisit if a password change is ever added to Settings.
   */
  it("leaves the two password-recovery pages open to a signed-in visitor", () => {
    const open = flattenRouteTable()
      .filter((route) => !route.insideShell && !route.guarded)
      .map((route) => route.path)
      .sort();

    expect(open).toEqual(["*", "/", "/lupa-sandi", "/reset/:token"]);
  });
});

describe("routing — the shell partition of the real route table", () => {
  it("renders EXACTLY these nine paths inside the AppShell layout route", () => {
    const inside = flattenRouteTable()
      .filter((route) => route.insideShell)
      .map((route) => route.path)
      .sort();

    // Phase 1 added the two `/komunitas` paths. Spelled out rather than
    // counted, the same discipline the rest of this file keeps: a set that
    // gained a route nobody meant to add should fail here, naming it.
    expect(inside).toEqual([
      "/:handleParam",
      "/:handleParam/mengikuti",
      "/:handleParam/pengikut",
      "/beranda",
      "/jelajah",
      "/komunitas/:slug",
      "/komunitas/baru",
      "/pengaturan",
      "/siaran",
    ]);
  });

  it("renders EXACTLY these paths OUTSIDE the shell — the four auth pages among them", () => {
    const outside = flattenRouteTable()
      .filter((route) => !route.insideShell)
      .map((route) => route.path)
      .sort();

    expect(outside).toEqual([
      "*",
      "/",
      "/lupa-sandi",
      "/masuk",
      "/reset/:token",
      "/signup",
    ]);
  });
});
