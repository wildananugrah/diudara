import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import type { Dependencies } from "../bootstrap";

/**
 * Every API route must be reachable through the production nginx.
 *
 * THE INCIDENT THIS EXISTS FOR (2026-08-26): `POST /streams` answered **405
 * Not Allowed** from nginx in production. The live config carried a
 * `location /streaming` — an older path that no longer exists — and none for
 * `/streams`, so every Siaran call fell through to the SPA fallback. `GET`
 * returned index.html instead of JSON ("Tidak dapat menghubungi server") and
 * `POST` hit nginx's static handler, which refuses non-GET methods. Live
 * streaming had never once worked in production and nothing failed anywhere.
 *
 * The two names never overlap, which is exactly why it survived review:
 * "/streaming"[7] is 'i', "/streams"[7] is 's'.
 *
 * This is the fourth time a missing proxy entry has broken this project —
 * `apps/web/src/test/vite-proxy-coverage.test.ts` was written after the third,
 * for the DEV proxy, and its docstring lists the other three. This is the same
 * guard for the deployed one.
 *
 * WHAT IT CANNOT DO, and the limit matters: it compares the repo's
 * `infra/nginx/api-proxy.conf.template` against the API's route table. It
 * cannot read /etc/nginx, cannot reach the server, and cannot know whether the
 * template was ever pasted there. A green run means the repo is self-consistent
 * — nothing more. After changing the template: paste it, `sudo nginx -t`, then
 * `sudo systemctl reload nginx`.
 */

const TEMPLATE_PATH = join(import.meta.dir, "../../../../infra/nginx/api-proxy.conf.template");

/** `location ^~ /streams {` -> `/streams`. Ignores `=` exact and `~` regex forms. */
function proxiedPrefixes(conf: string): string[] {
  return [...conf.matchAll(/^\s*location\s+(?:\^~\s+)?(\/[^\s{]*)\s*\{/gm)].map((m) => m[1]!);
}

/** The paths the template names as deliberately unreachable from the internet. */
function notExposed(conf: string): string[] {
  const line = /nginx-proxy-coverage:\s*not-exposed\s*=\s*(.+)$/m.exec(conf);
  return line === null ? [] : line[1]!.split(",").map((s) => s.trim()).filter(Boolean);
}

/** `/users/media/:id/thumb` -> `/users`. The unit an nginx prefix location matches on. */
function firstSegment(path: string): string {
  const segment = path.split("/")[1] ?? "";
  return `/${segment}`;
}

function registeredPaths(): string[] {
  const app = createApp({} as Dependencies);
  return [...new Set(app.routes.map((route) => route.path))];
}

describe("every API route is reachable through the production nginx", () => {
  it("has a proxy location, or an explicit not-exposed note, for every route's first segment", () => {
    const conf = readFileSync(TEMPLATE_PATH, "utf8");
    const covered = proxiedPrefixes(conf);
    const exempt = notExposed(conf);

    const uncovered = [...new Set(registeredPaths().map(firstSegment))]
      .filter((segment) => !exempt.includes(segment))
      .filter((segment) => !covered.some((prefix) => segment.startsWith(prefix.replace(/\/$/, ""))))
      .sort();

    // Named, not counted: a failure has to say WHICH segment nobody proxies,
    // because the whole failure mode is not noticing one.
    expect(uncovered.join(", ")).toBe("");
  });

  /**
   * The control. Without it the assertion above passes against a template that
   * proxies `/` — or against a parser that silently matched nothing and
   * compared two empty lists.
   */
  it("does not consider a made-up segment covered", () => {
    const conf = readFileSync(TEMPLATE_PATH, "utf8");
    const covered = proxiedPrefixes(conf);

    expect(covered.length).toBeGreaterThan(0);
    expect(covered.some((prefix) => "/tidak-ada".startsWith(prefix.replace(/\/$/, "")))).toBe(false);
  });
});
