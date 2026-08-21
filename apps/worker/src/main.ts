/**
 * The worker: the process that delivers what a payment bought, and — since Phase 5 —
 * the process that notices when one stops arriving.
 *
 * A payment activation writes a `grant_access` row inside its own transaction and
 * returns; this process claims those rows and performs the sends OUTSIDE any
 * transaction, because an invite is an external HTTP call and a Telegram outage
 * must delay an invite, never roll back a payment (plan, Global Constraints).
 *
 * It runs SIX loops, on two cadences:
 *
 *   - the OUTBOX, every 5 seconds, because that interval is the delay a paying member
 *     sees between their payment settling and their invite arriving;
 *   - RENEWALS, CHURN, the orphan MEDIA SWEEP, the MEMBERSHIP SWEEP and the
 *     MEMBERSHIP REMINDER pass, hourly.
 *     Renewals/churn decide whole Asia/Jakarta calendar days (see
 *     `DEFAULT_RENEWAL_INTERVAL_MS` for why hourly and not daily, and why not 5s); the
 *     media sweep shares that cadence for a simpler reason — spec §8's 24-hour window
 *     is generous on purpose, so it is no more latency-sensitive than the other two.
 *     The membership sweep (Task 3, Phase 5b) shares it for the same kind of reason: a
 *     member who stops paying and never returns is not urgent to notice — Task 2
 *     already retires them immediately if they DO come back to buy again — and a fifth
 *     interval knob would be one more thing nobody would ever have reason to set
 *     differently. The reminder pass (Task 4, Phase 5b) shares it too, and for it the
 *     cadence is a genuine design choice rather than a convenience: it warns three days
 *     ahead of a period ending, so an hour of latency is a rounding error against the
 *     window, and the claim in `membership_reminder` means the other 71 passes inside
 *     that window cost one conflicting insert each and send nothing.
 *
 * All six are the same `PollLoop`, so all six inherit its two properties: passes of
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
  SweepExpiredMemberships,
  SweepOrphanMedia,
} from "./scheduled-passes";

// BEFORE the composition root is even imported. Bun auto-loads `.env` from the
// current working directory, and this process runs from `apps/worker`, which has
// no `.env` — so `apps/api/src/db/client.ts` threw `DATABASE_URL is not set` at
// IMPORT time, before any statement here could run. A static import of
// `worker-bootstrap` would be hoisted above this call and fail again, so the
// import is dynamic and deliberately stays that way.
loadApiEnv();
const { bootstrapWorker } = await import("../../api/src/worker-bootstrap");
// `sql` is kept for shutdown, at the bottom of this file — one import, one pool
// reference, rather than importing this module twice for two different exports.
const { db, sql } = await import("../../api/src/db/client");
const { DrizzleMediaRepository } = await import(
  "../../api/src/infrastructure/repositories/drizzle-media.repository"
);
// Task 3's membership sweep (Phase 5b). Same reasoning as `DrizzleMediaRepository`
// above — constructed here rather than returned from `bootstrapWorker()` because
// `SweepExpiredMemberships`, like `SweepOrphanMedia`, is defined in THIS package, not
// the API's.
const { DrizzleUserSubscriptionRepository } = await import(
  "../../api/src/infrastructure/repositories/drizzle-user-subscription.repository"
);
// The SAME selector the API's own `bootstrap()` uses for `POST /users/media` and the
// delivery routes — reused rather than re-derived so the worker and the API can never
// disagree about which bucket (or the in-memory fake) uploaded bytes actually live in.
// It block-boots on a half-configured or absent-outside-development setup, same as it
// does for the API (see its own docstring, case 4): a worker that started anyway and
// quietly swept nothing, forever, would be worse than one that refuses to start.
const { selectMediaStorage } = await import("../../api/src/bootstrap");

const { processOutbox, processRenewals, processChurn, remindExpiringMemberships } =
  bootstrapWorker();
const mediaStorage = selectMediaStorage({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  bucket: process.env.S3_BUCKET,
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  nodeEnv: process.env.NODE_ENV,
});
// Task 10's orphan sweep (spec §8). `DrizzleMediaRepository` and the selected storage
// adapter both satisfy `SweepOrphanMedia`'s narrower structural ports directly — see
// `scheduled-passes.ts` for why this pass, unlike renewals/churn, is defined there
// rather than in `apps/api`.
const processOrphanSweep = new SweepOrphanMedia(new DrizzleMediaRepository(db), mediaStorage);
// Task 3's retirement sweep (Phase 5b, spec — living with members): a member who never
// returns must not sit `active` forever, holding `user_subscription_one_active`'s slot
// against a purchase that will never come back to free it any other way. See
// `scheduled-passes.ts` for why the per-row failure handling is modelled on
// `SweepOrphanMedia` rather than `ProcessChurn`.
const processMembershipSweep = new SweepExpiredMemberships(new DrizzleUserSubscriptionRepository(db));
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

// Phase 5's two clock-driven passes plus Task 10's orphan sweep and Phase 5b's
// retirement sweep and reminder pass, on their own much longer, shared cadence. Five
// loops, not one: a renewal pass that throws every time must not stop churn, the media
// sweep, the membership sweep or the reminders, and none of them must stop the outbox
// delivering invites people have already paid for.
const {
  renewalLoop,
  churnLoop,
  orphanSweepLoop,
  membershipSweepLoop,
  membershipReminderLoop,
} = createScheduledPassLoops({
  processRenewals,
  processChurn,
  processOrphanSweep,
  processMembershipSweep,
  // Task 4 of Phase 5b. Nothing in this system renews — there is no recurring charge
  // anywhere in it — so a membership ends and the member buys again, and THIS PASS IS
  // THE ONLY THING THAT TELLS THEM TO. Without it a membership simply stops and the
  // member finds out by discovering they cannot see something.
  processMembershipReminder: remindExpiringMemberships,
  intervalMs: renewalIntervalMs,
});

// ONE handler for all six loops, so there is no ordering in which some are stopped
// and others keep polling — and the process cannot exit while any of them holds the
// pool open.
const uninstallSignals = installShutdownSignals(
  outboxLoop,
  renewalLoop,
  churnLoop,
  orphanSweepLoop,
  membershipSweepLoop,
  membershipReminderLoop
);

console.log(
  `[worker] polling the outbox every ${intervalMs}ms; running the renewal, churn, ` +
    `media-sweep, membership-sweep and membership-reminder passes every ${renewalIntervalMs}ms`
);
// All six concurrently. `Promise.all` and not a sequential await: each loop runs until
// it is stopped, so awaiting one would never start the others.
await Promise.all([
  outboxLoop.run(),
  renewalLoop.run(),
  churnLoop.run(),
  orphanSweepLoop.run(),
  membershipSweepLoop.run(),
  membershipReminderLoop.run(),
]);
uninstallSignals();

// Closing the pool is what actually ends the process. postgres.js keeps its
// connections — and therefore the event loop — alive, so without this the worker
// printed "stopped" on SIGTERM and then hung until the orchestrator SIGKILLed it
// (measured). The timeout bounds the wait on an in-flight query.
await sql.end({ timeout: 5 });
console.log("[worker] stopped");
