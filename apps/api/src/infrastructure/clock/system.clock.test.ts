import { describe, expect, it } from "bun:test";
import { SystemClock } from "./system.clock";

describe("SystemClock", () => {
  it("reports the current instant", () => {
    const before = Date.now();
    const observed = new SystemClock().now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it("returns a distinct object each call, so a mutating caller cannot affect another", () => {
    const clock = new SystemClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});
