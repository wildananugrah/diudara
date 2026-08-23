import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Whole-branch review item 5: nothing pins the Vite proxy table, and a
 * missing entry there has now broken this project THREE TIMES — see
 * `vite.config.ts`'s own comments on `^/c/`, `/streaming` and `^/users/`,
 * each found only by actually starting `vite dev` and loading a page, not
 * by reading the file. The last one (`^/users/`) was missing for the whole
 * of this phase's six pages: `GET /users/by-handle/x` answered `200
 * text/html` (Vite's SPA fallback), `POST /users/signup` a bodiless 404, and
 * every page on `/signup`, `/masuk`, `/pengaturan`, `/@handle` was dead
 * under `vite dev` until Task 6's fix round added it.
 *
 * This is a STATIC check, not a live one — it cannot start a dev server and
 * drive a browser the way the prior discoveries were actually made. What it
 * CAN do is keep the two sources of truth (what the app actually fetches,
 * and what the proxy table actually forwards) from drifting apart again:
 * for every distinct first path SEGMENT any `fetch()`-family call in
 * `apps/web/src` targets (`/users`, `/c`, `/ai`, …), some entry in
 * `vite.config.ts`'s `proxy` table must be able to match it.
 *
 * Deliberately approximate rather than a real parser: this greps for the
 * call-site pattern (`fetch(`, `apiFetch(`, `apiRequest(`, `publicPost(`
 * followed by a string or template literal starting with `/`) rather than
 * type-checking the whole app. That is enough to catch the exact failure
 * mode all three prior incidents shared — a NEW top-level path segment with
 * NO proxy entry at all — without needing to resolve every dynamic URL.
 */

const WEB_ROOT = join(import.meta.dir, "../..");
const SRC_ROOT = join(WEB_ROOT, "src");
const VITE_CONFIG_PATH = join(WEB_ROOT, "vite.config.ts");

/** Every `*.ts` / `*.tsx` under `apps/web/src`, excluding tests and this file itself. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry)) return [];
    if (/\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

/**
 * `fetch(`, `apiFetch(`/`apiFetch<T>(`, `apiRequest(`, `publicPost(`,
 * `publicGet(` — the network call sites this app reaches through (see
 * `user/apiClient.ts`, which defines `apiFetch`/`apiRequest` in terms of a
 * bare `fetch`). Retire-telegram Task 1 deleted `dashboard/apiClient.ts` and
 * `api.ts`'s own direct-`fetch` public-checkout functions along with the
 * rest of the old creator dashboard — `user/apiClient.ts` is the only
 * definer of `apiFetch`/`apiRequest` left in the tree.
 * `publicGet` (Task 5, review round 2 — Important 4) backs every public GET
 * `apiClient.ts` makes for following/Jelajah (`listFollowers`,
 * `listFollowing`, `exploreUsers`) — omitting it here left this guard blind
 * to that entire family: pointing one of those three at an unproxied prefix
 * still reported every check green, exactly the failure mode this file
 * exists to catch. Captures the literal path argument — a plain string or a
 * template literal — and deliberately does NOT match a bare identifier
 * (`fetch(url, init)` in `user/whip-publisher.ts` is exactly that: an
 * absolute URL handed in from elsewhere, not a same-origin app path, and
 * has nothing here to proxy).
 */
const CALL_SITE =
  /\b(?:fetch|apiFetch|apiRequest|publicPost|publicGet)(?:<[^>()]*>)?\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

/** Strips the call site's quotes/backticks and truncates a template literal at its first `${`. */
function literalPath(raw: string): string | null {
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  const path = quote === "`" ? inner.split("${")[0] : inner;
  return path.startsWith("/") ? path : null;
}

/** The first path segment — `/users` from `/users/${handle}/posts`. */
function firstSegment(path: string): string {
  const match = /^\/[^/]+/.exec(path);
  return match ? match[0] : path;
}

/** Every distinct first-segment path prefix this app's source actually fetches. */
function fetchedPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(CALL_SITE)) {
      const path = literalPath(m[1]);
      if (path === null) continue;
      prefixes.add(firstSegment(path));
    }
  }
  return prefixes;
}

/**
 * `vite.config.ts`'s `proxy` table keys, read as TEXT rather than imported —
 * importing the real config would execute `@vitejs/plugin-react()` for no
 * benefit here, and every entry this file has ever had is a simple
 * `"key": "http://..."` or `"key": { target: "http://...", ... }` line,
 * which a plain grep finds reliably. Restricted to lines whose VALUE starts
 * an object or an `"http` string, so this cannot accidentally match a
 * quoted path mentioned only in a comment (this file has several, e.g.
 * `` `/users/...` `` — backtick-quoted, not double-quoted, so it never
 * matches this pattern regardless).
 */
const PROXY_ENTRY = /^\s*"(\^?\/[^"]+)"\s*:\s*(?:\{|"http)/gm;

function proxyKeys(): string[] {
  const source = readFileSync(VITE_CONFIG_PATH, "utf8");
  return [...source.matchAll(PROXY_ENTRY)].map((m) => m[1]);
}

/**
 * Whether some proxy key would forward a request for `prefix`. A `^`-led
 * key is the regex form `vite.config.ts` uses for its segment-precise entry
 * (`^/users/`, the only one left after retire-telegram Task 4 removed
 * `^/c/`); tested against `prefix + "/"` so `^/users/` matches the derived
 * prefix `/users` the same way it matches a real request to
 * `/users/by-handle/wildan`. A plain key is the string form every other entry
 * uses, matched by exact equality — every derived prefix here is already
 * reduced to a single leading path segment, which is exactly the shape those
 * keys are written in (`/auth`, `/payment-account`, `/streams`, …).
 */
function isCovered(prefix: string, keys: string[]): boolean {
  return keys.some((key) =>
    key.startsWith("^") ? new RegExp(key).test(`${prefix}/`) : key === prefix
  );
}

/**
 * THE OTHER DIRECTION, and the blind spot this file shipped with (found by
 * retire-telegram Task 7's sweep). Every check above asks "does each prefix
 * the app FETCHES have an entry?" — nothing asked whether each ENTRY still
 * forwards something. So when Task 3 deleted the streaming pages and Task 4
 * deleted `/communities`, `/ai` and `^/c/`, FOUR proxy entries went stale
 * pointing at API paths that no longer existed and this file stayed green
 * through all of it. A stale entry is much less dangerous than a missing one
 * (it forwards a request nobody makes), but it is a dangling reference in an
 * executable file, and the whole reason this guard exists is that dead entries
 * here are invisible to every other check in the repo.
 *
 * The rule: every proxy key must be a prefix this app actually fetches, OR be
 * listed below with a reason. `/streaming` would have failed it the moment
 * `StreamingPage` was deleted, because the deletion removed its last caller.
 *
 * DELIBERATELY AN ALLOW-LIST OF KEYS, NOT OF REASONS: adding an entry the app
 * never calls costs a line here and a sentence saying why, which is exactly
 * the friction that keeps a stale one from being re-justified in passing.
 */
const NOT_FETCHED_BY_THIS_APP: Record<string, string> = {
  // apps/api's `/webhooks` — Xendit calls it from the internet, never this
  // app. Proxied so a webhook can be replayed against the dev origin by hand
  // (`curl localhost:5173/webhooks/...`) instead of remembering :3000.
  "/webhooks": "inbound provider callbacks; no browser caller by design",
  // `/auth` (creator signup/login) and `/payment-account` (creator payout
  // setup) are the OLD creator world's API. Retire-telegram deleted every page
  // that called them; the ROUTES survive because the `creator` table does —
  // migrating those rows into `app_user` is explicitly out of scope for the
  // phase (design spec §9). These two entries are the honest record of that:
  // API surface with no surviving web caller, kept reachable rather than
  // silently unproxied, and due to go with the routes themselves.
  "/auth": "creator-world API kept until `creator` rows are migrated (spec §9)",
  "/payment-account": "creator-world API kept until `creator` rows are migrated (spec §9)",
};

/** Whether `key` forwards something this app fetches, or is an accounted-for exception. */
function isJustified(key: string, prefixes: Set<string>): boolean {
  if (key in NOT_FETCHED_BY_THIS_APP) return true;
  return [...prefixes].some((prefix) =>
    key.startsWith("^") ? new RegExp(key).test(`${prefix}/`) : key === prefix
  );
}

describe("vite proxy coverage", () => {
  it("has a proxy entry for every path prefix this app actually fetches", () => {
    const keys = proxyKeys();
    const uncovered = [...fetchedPrefixes()]
      .filter((prefix) => !isCovered(prefix, keys))
      .sort();

    // Printed as strings: an uncovered prefix here is exactly the failure
    // mode that hid a dead `/users/*` surface for the whole of this phase.
    expect(uncovered).toEqual([]);
  });

  it("actually finds SOME prefixes, and /users is one of them — guards the guard", () => {
    // If the extraction regexes above were ever loosened into matching
    // nothing, the test above would pass vacuously. Pinning that `/users`
    // specifically is found keeps this tied to the incident that motivated
    // it (Task 6's missing `^/users/` entry).
    //
    // Retire-telegram Task 1: this threshold used to be `> 3` — it counted
    // every prefix `api.ts` and `dashboard/apiClient.ts` reached (`/c`,
    // `/auth`, `/communities`, `/payment-account`, …) before Phase 8 deleted
    // both files along with every screen that called them. `/users` and
    // `/streams` are the only two fetch families left in the surviving
    // `apps/web/src` tree, so `> 1` is what "finds more than one real
    // prefix, not just a coincidental single match" now means — still a
    // guard against the extraction matching nothing or matching only one
    // degenerate case.
    const prefixes = fetchedPrefixes();
    expect(prefixes.size).toBeGreaterThan(1);
    expect(prefixes.has("/users")).toBe(true);
  });

  it("has no proxy entry that forwards nothing — every key is fetched by this app or listed as an exception", () => {
    const prefixes = fetchedPrefixes();
    const unjustified = proxyKeys()
      .filter((key) => !isJustified(key, prefixes))
      .sort();

    // Printed as strings: a key here is an entry pointing at an API path this
    // app stopped calling — the state `/streaming` sat in, unreported, from
    // Task 3 until Task 4 happened to remove it.
    expect(unjustified).toEqual([]);
  });

  it("detects a stale proxy entry — the mutation the reverse check exists to catch", () => {
    // Simulates `/streaming` still being in the table after the pages that
    // fetched it were deleted: a key that is neither fetched nor excepted.
    // Run against the same `isJustified` the test above uses, so this pins the
    // real logic rather than a restatement of it.
    expect(isJustified("/streaming", fetchedPrefixes())).toBe(false);
    // And the exception list is what makes the three real ones pass — not a
    // loophole in the matching. Deleting `/webhooks` from
    // `NOT_FETCHED_BY_THIS_APP` must turn the check above red; this asserts the
    // half of that which a test can assert without editing itself.
    expect("/webhooks" in NOT_FETCHED_BY_THIS_APP).toBe(true);
    expect(isJustified("/webhooks", new Set(["/users", "/streams"]))).toBe(true);
  });

  it("detects an uncovered prefix when a proxy entry is missing — the mutation this test exists to catch", () => {
    // Simulates removing `^/users/` from vite.config.ts without touching
    // the real file: the same matching logic the first test uses, run
    // against the real key list minus that one entry. `bun run test`
    // (never bare `bun test`) was also run against the ACTUAL file with
    // `^/users/` deleted by hand, restored immediately after, to confirm
    // the real config wiring — not just this simulation — fails too.
    const keysWithoutUsers = proxyKeys().filter((key) => key !== "^/users/");
    expect(isCovered("/users", keysWithoutUsers)).toBe(false);
  });
});
