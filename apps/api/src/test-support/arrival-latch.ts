/**
 * A rendezvous latch: every caller blocks until `expected` callers have ARRIVED at
 * the same point, and then all of them proceed.
 *
 * IT EXISTS SO A CONCURRENCY TEST CANNOT PASS VACUOUSLY. A bare `Promise.all` of two
 * `execute()` calls does not construct an interleaving; it merely hopes for one, and
 * in this project that hope has produced a false pass three times — most memorably in
 * Phase 4, where two "concurrent" grants happened to serialise and the test proved
 * nothing about the two live invite links the code was leaking. A fixed `setTimeout`
 * barrier is no better: it releases whichever way the race went, so on a slow database
 * the second caller may not have arrived at all.
 *
 * The release here is CAUSED by the other callers' arrival and by nothing else, which
 * is what makes it evidence:
 *
 *   - `arriveAndWait()` announces this caller and then blocks until the count is
 *     reached, so on return EVERY caller is demonstrably at the same point.
 *   - `wait()` REJECTS on its safety timeout rather than resolving. A resolve would be
 *     exactly the vacuous pass this class removes; a rejection fails the test and says
 *     how many callers actually turned up. The timeout is a deadlock detector, never
 *     part of the timing under test, so it is deliberately generous.
 *
 * It is in `src/` rather than inside one test file because two test files need the
 * same guarantee (the `recordIfNew` conflict clause at the repository level, and two
 * whole `ProcessRenewals` passes at the use-case level), and a second copy of a
 * subtle test instrument is a second chance to weaken it.
 */
export class ArrivalLatch {
  private arrivals = 0;
  private waiters: (() => void)[] = [];

  constructor(
    /** How many callers must arrive before any of them proceeds. */
    private readonly expected: number,
    /** Deadlock detector only. Generous on purpose — see the class docstring. */
    private readonly timeoutMs = 5_000
  ) {}

  /** How many callers have arrived so far. */
  get arrived(): number {
    return this.arrivals;
  }

  /**
   * The rendezvous itself: announce this caller, then block until the rest arrive.
   * On return, every one of the `expected` callers is at this line.
   */
  async arriveAndWait(): Promise<void> {
    this.arrive();
    await this.wait();
  }

  /** Announce a caller without blocking. */
  arrive(): void {
    this.arrivals += 1;
    if (this.arrivals >= this.expected) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
  }

  /** Blocks until `expected` callers have arrived; REJECTS if they never do. */
  wait(): Promise<void> {
    if (this.arrivals >= this.expected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `ArrivalLatch: only ${this.arrivals} of ${this.expected} callers arrived within ` +
              `${this.timeoutMs}ms — the interleaving under test never happened, so a pass ` +
              "would have been vacuous"
          )
        );
      }, this.timeoutMs);
      this.waiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
