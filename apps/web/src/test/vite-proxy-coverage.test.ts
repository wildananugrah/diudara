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
 * `fetch(`, `apiFetch(`/`apiFetch<T>(`, `apiRequest(`, `publicPost(` — the
 * four call sites this app ever reaches the network through (see
 * `user/apiClient.ts` and `dashboard/apiClient.ts`, which both define
 * `apiFetch`/`apiRequest` in terms of a bare `fetch`, and `api.ts`'s own
 * direct `fetch` calls for the public checkout surface). Captures the
 * literal path argument — a plain string or a template literal — and
 * deliberately does NOT match a bare identifier (`fetch(url, init)` in
 * `dashboard/whip-publisher.ts` is exactly that: an absolute URL handed in
 * from elsewhere, not a same-origin app path, and has nothing here to
 * proxy).
 */
const CALL_SITE = /\b(?:fetch|apiFetch|apiRequest|publicPost)(?:<[^>()]*>)?\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

/** Strips the call site's quotes/backticks and truncates a template literal at its first `${`. */
function literalPath(raw: string): string | null {
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  const path = quote === "`" ? inner.split("${")[0] : inner;
  return path.startsWith("/") ? path : null;
}

/** The first path segment — `/communities` from `/communities/${id}/members.csv`. */
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
 * `` `/c/some-slug` `` — backtick-quoted, not double-quoted, so it never
 * matches this pattern regardless).
 */
const PROXY_ENTRY = /^\s*"(\^?\/[^"]+)"\s*:\s*(?:\{|"http)/gm;

function proxyKeys(): string[] {
  const source = readFileSync(VITE_CONFIG_PATH, "utf8");
  return [...source.matchAll(PROXY_ENTRY)].map((m) => m[1]);
}

/**
 * Whether some proxy key would forward a request for `prefix`. A `^`-led
 * key is the regex form `vite.config.ts` uses for the three segment-precise
 * entries (`^/c/`, `^/users/`); tested against `prefix + "/"` so `^/c/`
 * matches the derived prefix `/c` the same way it matches a real request to
 * `/c/some-slug`. A plain key is the string form every other entry uses,
 * matched by exact equality — every derived prefix here is already reduced
 * to a single leading path segment, which is exactly the shape those keys
 * are written in (`/auth`, `/communities`, `/ai`, …).
 */
function isCovered(prefix: string, keys: string[]): boolean {
  return keys.some((key) =>
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
    const prefixes = fetchedPrefixes();
    expect(prefixes.size).toBeGreaterThan(3);
    expect(prefixes.has("/users")).toBe(true);
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
