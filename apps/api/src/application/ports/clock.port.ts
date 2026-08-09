/**
 * The current time, as a dependency.
 *
 * Every phase before this one was triggered by an HTTP request, so "now" was
 * whatever the request happened to arrive at and reading `Date.now()` in place was
 * harmless. Phase 5 is triggered by a CLOCK: what a use-case does depends entirely
 * on where the current instant falls relative to a due date and a grace deadline.
 * A use-case that reads `Date.now()` itself cannot be tested at those boundaries —
 * and the boundaries (WIB midnight, the grace deadline) are exactly where a member
 * either keeps or loses their access.
 *
 * So time is INJECTED, never read inside a use-case. Production passes
 * `SystemClock`; tests pass `FixedClock` and place the instant deliberately.
 *
 * `now()` MUST return a Date the caller may freely mutate — implementations hand
 * back a copy. `Date` is mutable, and a caller doing
 * `const d = clock.now(); d.setDate(d.getDate() + 7)` to reach a deadline would
 * otherwise move the clock for every later reader.
 */
export interface ClockPort {
  now(): Date;
}
