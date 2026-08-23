/**
 * The worker: the process that acts because time has passed, and the process that
 * drains the outbox.
 *
 * The outbox's shape is unchanged and still load-bearing: a writer enqueues a row
 * inside its own transaction and returns, and this process claims those rows and
 * performs the effects OUTSIDE any transaction, because an effect is an external HTTP
 * call and a provider outage must delay it, never roll back the payment that caused it
 * (plan, Global Constraints). Retire-telegram removed every HANDLER that used to sit
 * at the far end of that queue — the Telegram invite Phase 4 built it for, and Task
 * 4's renewal reminder last of all — but NOT every writer:
 * `handle-payment-webhook.ts:640` still enqueues `grant_access` on an activated
 * community payment, and removing that writer is Task 5's. See `bootstrapWorker`.
 *
 * It runs SIX loops, on two cadences:
 *
 *   - the OUTBOX, every 5 seconds, because that interval is the delay a paying member
 *     sees between their payment settling and whatever the row promised them arriving.
 *     Retire-telegram Task 4 removed the last registered handler, so the map this loop
 *     dispatches through is EMPTY today — while a live writer remains (see
 *     `bootstrapWorker`). The loop stays BECAUSE of that writer, not despite the empty
 *     map: it is what makes an unhandleable row fail loudly instead of sitting
 *     `pending` and unread;
 *   - the orphan MEDIA SWEEP, the MEMBERSHIP SWEEP, the MEMBERSHIP REMINDER pass, the
 *     PENDING-CHECKOUT CLEANUP and the USER-STREAM SWEEP, hourly. None is
 *     latency-sensitive the way the outbox is, and in every case the pass's OWN window
 *     is what protects the thing it sweeps rather than this cadence: spec §8's 24-hour
 *     orphan window (generous on purpose), the pending-checkout cleanup's two-hour one
 *     (`STALE_PENDING_CHECKOUT_WINDOW_MS`), the user-stream sweep's 12-hour cap
 *     (`MAX_USER_STREAM_MS`), and the reminder pass's three-day warning — against which
 *     an hour of latency is a rounding error, while the claim in `membership_reminder`
 *     means the other 71 passes inside that window cost one conflicting insert each and
 *     send nothing. Retire-telegram Task 4 deleted the RENEWAL and CHURN loops this
 *     cadence was originally chosen for; see `DEFAULT_RENEWAL_INTERVAL_MS` for why its
 *     env var keeps their name.
 *
 * All six are the same `PollLoop`, so all six inherit its two properties: passes of
 * one kind never overlap, and a signal wakes them out of their interval instead of
 * letting it expire. They are separate loops rather than one pass doing everything so
 * that a sweep query that fails every time cannot also stop the outbox.
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
  SweepStalePendingCheckouts,
  SweepStaleUserStreams,
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
// Task 6's user-stream sweep (Phase 7, design spec §7). Same reasoning as
// `DrizzleUserSubscriptionRepository` above — constructed here rather than returned
// from `bootstrapWorker()` because `SweepStaleUserStreams`, like the other sweeps in
// this file, is defined in THIS package, not the API's.
const { DrizzleUserStreamRepository } = await import(
  "../../api/src/infrastructure/repositories/drizzle-user-stream.repository"
);
// The SAME selector the API's own `bootstrap()` uses for `POST /users/media` and the
// delivery routes — reused rather than re-derived so the worker and the API can never
// disagree about which bucket (or the in-memory fake) uploaded bytes actually live in.
// It block-boots on a half-configured or absent-outside-development setup, same as it
// does for the API (see its own docstring, case 4): a worker that started anyway and
// quietly swept nothing, forever, would be worse than one that refuses to start.
// `selectPaymentProvider` comes from the same module, and the worker needs it for
// the SAME reason the API does: Task 5's sweep cancels an abandoned invoice at the
// provider when it frees the pending row (final whole-branch review, I-1). Reused
// rather than re-derived so the two processes can never disagree about which
// provider — or the fake — an invoice was opened against.
//
// It can THROW, on a half-configured Xendit (one of the two keys set). That is a new
// way for this process to refuse to start, and it is the right one: a worker that
// booted anyway would sweep rows while silently leaving every invoice payable, which
// is the double-charge window this change exists to close. The API already refuses to
// boot in the same state, so such a box has no working checkout either.
//
// It can also answer `null` — a box with no payment provider at all, where
// `bootstrap()` registers no checkout route. The sweep takes that and simply skips
// the provider call; see `SweepStalePendingCheckouts`'s own `payments` parameter.
const { selectMediaStorage, selectPaymentProvider } = await import("../../api/src/bootstrap");

const { processOutbox, remindExpiringMemberships } = bootstrapWorker();
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
// Task 5's pending-checkout cleanup (Phase 5b, spec §7): 5a's final review named this
// the phase's most likely real-world money loss — nothing in 5a ever expires a
// `pending` subscription, so an abandoned cart returned to later is handed back the
// same now-dead invoice, forever. This is what frees `user_subscription_one_pending`'s
// slot so the next attempt mints a fresh one. Its own `DrizzleUserSubscriptionRepository`
// instance, same as the membership sweep above — a fresh instance per pass rather than
// sharing one, matching that pass's own reasoning even though both happen to be
// stateless wrappers around the same pooled `db`.
const processStalePendingSweep = new SweepStalePendingCheckouts(
  new DrizzleUserSubscriptionRepository(db),
  // Freeing the slot is only half of it: the invoice the abandoned row opened lives
  // 24 hours at Xendit, and until this argument existed nothing cancelled it — so a
  // buyer who returned after two hours held TWO payable invoices, and paying both is
  // a duplicate charge with no refund path. Final whole-branch review, I-1.
  selectPaymentProvider({
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  })
);
// Task 6's backstop against a LOST `user_stream` lifecycle webhook (Phase 7, design
// spec §7): `user_stream_one_live`'s partial unique index means a row stuck `live`
// forever leaves its owner permanently unable to go live again. See
// `MAX_USER_STREAM_MS`'s own docstring in `scheduled-passes.ts` for why the window is
// a cap on age, not a liveness check. Its own `DrizzleUserStreamRepository` instance,
// same pattern as the sweeps above.
const processUserStreamSweep = new SweepStaleUserStreams(new DrizzleUserStreamRepository(db));
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

// Task 10's orphan sweep, Phase 5b's retirement sweep and reminder pass, and Phase
// 7's user-stream sweep (Task 6), on their own much longer, shared cadence. Five
// loops, not one: a sweep that throws every time must not stop the other four, and
// none of them must stop the outbox.
const {
  orphanSweepLoop,
  membershipSweepLoop,
  membershipReminderLoop,
  stalePendingSweepLoop,
  userStreamSweepLoop,
} = createScheduledPassLoops({
  processOrphanSweep,
  processMembershipSweep,
  // Task 4 of Phase 5b. Nothing in this system renews — there is no recurring charge
  // anywhere in it — so a membership ends and the member buys again, and THIS PASS IS
  // THE ONLY THING THAT TELLS THEM TO. Without it a membership simply stops and the
  // member finds out by discovering they cannot see something.
  processMembershipReminder: remindExpiringMemberships,
  processStalePendingSweep,
  processUserStreamSweep,
  intervalMs: renewalIntervalMs,
});

// ONE handler for all SIX loops, so there is no ordering in which some are stopped
// and others keep polling — and the process cannot exit while any of them holds the
// pool open.
const uninstallSignals = installShutdownSignals(
  outboxLoop,
  orphanSweepLoop,
  membershipSweepLoop,
  membershipReminderLoop,
  stalePendingSweepLoop,
  userStreamSweepLoop
);

console.log(
  `[worker] polling the outbox every ${intervalMs}ms; running the media-sweep, ` +
    `membership-sweep, membership-reminder, pending-checkout-cleanup and ` +
    `user-stream-sweep passes every ${renewalIntervalMs}ms`
);
// All six concurrently. `Promise.all` and not a sequential await: each loop runs
// until it is stopped, so awaiting one would never start the others.
await Promise.all([
  outboxLoop.run(),
  orphanSweepLoop.run(),
  membershipSweepLoop.run(),
  membershipReminderLoop.run(),
  stalePendingSweepLoop.run(),
  userStreamSweepLoop.run(),
]);
uninstallSignals();

// Closing the pool is what actually ends the process. postgres.js keeps its
// connections — and therefore the event loop — alive, so without this the worker
// printed "stopped" on SIGTERM and then hung until the orchestrator SIGKILLed it
// (measured). The timeout bounds the wait on an in-flight query.
await sql.end({ timeout: 5 });
console.log("[worker] stopped");
