import { describe, expect, it } from "bun:test";
import { installShutdownSignals, PollLoop, resolvePollIntervalMs } from "./poll-loop";

/**
 * These tests deliberately import ONLY this module. Nothing here touches the
 * database — `bun run --workspaces test` runs each workspace's script from its own
 * directory, so `apps/api/.env` is not loaded here and importing `main.ts` (which
 * reaches the composition root, and through it `db/client.ts`) would fail on a
 * missing DATABASE_URL rather than testing anything.
 */
describe("PollLoop", () => {
  it("polls repeatedly until it is stopped, and then resolves", async () => {
    let polls = 0;
    const loop = new PollLoop({
      intervalMs: 1,
      poll: async () => {
        polls += 1;
        if (polls === 3) loop.stop();
      },
    });

    await loop.run();

    expect(polls).toBe(3);
  });

  it("keeps polling after a poll throws", async () => {
    // A failing pass must not take the process down: the outbox rows are still
    // there, and the next pass is the retry.
    const errors: unknown[] = [];
    let polls = 0;
    const loop = new PollLoop({
      intervalMs: 1,
      onError: (err) => errors.push(err),
      poll: async () => {
        polls += 1;
        if (polls === 1) throw new Error("database was briefly unreachable");
        if (polls === 2) loop.stop();
      },
    });

    await loop.run();

    expect(polls).toBe(2);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("briefly unreachable");
  });

  it("wakes immediately when stopped mid-interval instead of waiting it out", async () => {
    // This is what "shuts down cleanly" means in practice: a container gets
    // ~10 seconds after SIGTERM, and a worker sleeping through a 60s interval
    // would be SIGKILLed instead of exiting.
    let polls = 0;
    const loop = new PollLoop({
      intervalMs: 60_000,
      poll: async () => {
        polls += 1;
      },
    });

    const running = loop.run();
    while (polls === 0) await Bun.sleep(1);
    loop.stop();

    const finished = await Promise.race([
      running.then(() => "stopped"),
      Bun.sleep(2_000).then(() => "still sleeping"),
    ]);

    expect(finished).toBe("stopped");
    expect(polls).toBe(1);
  });

  it("does not poll at all if it was stopped before it started", async () => {
    let polls = 0;
    const loop = new PollLoop({ intervalMs: 1, poll: async () => void (polls += 1) });

    loop.stop();
    await loop.run();

    expect(polls).toBe(0);
  });

  it("never starts a second poll while one is in flight", async () => {
    // A slow pass must not overlap with the next tick: two overlapping passes
    // would claim two batches and double the concurrency the batch size is
    // supposed to bound.
    let inFlight = 0;
    let maxInFlight = 0;
    let polls = 0;
    const loop = new PollLoop({
      intervalMs: 1,
      poll: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        polls += 1;
        if (polls === 3) loop.stop();
      },
    });

    await loop.run();

    expect(maxInFlight).toBe(1);
  });
});

describe("installShutdownSignals", () => {
  it("stops the loop on SIGTERM", async () => {
    let polls = 0;
    const loop = new PollLoop({
      intervalMs: 60_000,
      poll: async () => {
        polls += 1;
      },
    });
    const uninstall = installShutdownSignals(loop);

    try {
      const running = loop.run();
      while (polls === 0) await Bun.sleep(1);

      // What a container orchestrator actually sends.
      process.emit("SIGTERM");

      const finished = await Promise.race([
        running.then(() => "stopped"),
        Bun.sleep(2_000).then(() => "still running"),
      ]);
      expect(finished).toBe("stopped");
    } finally {
      uninstall();
    }
  });

  it("stops the loop on SIGINT too, so Ctrl-C works locally", async () => {
    const loop = new PollLoop({ intervalMs: 60_000, poll: async () => undefined });
    const uninstall = installShutdownSignals(loop);

    try {
      const running = loop.run();
      await Bun.sleep(5);
      process.emit("SIGINT");
      const finished = await Promise.race([
        running.then(() => "stopped"),
        Bun.sleep(2_000).then(() => "still running"),
      ]);
      expect(finished).toBe("stopped");
    } finally {
      uninstall();
    }
  });

  it("removes its listeners when uninstalled, leaving no handler behind", () => {
    const loop = new PollLoop({ intervalMs: 1, poll: async () => undefined });
    const before = process.listenerCount("SIGTERM");

    const uninstall = installShutdownSignals(loop);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("resolvePollIntervalMs", () => {
  it("defaults when the variable is unset or blank", () => {
    // `WORKER_POLL_INTERVAL_MS=` in a .env file arrives as "", which is not
    // configuration — same rule as bootstrap's presentOrUndefined.
    expect(resolvePollIntervalMs(undefined)).toBe(5_000);
    expect(resolvePollIntervalMs("")).toBe(5_000);
    expect(resolvePollIntervalMs("   ")).toBe(5_000);
  });

  it("uses a configured value", () => {
    expect(resolvePollIntervalMs("250")).toBe(250);
  });

  it("refuses a value that is not a usable interval", () => {
    // Failing closed matters here: `Number("abc")` is NaN, and setTimeout treats
    // NaN as 0 — a busy loop hammering the database rather than polling it.
    for (const bad of ["abc", "0", "-1", "1.5", "1e9999"]) {
      expect(() => resolvePollIntervalMs(bad)).toThrow(/WORKER_POLL_INTERVAL_MS/);
    }
  });
});
