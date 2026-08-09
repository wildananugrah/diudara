/**
 * How often the worker looks for outbox rows when nothing configures it.
 *
 * Five seconds is the delay a paying member sees between their payment settling
 * and their invite arriving, so it wants to be small; every tick is also a query
 * against the outbox's `(status, next_attempt_at)` index, so it does not want to
 * be a busy loop. Five is comfortably inside "felt instant" for a WhatsApp
 * message and is 12 queries a minute.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface PollLoopOptions {
  /** One pass. Must not be called again until the previous one settles. */
  poll: () => Promise<void>;
  intervalMs: number;
  /**
   * Where a failed pass goes. A pass that throws must NOT end the process: the
   * rows are still in the outbox and the next pass is their retry.
   */
  onError?: (err: unknown) => void;
}

/**
 * Runs `poll` on an interval until `stop()` is called.
 *
 * Two properties matter and both are pinned by tests:
 *
 *  - Passes never overlap. `await poll()` completes before the next interval
 *    starts, so a slow pass cannot have two batches in flight and double the
 *    concurrency `batchSize` exists to bound.
 *  - `stop()` wakes the loop immediately rather than letting the interval expire.
 *    A container gets a few seconds between SIGTERM and SIGKILL, and a worker
 *    asleep in a long interval would be killed instead of exiting.
 */
export class PollLoop {
  private stopped = false;
  /** Resolves the in-progress interval wait, if there is one. */
  private wake: (() => void) | null = null;

  constructor(private readonly options: PollLoopOptions) {}

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.options.poll();
      } catch (err) {
        if (this.options.onError) {
          this.options.onError(err);
        } else {
          console.error("[worker] poll failed:", err instanceof Error ? err.message : err);
        }
      }

      // Checked again after the pass: `stop()` may have arrived while it ran, and
      // sleeping first would delay the exit by a whole interval.
      if (this.stopped) break;
      await this.waitForNextTick();
    }
  }

  stop(): void {
    this.stopped = true;
    const wake = this.wake;
    this.wake = null;
    // Clearing the timer AND resolving: an outstanding timer keeps Bun's event
    // loop alive, so the process would linger after the loop had finished.
    if (wake) wake();
  }

  private waitForNextTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.options.intervalMs);

      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/**
 * Stops every given loop on SIGTERM (what an orchestrator sends) and SIGINT (Ctrl-C).
 *
 * VARIADIC since Phase 5: this process now runs three loops — the outbox, renewals
 * and churn — and a signal must stop all of them. Installing it once per loop would
 * work but would print the shutdown line once per loop and add three listeners where
 * one will do; more to the point, ONE handler means there is no ordering in which
 * some loops are stopped and others are not.
 *
 * Returns an uninstaller, which is not ceremony: without it the listeners
 * outlive the loop, and a test that installed them would leave a handler
 * attached to the whole test process.
 */
export function installShutdownSignals(...loops: PollLoop[]): () => void {
  const handle = (signal: string) => () => {
    console.log(`[worker] ${signal} received — finishing the current pass, then exiting`);
    for (const loop of loops) loop.stop();
  };
  const onTerm = handle("SIGTERM");
  const onInt = handle("SIGINT");

  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}

/**
 * Reads one interval variable, refusing anything that is not a usable interval.
 *
 * Fails CLOSED, like every other configuration guard in this codebase: `Number()`
 * turns a typo into `NaN`, `setTimeout` treats `NaN` as `0`, and the result is a
 * worker hammering the database as fast as it can answer rather than polling it.
 * A blank value counts as unset (`WORKER_POLL_INTERVAL_MS=` in a .env file
 * arrives as `""`).
 *
 * Shared rather than copied because Phase 5 added a SECOND interval — the renewal
 * and churn cadence — and the `NaN`-becomes-a-busy-loop trap is identical for it.
 * The variable's name is a parameter so the error still names the one the operator
 * actually set.
 */
export function resolveIntervalMs(
  raw: string | undefined,
  options: { variableName: string; defaultMs: number }
): number {
  if (raw === undefined || raw.trim() === "") {
    return options.defaultMs;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${options.variableName} must be a positive whole number of milliseconds ` +
        `(got "${raw}"). Leave it unset for the default of ${options.defaultMs}ms.`
    );
  }
  return parsed;
}

/** Reads `WORKER_POLL_INTERVAL_MS` — how often the OUTBOX is polled. */
export function resolvePollIntervalMs(raw: string | undefined): number {
  return resolveIntervalMs(raw, {
    variableName: "WORKER_POLL_INTERVAL_MS",
    defaultMs: DEFAULT_POLL_INTERVAL_MS,
  });
}
