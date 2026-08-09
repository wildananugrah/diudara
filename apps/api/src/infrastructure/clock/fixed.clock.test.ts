import { describe, expect, it } from "bun:test";
import { FixedClock } from "./fixed.clock";

const START = new Date("2026-03-09T17:00:00.000Z");

describe("FixedClock", () => {
  it("reports the instant it was constructed with, not the wall clock", () => {
    const clock = new FixedClock(START);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it("moves to whatever set() is given", () => {
    const clock = new FixedClock(START);
    clock.set(new Date("2026-04-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("advances by whole milliseconds", () => {
    const clock = new FixedClock(START);
    clock.advance(86_400_000);
    expect(clock.now().toISOString()).toBe("2026-03-10T17:00:00.000Z");
  });

  it("advances cumulatively, and accepts a negative step to rewind", () => {
    const clock = new FixedClock(START);
    clock.advance(1_000);
    clock.advance(2_000);
    expect(clock.now().getTime()).toBe(START.getTime() + 3_000);
    clock.advance(-3_000);
    expect(clock.now().getTime()).toBe(START.getTime());
  });

  /**
   * `now()` must hand back a COPY. Date is mutable, so a caller that does
   * `const d = clock.now(); d.setDate(d.getDate() + 3)` — exactly the shape of
   * "compute the grace deadline" — would otherwise move the clock three days for
   * every later reader, and a schedule test would silently assert against a time
   * nobody set.
   */
  it("returns a copy, so a caller mutating the result cannot move the clock", () => {
    const clock = new FixedClock(START);
    const first = clock.now();
    first.setTime(first.getTime() + 30 * 86_400_000);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it("returns a distinct object on each call", () => {
    const clock = new FixedClock(START);
    expect(clock.now()).not.toBe(clock.now());
  });

  /**
   * The same reasoning applied to the INPUTS: a caller that keeps and later mutates
   * the Date it passed in must not be able to move the clock through that reference.
   */
  it("copies the date given to the constructor", () => {
    const seed = new Date(START.getTime());
    const clock = new FixedClock(seed);
    seed.setTime(seed.getTime() + 86_400_000);
    expect(clock.now().toISOString()).toBe(START.toISOString());
  });

  it("copies the date given to set()", () => {
    const clock = new FixedClock(START);
    const target = new Date("2026-04-01T00:00:00.000Z");
    clock.set(target);
    target.setTime(target.getTime() + 86_400_000);
    expect(clock.now().toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});
