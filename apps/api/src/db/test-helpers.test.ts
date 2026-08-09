import { describe, expect, it } from "bun:test";
import { resetDatabase } from "./test-helpers";

/**
 * Sets environment variables and returns a function that puts every one of them back
 * EXACTLY as it was — deleted if it was unset, and its own value if it was set.
 *
 * Written as a helper because doing it by hand got it wrong, in a way that took a
 * whole isolation proof to notice: `process.env.X = original` when `original` is
 * `undefined` does not unset `X`, and a `delete` in a `finally` block turned a run
 * started with `DIUDARA_TEST_DB_ISOLATION=off` into a run where it was suddenly on —
 * which cascaded into 442 failures in files that ran AFTER this one, and looked for all
 * the world like the shared-database interference the same session was measuring.
 * Process-wide state restored approximately is process-wide state not restored.
 */
function overrideEnv(values: Record<string, string | undefined>): () => void {
  const originals = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, original] of originals) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

/**
 * These assertions must be awaited. An un-awaited `expect(...).rejects` passes
 * vacuously, which would make this suite green even with the guard deleted —
 * i.e. it would test nothing.
 */
describe("resetDatabase() environment guard", () => {
  it("runs under `bun test`, which sets NODE_ENV to 'test'", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    await resetDatabase();
  });

  it("refuses to run when NODE_ENV is 'production'", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(resetDatabase()).rejects.toThrow(/refused: NODE_ENV is not 'test'/);
    } finally {
      process.env.NODE_ENV = original;
    }
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("refuses to run when NODE_ENV is unset", async () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await expect(resetDatabase()).rejects.toThrow(/refused: NODE_ENV is not 'test'/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("refuses to run when the per-run database was never created", async () => {
    // The dangerous case this guard exists for: DATABASE_URL is set in the real
    // environment and the preload did NOT run, so `resetDatabase()` is about to
    // truncate every table of whatever it points at — normally the developer's own
    // `diudara`. Before Task 8 that is exactly what happened, silently.
    const restore = overrideEnv({
      DIUDARA_TEST_DB_ISOLATION: undefined,
      DIUDARA_TEST_DATABASE: undefined,
    });
    try {
      await expect(resetDatabase()).rejects.toThrow(/preload/);
    } finally {
      restore();
    }
    // And it is back to normal afterwards, so the rest of the file is unaffected.
    await resetDatabase();
  });

  it("allows a deliberately un-isolated run, which is what the switch is for", async () => {
    const restore = overrideEnv({
      DIUDARA_TEST_DB_ISOLATION: "off",
      DIUDARA_TEST_DATABASE: undefined,
    });
    try {
      // No throw: somebody who turned isolation off has said they know which database
      // they are truncating.
      await resetDatabase();
    } finally {
      restore();
    }
  });
});
