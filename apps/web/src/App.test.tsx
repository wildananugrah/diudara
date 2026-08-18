import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Children, isValidElement, type ReactNode } from "react";
import App, { AppRoutes } from "./App";
import AppShell from "./user/AppShell";
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

  /**
   * Final-review I1: Task 4's own I1, REINTRODUCED. Task 4 found
   * `/lupa-sandi` and `/reset/:token` movable inside the `AppShell` block with
   * the suite green and added the two assertions above; Task 5 then added two
   * MORE outside-shell routes and covered only their route RESOLUTION, not
   * their shell absence. Measured at HEAD `11b8848`: moving either route below
   * inside the `AppShell` block left all 448 web tests green, while the same
   * mutation on each of the five older outside-shell routes went red.
   *
   * These two are the same form as the five above. The class — "a new
   * outside-shell route arrives with nothing holding it there" — is closed
   * separately, by the route-table partition test at the bottom of this file.
   */
  it("renders no navigation shell on /@handle/pengikut", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/pengikut");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.queryAllByRole("navigation").length).toBe(0);
  });

  it("renders no navigation shell on /@handle/mengikuti", async () => {
    global.fetch = mock(async () =>
      jsonResponse([{ handle: "budi", displayName: "Budi Santoso", bio: null, viewerFollows: null }])
    ) as unknown as typeof fetch;

    renderAt("/@wildan/mengikuti");

    expect(await screen.findByText("Budi Santoso")).toBeTruthy();
    expect(screen.queryAllByRole("navigation").length).toBe(0);
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

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toBe("/users/me");
  });

  it("triggers no /users/me request when there is no session at all", async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<App />);

    // `repairSplitSession` returns before ever awaiting when there is no
    // token, but this still crosses at least one microtask inside the async
    // function — waiting a tick is proof enough that the effect, if it were
    // going to call fetch, already would have.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(0);
  });
});

/**
 * One `<Route>` in the real table, flattened: its `path` and whether it sits
 * under the path-less `<Route element={<AppShell />}>` layout route.
 */
interface FlatRoute {
  path: string;
  insideShell: boolean;
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
 * A route that has BOTH a `path` and children (`/dashboard`) is recorded and
 * its children skipped — the dashboard owns its own nesting and is explicitly
 * out of scope for this phase (UI spec §6: not restyled, not touched).
 */
function flattenRouteTable(): FlatRoute[] {
  const table = AppRoutes();
  const flat: FlatRoute[] = [];
  Children.forEach((table.props as { children?: ReactNode }).children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { path?: string; element?: ReactNode; children?: ReactNode };
    if (typeof props.path === "string") {
      flat.push({ path: props.path, insideShell: false });
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
        flat.push({ path: grandchildProps.path, insideShell: isShell });
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
 * decision about whether the new page renders navigation. The design spec
 * (`2026-08-17-member-ui-design.md` §3) and the ledger's binding ruling name
 * signup, login, the two reset pages and `/@handle` as outside; the final
 * review ruled the two follow-list pages outside too.
 */
describe("routing — the shell partition of the real route table", () => {
  it("renders EXACTLY these four paths inside the AppShell layout route", () => {
    const inside = flattenRouteTable()
      .filter((route) => route.insideShell)
      .map((route) => route.path)
      .sort();

    expect(inside).toEqual(["/beranda", "/jelajah", "/pengaturan", "/siaran"]);
  });

  it("renders EXACTLY these paths OUTSIDE the shell — the two follow lists among them", () => {
    const outside = flattenRouteTable()
      .filter((route) => !route.insideShell)
      .map((route) => route.path)
      .sort();

    expect(outside).toEqual([
      "*",
      "/",
      "/:handleParam",
      "/:handleParam/mengikuti",
      "/:handleParam/pengikut",
      "/c/:slug",
      "/c/:slug/request/:joinRequestId",
      "/c/:slug/status/:subscriptionId",
      "/dashboard",
      "/dashboard/login",
      "/lupa-sandi",
      "/masuk",
      "/reset/:token",
      "/signup",
      "/watch/:token",
    ]);
  });
});
