/**
 * Shared helpers for the dashboard's component tests.
 *
 * NOT a test file itself (no `.test.` in the name, so `bun test` does not collect
 * it) and never imported by application code. It exists because five page tests
 * otherwise repeat the same fetch stub, and a stub that drifts between files is
 * how one page ends up tested against a response shape the API does not send.
 */
import { render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setSession } from "./auth";

export const TEST_CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

export const TEST_COMMUNITY = {
  id: "11111111-1111-4111-8111-111111111111",
  creatorId: TEST_CREATOR.id,
  name: "Kelas Bimbel Budi",
  slug: "kelas-bimbel-budi",
  niche: "bimbel",
  status: "active",
  accessMode: "paid",
  createdAt: "2026-08-01T02:00:00.000Z",
};

/** One stubbed route: an exact path, or a `[method, path]` pair when it matters. */
export interface StubRoute {
  method?: string;
  /** Matched against the request URL with `startsWith`, so query strings are fine. */
  path: string;
  status?: number;
  body: unknown;
}

export interface FetchStub {
  calls: Array<{ url: string; method: string; body: unknown }>;
}

/**
 * Installs a `global.fetch` that answers from `routes` and FAILS LOUDLY on
 * anything else.
 *
 * The loud failure is the point: a page that quietly fetches an endpoint nobody
 * stubbed would otherwise pass its test while erroring in a browser.
 */
export function stubFetch(routes: StubRoute[]): FetchStub {
  const stub: FetchStub = { calls: [] };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown = null;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    stub.calls.push({ url, method, body: parsedBody });

    // LONGEST PATH WINS, not first-declared. `/communities` is a prefix of
    // `/communities/:id/tiers`, so a first-match rule would answer a tier request
    // with the community list and the page under test would render nonsense that
    // looked like a bug in the page. (Vite's proxy has exactly this bug for real —
    // see the `^/c/` comment in vite.config.ts.)
    const route = [...routes]
      .sort((a, b) => b.path.length - a.path.length)
      .find((r) => url.startsWith(r.path) && (r.method ?? "GET").toUpperCase() === method);
    if (route === undefined) {
      throw new Error(`unstubbed request: ${method} ${url}`);
    }
    const status = route.status ?? 200;
    if (typeof route.body === "string") {
      return new Response(route.body, { status, headers: { "Content-Type": "text/csv" } });
    }
    return new Response(JSON.stringify(route.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return stub;
}

/**
 * Renders one dashboard page at `path`, signed in, inside a router — wrapped
 * in `<StrictMode>`, matching `main.tsx` (the app's REAL root, which does
 * the same). NOT decoration: `<StrictMode>` deliberately double-invokes
 * every effect on mount in development (setup -> cleanup -> setup again),
 * specifically to surface an effect whose cleanup mutates something the
 * setup half never resets — exactly the shape of the bug Task 3's fix round
 * 1 found only by driving a REAL browser (`cancelledRef` in
 * `EventsPage.tsx`'s `BrowserPublishSection`, never caught by this test
 * suite because `render()` did not do this). Wrapping it here, once, means
 * every dashboard page test gets that coverage from now on at zero ongoing
 * cost — measured after adding this: the full web suite still comes back
 * green, unchanged. If you are looking at this wrapper wondering whether it
 * is safe to remove because it "does nothing visible": it is not decoration,
 * it is exactly what caught a real bug once already.
 */
export function renderPage(
  element: ReactElement,
  { path, at }: { path: string; at: string }
): ReturnType<typeof render> {
  setSession("jwt-test", TEST_CREATOR);
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="/dashboard/login" element={<div>Masuk ke DIUDARA</div>} />
          <Route path="*" element={<div>Halaman lain</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>
  );
}
