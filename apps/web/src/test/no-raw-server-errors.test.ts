import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **No screen may print the server's own error string.**
 *
 * This project has now fixed the same defect four times in four files and, each
 * time, closed the instance rather than the class:
 *
 * | round | file | what reached the screen |
 * |---|---|---|
 * | item 5 | `JelajahPage.tsx` | `"invalid query: q must be at most 100 characters, ..."` |
 * | item 7 | `FollowButton.tsx` | whatever `readError` lifted, incl. `"user not found"` |
 * | re-review N1 | `FollowListPage.tsx` | `"internal server error"` on a 500 |
 * | re-review N1 | `ProfilePage.tsx` | `"Failed to fetch"` on a network drop |
 *
 * The last two were still broken AFTER two rounds that fixed exactly this
 * pattern, in a file one of those rounds had edited twice. "All copy in Bahasa
 * Indonesia" is a binding ledger ruling, and the mechanism defeating it was
 * always the same single line:
 *
 *     setLoad({ status: "error", message: err instanceof Error ? err.message : "..." })
 *
 * So this stops being a thing anyone has to remember. `describeRequestFailure`
 * in `user/errorCopy.ts` is the one path a failure becomes readable text
 * through, and it chooses that text from the failure's SHAPE — never from its
 * text, which is exactly what cannot be trusted.
 *
 * **Scope: `apps/web/src/user/`.** That is the member-facing app this phase owns
 * and where Phase 3's new screens will land. `apps/web/src/dashboard/` is
 * deliberately NOT scanned: the UI spec (§6) forbids touching it until Phase 8
 * deletes it, and it has ~15 of these call sites. Extending this guard there
 * would mean editing a surface this phase is not allowed to edit. Recorded here
 * so the exclusion is a decision rather than an oversight.
 *
 * **What it detects:** reading `.message` off a value bound by `catch` — either
 * form, `} catch (err) {` or `.catch((err: unknown) => ...)`. It matches on the
 * binding's real name, so renaming the variable does not evade it, and it does
 * NOT match unrelated `.message` reads such as a component's own
 * `load.message` state field (which holds copy this module produced, and is
 * fine to render).
 */

const USER_ROOT = join(import.meta.dir, "../user");

/** Every non-test `*.ts` / `*.tsx` under `apps/web/src/user`. */
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
 * Comments are removed before anything below looks at the source.
 *
 * Without this the guard flags its own documentation: every fix for this rule
 * naturally writes "NEVER `err.message`" in a comment next to the `catch (err)`
 * it just fixed, and a text scan cannot tell that from the real thing — which is
 * exactly what happened on the first run here, with `ProfilePage.tsx` and
 * `LoginPage.tsx` reported as offenders on the strength of the comments
 * explaining why they no longer were. `no-hanging-dom-assertions.test.ts` beside
 * this file solves the same problem by skipping itself; that does not work here,
 * because the files being scanned are the ones that need to quote the pattern.
 *
 * Deliberately approximate, like the other guards in this directory: it does not
 * understand a `//` inside a string literal. No file under `src/user` contains
 * one today, and the failure mode is a false NEGATIVE on a line that would have
 * to be contrived on purpose.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** `} catch (err) {` — a statement-form catch binding. */
const STATEMENT_CATCH = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
/** `.catch((err: unknown) => ...)` — a callback-form catch binding. */
const CALLBACK_CATCH = /\.catch\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)?\s*=>/g;

/** Every name bound by a `catch` in `source`, either form. */
export function caughtBindings(source: string): string[] {
  const code = stripComments(source);
  const names = new Set<string>();
  for (const match of code.matchAll(STATEMENT_CATCH)) names.add(match[1]!);
  for (const match of code.matchAll(CALLBACK_CATCH)) names.add(match[1]!);
  return [...names];
}

/** Whether `source` reads `.message` off anything a `catch` bound. */
export function readsMessageOffACaughtError(source: string): boolean {
  const code = stripComments(source);
  return caughtBindings(code).some((name) =>
    new RegExp(`\\b${name}\\s*\\.\\s*message\\b`).test(code)
  );
}

describe("no raw server errors reach a member-facing screen", () => {
  it("no file under src/user reads .message off a caught error", () => {
    const offenders = sourceFiles(USER_ROOT)
      .filter((file) => readsMessageOffACaughtError(readFileSync(file, "utf8")))
      .map((file) => file.slice(USER_ROOT.length + 1))
      .sort();

    // Printed as file names, so this fails in milliseconds and names the file.
    // The fix is always the same: compose your own Bahasa context sentence and
    // append `describeRequestFailure(err)` from `user/errorCopy.ts`.
    expect(offenders).toEqual([]);
  });

  it("detects the hazardous pattern in both catch forms — guards the guard", () => {
    // Without this, a regex loosened into matching nothing would make the test
    // above pass vacuously — which is how the `no-hanging-dom-assertions` guard
    // beside this one is built, and for the same reason.
    const statementForm = `try { go(); } catch (err) { setMessage(err.message); }`;
    expect(readsMessageOffACaughtError(statementForm)).toBe(true);

    const callbackForm = `load().catch((err: unknown) => setError(err.message));`;
    expect(readsMessageOffACaughtError(callbackForm)).toBe(true);

    // The real shape that shipped four times, verbatim.
    const shipped = `.catch((err: unknown) => { setLoad({ status: "error", message: err instanceof Error ? err.message : "gagal memuat profil" }); })`;
    expect(readsMessageOffACaughtError(shipped)).toBe(true);

    // Renaming the binding must not evade it.
    const renamed = `try { go(); } catch (problem) { setError(problem.message); }`;
    expect(readsMessageOffACaughtError(renamed)).toBe(true);
  });

  it("does NOT flag the pattern quoted in a COMMENT — see stripComments", () => {
    // The first run of this guard reported ProfilePage.tsx and LoginPage.tsx as
    // offenders purely because their fixes had documented themselves. A rule
    // whose own explanation violates it is unusable.
    const documented = [
      `// N1: NEVER err.message — that is the server's own string.`,
      `try { go(); } catch (err) { setError(describeRequestFailure(err)); }`,
    ].join("\n");
    expect(readsMessageOffACaughtError(documented)).toBe(false);

    const blockComment = `/** Do not write err.message here. */\ntry { go(); } catch (err) { setError(safe(err)); }`;
    expect(readsMessageOffACaughtError(blockComment)).toBe(false);

    // ...but code on the same line as a trailing comment is still code.
    const stillCaught = `try { go(); } catch (err) { setError(err.message); } // fix me`;
    expect(readsMessageOffACaughtError(stillCaught)).toBe(true);
  });

  it("does NOT flag a component's own .message state field — no false positive", () => {
    // `load.message` holds copy this app produced and is fine to render. A guard
    // that banned every `.message` would have forced these screens to rename
    // their own state instead of fixing what fills it.
    const ownState = `if (load.status === "error") return <p>{load.message}</p>;`;
    expect(readsMessageOffACaughtError(ownState)).toBe(false);

    // A catch that never touches the error is fine too.
    const discarded = `try { go(); } catch (err) { setError(describeRequestFailure(err)); }`;
    expect(readsMessageOffACaughtError(discarded)).toBe(false);
  });

  it("finds catch bindings at all in the real source — guards the guard", () => {
    // If `sourceFiles` or the binding regexes silently matched nothing, the
    // first test would be vacuous even with the detector working.
    const bindings = sourceFiles(USER_ROOT).flatMap((file) =>
      caughtBindings(readFileSync(file, "utf8"))
    );
    expect(bindings.length).toBeGreaterThan(5);
  });
});
