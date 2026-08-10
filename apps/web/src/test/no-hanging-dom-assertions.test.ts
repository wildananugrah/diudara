import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A failing `expect(<DOM element>).toBeNull()` does not fail — it HANGS.
 *
 * When the assertion passes, the value is `null` and nothing is serialised. When it
 * FAILS, Bun builds a failure diff by serialising the received value, and a happy-dom
 * `HTMLElement` serialises its listener maps, its parent chain and every internal
 * symbol, so the diff explodes.
 *
 * MEASURED in Task 8, by reverting one already-fixed assertion in
 * CommunityOverviewPage.test.tsx to the element form and making it fail:
 *
 *   bun test src/dashboard/pages/CommunityOverviewPage.test.tsx
 *   -> 178_223 ms for that ONE assertion, a 335 MB failure log
 *
 * The same mutation asserted as a COUNT reports in milliseconds and prints `0` vs `1`.
 *
 * Why this is worth a test of its own rather than a convention: the damage is not the
 * slowness, it is that the failure becomes INVISIBLE. A regression lands, CI stops
 * making progress with no output, and it reads as a stuck runner rather than a broken
 * test — so it gets retried instead of fixed. The safe form is to assert on a COUNT
 * (`queryAllBy…().length`), which serialises as a number.
 */

const TEST_ROOT = join(import.meta.dir, "..");

/** Every `*.test.ts` / `*.test.tsx` under apps/web/src. */
function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return testFiles(full);
    return /\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** `screen.getByRole(`, `queryAllByText(`, `within(x).findByLabelText(` — but NOT `getItem(`. */
const ELEMENT_QUERY = /\b(?:query|get|find)(?:All)?By[A-Z]\w*\s*\(/;

/**
 * Matchers that serialise the received value when they fail. `toBeNull` is the one
 * that bit us; the others fail identically because they too print what they got.
 */
const SERIALISING_MATCHER = /\.(?:toBeNull|toBeUndefined)\s*\(\s*\)|\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*(?:null|undefined|\[\s*\])\s*\)/;

describe("web test hygiene", () => {
  it("never hands a DOM element straight to a matcher that serialises it", () => {
    const offenders: string[] = [];

    for (const file of testFiles(TEST_ROOT)) {
      // This file quotes the hazardous pattern as a string literal, on purpose.
      if (file === import.meta.path) continue;
      const source = readFileSync(file, "utf8");
      // Statement-wise, so a query on one line and a matcher on an unrelated one
      // are not falsely paired.
      source.split(";").forEach((statement) => {
        if (!statement.includes("expect(")) return;
        if (!ELEMENT_QUERY.test(statement)) return;
        if (!SERIALISING_MATCHER.test(statement)) return;
        // `queryAllBy…().length` is the safe form: the received value is a number.
        if (/\)\s*\.length\b/.test(statement)) return;
        offenders.push(`${file.slice(TEST_ROOT.length + 1)}: ${statement.trim().split("\n").pop()}`);
      });
    }

    // Printed as strings, so THIS test fails in milliseconds even when it fails.
    expect(offenders).toEqual([]);
  });

  it("detects the hazardous pattern when it is present", () => {
    // Guards the guard: if ELEMENT_QUERY or SERIALISING_MATCHER were ever loosened
    // into something that matches nothing, the test above would pass vacuously.
    const hazardous = `expect(screen.queryByText(/Panel/)).toBeNull()`;
    expect(ELEMENT_QUERY.test(hazardous)).toBe(true);
    expect(SERIALISING_MATCHER.test(hazardous)).toBe(true);

    const safe = `expect(screen.queryAllByText(/Panel/).length).toBe(0)`;
    expect(/\)\s*\.length\b/.test(safe)).toBe(true);

    // A non-DOM `toBeNull` is legitimate and must not be flagged.
    const unrelated = `expect(localStorage.getItem("k")).toBeNull()`;
    expect(ELEMENT_QUERY.test(unrelated)).toBe(false);
  });
});
