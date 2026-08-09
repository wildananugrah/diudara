import type { ClockPort } from "../../application/ports/clock.port";

/**
 * The production clock: the machine's wall time.
 *
 * `new Date()` is already a fresh object, so it satisfies the port's copy
 * requirement by construction — there is no shared instant to hand out.
 *
 * This adapter is the ONLY place in the renewal paths that reads real time. That is
 * what makes it substitutable, and it is why it holds no logic worth testing beyond
 * "it returns the current instant".
 */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
