/**
 * The worker: the process that delivers what a payment bought, and — since Phase 5 —
 * the process that notices when one stops arriving.
 *
 * A payment activation writes a `grant_access` row inside its own transaction and
 * returns; this process claims those rows and performs the sends OUTSIDE any
 * transaction, because an invite is an external HTTP call and a Telegram outage
 * must delay an invite, never roll back a payment (plan, Global Constraints).
 *
 * It runs THREE loops, on two cadences:
 *
 *   - the OUTBOX, every 5 seconds, because that interval is the delay a paying member
 *     sees between their payment settling and their invite arriving;
 *   - RENEWALS and CHURN, hourly, because those decide whole Asia/Jakarta calendar days
 *     (see `DEFAULT_RENEWAL_INTERVAL_MS` for why hourly and not daily, and why not 5s).
 *
 * All three are the same `PollLoop`, so all three inherit its two properties: passes of
 * one kind never overlap, and a signal wakes them out of their interval instead of
 * letting it expire. They are separate loops rather than one pass doing everything so
 * that a renewal query that fails every time cannot also stop invites being delivered.
 *
 * Run it beside the API, with the same `apps/api/.env`, AS THIS PROCESS and not
 * behind a package-manager wrapper:
 *
 *   cd apps/worker && bun run src/main.ts
 *
 * !!! NOT `bun run --filter @diudara/worker start`, which is what this comment
 * used to say. That command stays in the foreground as a PARENT process and does
 * NOT forward SIGTERM to the child that is actually the worker (measured, Task 8):
 * signalling it kills only the parent, the worker is reparented to init and keeps
 * polling and CLAIMING outbox rows, and it then needs SIGKILL — so
 * `installShutdownSignals` below never runs, and whatever the worker had claimed
 * sits in `processing` until `reclaimStaleProcessing` picks it up five minutes
 * later. It also pipes the child's stdout through itself, so the shutdown lines are
 * lost to a broken pipe even when the signal is delivered by hand.
 *
 * Under a supervisor this is mostly hidden — a container runtime and systemd's
 * default `KillMode=control-group` both signal the whole process group — but the
 * graceful path is the point of having one, and it is the operator running this by
 * hand who is misled.
 *
 * It imports the API workspace's composition root by relative path rather than by
 * package name: `apps/api` publishes no entry point, and `bootstrapWorker()` is
 * the API's own module, not a shared library. Bun and tsc both resolve each
 * file's imports from that file's directory, so `apps/api`'s dependencies keep
 * resolving inside `apps/api`.
 */
import { loadApiEnv } from "./api-env";
import { installShutdownSignals, PollLoop, resolvePollIntervalMs } from "./poll-loop";
import {
  createScheduledPassLoops,
  formatPassFailure,
  resolveRenewalIntervalMs,
} from "./scheduled-passes";

// BEFORE the composition root is even imported. Bun auto-loads `.env` from the
// current working directory, and this process runs from `apps/worker`, which has
// no `.env` — so `apps/api/src/db/client.ts` threw `DATABASE_URL is not set` at
// IMPORT time, before any statement here could run. A static import of
// `worker-bootstrap` would be hoisted above this call and fail again, so the
// import is dynamic and deliberately stays that way.
loadApiEnv();
const { bootstrapWorker } = await import("../../api/src/worker-bootstrap");

const { processOutbox, processRenewals, processChurn } = bootstrapWorker();
const intervalMs = resolvePollIntervalMs(process.env.WORKER_POLL_INTERVAL_MS);
const renewalIntervalMs = resolveRenewalIntervalMs(process.env.WORKER_RENEWAL_INTERVAL_MS);

const outboxLoop = new PollLoop({
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
    //
    // Through the same sanitiser as everything else since Phase 5: this line used to
    // print `err.message` raw, which for a drizzle query failure is the statement AND
    // its bound parameters — the very leak Phase 4 found and fixed in
    // `process-outbox.ts` without ever reaching this file.
    console.error(formatPassFailure("outbox", err));
  },
});

// Phase 5's two clock-driven passes, on their own much longer cadence. Two loops, not
// one: a renewal pass that throws every time must not stop churn, and neither must stop
// the outbox delivering invites people have already paid for.
const { renewalLoop, churnLoop } = createScheduledPassLoops({
  processRenewals,
  processChurn,
  intervalMs: renewalIntervalMs,
});

// ONE handler for all three loops, so there is no ordering in which some are stopped
// and others keep polling — and the process cannot exit while any of them holds the
// pool open.
const uninstallSignals = installShutdownSignals(outboxLoop, renewalLoop, churnLoop);

console.log(
  `[worker] polling the outbox every ${intervalMs}ms; running the renewal and churn ` +
    `passes every ${renewalIntervalMs}ms`
);
// All three concurrently. `Promise.all` and not a sequential await: each loop runs until
// it is stopped, so awaiting one would never start the others.
await Promise.all([outboxLoop.run(), renewalLoop.run(), churnLoop.run()]);
uninstallSignals();

// Closing the pool is what actually ends the process. postgres.js keeps its
// connections — and therefore the event loop — alive, so without this the worker
// printed "stopped" on SIGTERM and then hung until the orchestrator SIGKILLed it
// (measured). The timeout bounds the wait on an in-flight query.
const { sql } = await import("../../api/src/db/client");
await sql.end({ timeout: 5 });
console.log("[worker] stopped");
