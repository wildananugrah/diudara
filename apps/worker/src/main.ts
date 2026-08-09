/**
 * The outbox worker: the process that actually delivers what a payment bought.
 *
 * A payment activation writes a `grant_access` row inside its own transaction and
 * returns; this process claims those rows and performs the sends OUTSIDE any
 * transaction, because an invite is an external HTTP call and a Telegram outage
 * must delay an invite, never roll back a payment (plan, Global Constraints).
 *
 * Run it beside the API, with the same `apps/api/.env`:
 *
 *   bun run --filter @diudara/worker start
 *
 * It imports the API workspace's composition root by relative path rather than by
 * package name: `apps/api` publishes no entry point, and `bootstrapWorker()` is
 * the API's own module, not a shared library. Bun and tsc both resolve each
 * file's imports from that file's directory, so `apps/api`'s dependencies keep
 * resolving inside `apps/api`.
 */
import { bootstrapWorker } from "../../api/src/worker-bootstrap";
import { installShutdownSignals, PollLoop, resolvePollIntervalMs } from "./poll-loop";

const { processOutbox } = bootstrapWorker();
const intervalMs = resolvePollIntervalMs(process.env.WORKER_POLL_INTERVAL_MS);

const loop = new PollLoop({
  intervalMs,
  poll: async () => {
    const result = await processOutbox.execute();
    // Silent when there is nothing to say, so the interesting lines are not
    // buried under one "claimed 0" per interval. Counts and nothing else: the
    // rows carry invite links.
    if (result.claimed > 0 || result.reclaimed > 0) {
      console.log(
        `[worker] reclaimed=${result.reclaimed} claimed=${result.claimed} ` +
          `sent=${result.sent} retried=${result.retried} failed=${result.failed}`
      );
    }
  },
  onError: (err) => {
    // A failed PASS is not a failed row — the database may have been briefly
    // unreachable, in which case nothing was claimed and the next tick retries.
    // Never rethrow: an unhandled rejection here would take the process down and
    // strand whatever it had claimed.
    console.error(`[worker] poll failed: ${err instanceof Error ? err.message : String(err)}`);
  },
});

const uninstallSignals = installShutdownSignals(loop);

console.log(`[worker] polling the outbox every ${intervalMs}ms`);
await loop.run();
uninstallSignals();
console.log("[worker] stopped");
