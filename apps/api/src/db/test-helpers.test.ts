import { describe, expect, it } from "bun:test";
import { resetDatabase } from "./test-helpers";

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
});
