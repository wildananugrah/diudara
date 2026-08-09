import type { ClockPort } from "../../application/ports/clock.port";

/**
 * A clock a test drives by hand.
 *
 * Holds an instant as a number of milliseconds rather than a `Date`, which is what
 * makes the copying guarantees below unmissable: there is no internal Date object
 * for a caller to reach.
 *
 * `set` and `advance` are separate on purpose. `set` places the instant absolutely,
 * which is how a test lands on a named boundary (00:30 WIB on the due date).
 * `advance` moves it relatively, which is how a test walks a subscription through
 * `pre_3d` → `due` → `overdue_7d` without recomputing dates.
 */
export class FixedClock implements ClockPort {
  private instantMs: number;

  constructor(instant: Date) {
    // Read the number out immediately, so a caller that keeps and later mutates the
    // Date it passed in cannot move the clock through that reference.
    this.instantMs = instant.getTime();
  }

  /**
   * A NEW Date on every call.
   *
   * Not a convenience. `Date` is mutable, and the natural way to compute a deadline
   * from the current time is `const d = clock.now(); d.setDate(d.getDate() + 7)`.
   * Handing out a shared instance would let that quietly move the clock seven days
   * for every later reader — a test would then assert against a time nobody set,
   * and pass or fail for reasons unrelated to the code under test.
   */
  now(): Date {
    return new Date(this.instantMs);
  }

  /** Places the clock at `instant` absolutely. The argument is copied, not held. */
  set(instant: Date): void {
    this.instantMs = instant.getTime();
  }

  /**
   * Moves the clock by `ms`. Negative rewinds, which a test needs to check that a
   * reminder is NOT sent early after having checked that it is sent on time.
   */
  advance(ms: number): void {
    this.instantMs += ms;
  }
}
