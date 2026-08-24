import { db } from "./db/client";
import {
  resolveAppBaseUrl,
  selectEmailProvider,
  selectMessagingProviders,
  type MessagingProviders,
} from "./bootstrap";
import type { ClockPort } from "./application/ports/clock.port";
import type { EmailProviderPort } from "./application/ports/email-provider.port";
import { RemindExpiringMembership } from "./application/use-cases/remind-expiring-membership";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { DrizzleMembershipReminderRepository } from "./infrastructure/repositories/drizzle-membership-reminder.repository";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleUserRepository } from "./infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserSubscriptionRepository } from "./infrastructure/repositories/drizzle-user-subscription.repository";
import { ProcessOutbox, type OutboxHandler } from "./application/use-cases/process-outbox";

/**
 * What `apps/worker` needs to do its job. `messaging` is exposed so a test can
 * prove which adapters a given environment selected — the API's `Dependencies`
 * exposes `payments` for the same reason.
 */
export interface WorkerDependencies {
  /**
   * The outbox dispatcher. It claims rows and hands each to a registered handler
   * — and since retire-telegram Task 4 the HANDLER MAP IS EMPTY, and since Task 5
   * removed the payment webhook's community branch there is NO WRITER either (see
   * `bootstrapWorker` for both, and for Task 7's recorded DECISION naming
   * exactly what retires with the `outbox` table, in one commit, when it drops).
   *
   * It is kept for one time-limited reason: a database that ran the earlier code
   * can still hold `grant_access` rows, and this pass claims them, fails them
   * ("no handler is registered") and retries them to permanent failure. Losing
   * the dispatcher would leave such rows unclaimed and SILENT instead of failing
   * loudly, which is strictly worse.
   */
  processOutbox: ProcessOutbox;
  /**
   * The ONE clock this process's passes read, exposed so a test can prove this root
   * injected the real one. `FixedClock` lives in the same workspace, and a root that
   * wired it by accident would leave every member's reminder window frozen on the day
   * the worker booted — silently, and for a whole billing cycle.
   */
  clock: ClockPort;
  /**
   * Task 4 of Phase 5b's SCHEDULED pass — the one that tells a member their membership
   * is about to end.
   *
   * Exposed for the same reason `clock` is — a test must be able to prove what this
   * root wired — and for one specific to it: it is now the ONLY pass this root
   * constructs. There is no recurring charge anywhere in this system, so nothing renews and this
   * pass is the ONLY thing that tells a member to buy again. A root that failed to
   * construct it would leave every membership ending in silence, and nothing else in
   * the process would notice.
   */
  remindExpiringMemberships: RemindExpiringMembership;
  /**
   * The email adapter this root selected, or `null` when email is DISABLED on this box
   * (see `selectEmailProvider`). Exposed for the same reason `messaging` is: a test
   * has to be able to prove which adapters an environment actually chose — and here
   * the `null` case is a behaviour, not an absence, because it is half of what makes
   * `RemindExpiringMembership` record a skip instead of reaching nobody in silence.
   */
  email: EmailProviderPort | null;
  messaging: MessagingProviders;
}

/**
 * The WORKER's composition root, deliberately separate from `bootstrap()`.
 *
 * The worker serves no HTTP request, so it has no session tokens to sign and no
 * invoices to create — and making it refuse to start without `JWT_SECRET` or the
 * Xendit keys would be a deployment hazard, not a safety guard. What it DOES need is
 * the messaging configuration, which is selected through the same allowlist
 * (`selectMessagingProviders`): a worker running the fake adapters looks exactly
 * like a working one while every paying member waits for a message that never
 * arrives.
 *
 * IT ALSO NEEDS `APP_BASE_URL`, which it did not before Phase 5. This comment used to
 * say the worker had "no confirmation page to link to"; that stopped being true when
 * reminders started carrying a link a member can buy through. Retire-telegram Task 4
 * deleted the community renewal reminder that first made it true, but the need
 * survives it: `RemindExpiringMembership` builds its own link from the same value.
 * It is resolved through the SAME `resolveAppBaseUrl` the API calls, deliberately —
 * including its guard, so a production worker with the variable unset refuses to boot
 * instead of sending every member a link to `localhost:5173` on their own phone. That
 * is the loud failure; the quiet one is worse.
 *
 * The outbox is read with the POOLED client. Nothing here opens a transaction:
 * sends are external HTTP calls, and one must never be able to roll back a
 * payment (plan, Global Constraints).
 */
export function bootstrapWorker(): WorkerDependencies {
  const messaging = selectMessagingProviders({
    fonnteApiToken: process.env.FONNTE_API_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  // ONE clock for the process, exactly as `bootstrap()` keeps one for the API. Two
  // clocks would be two answers to "when is now" inside the same worker.
  const clock = new SystemClock();

  // THE MAP IS EMPTY, AND SO, NOW, IS THE QUEUE'S SET OF WRITERS.
  //
  // Task 2 removed four handler registrations — `grant_access`, `revoke_access`,
  // `revoke_subscription_access` and `notify_join_request` — whose handlers went
  // with the channel-access and join-request use cases; Task 3 removed
  // `notify_stream_live` with `NotifyStreamLive` (that also removed this root's
  // ONLY reader of `STREAM_TOKEN_SECRET`, so the worker signs nothing now and no
  // longer refuses to boot over its length); and Task 4 removed the last one,
  // `send_renewal_reminder`, with `SendRenewalReminder`.
  //
  // Until Task 5 an empty map was NOT an empty queue: `handle-payment-webhook.ts`
  // still enqueued `grant_access` on every activated community payment — a live
  // writer whose type had no handler, so those rows failed loudly to permanent
  // failure. TASK 5 DELETED THAT BRANCH, and with it the last `enqueue` call in
  // the codebase. Nothing writes an `outbox` row now, and nothing reads one that
  // it could act on. (`RemindExpiringMembership` is not a writer and never was: it
  // is a scheduled pass that sends directly.)
  //
  // SO THE REASON THIS PASS IS KEPT HAS CHANGED, and it is now a weaker and a
  // TIME-LIMITED one. It is no longer "the dispatcher stays because something
  // writes". It is: a database that ran the pre-Task-5 code can still hold
  // `grant_access` rows, and this pass is what turns them into a loud, bounded
  // permanent failure ("no handler is registered", which
  // `worker-bootstrap.test.ts` asserts on) instead of leaving them `pending` and
  // unread for ever.
  //
  // TASK 7 TOOK THE DECISION RATHER THAN DEFERRING IT ONWARD, and the list below
  // is meant to be EXECUTED, not read: whoever runs the follow-up should be able
  // to work from it without re-deriving the surface. Fix round 2 completed it
  // — the first version named only the apps/api half, which is a trap for
  // exactly the person the list exists for.
  //
  // THIS LIST HAS ALREADY GONE STALE ONCE. RE-DERIVE IT BEFORE YOU TRUST IT.
  // Task 7's fix round 2 completed it against the tree as it then stood; Task 8
  // then added `src/test/new-world-smoke.test.ts`, which imports the `outbox`
  // table AND `DrizzleOutboxRepository`, enqueues a row and drives
  // `processOutbox.execute()` — and nothing re-checked the list, so it named six
  // of the eight files that import `outbox` until Phase 8's whole-branch review
  // found the gap. The intended single commit would not have compiled. The list
  // is a head start, not an inventory: before executing it, run
  //
  //   grep -rn "\boutbox\b" apps/api/src apps/worker/src
  //
  // and reconcile. The failure mode is structural — a list in a comment cannot
  // notice a file added after it — so assume it happened again.
  //
  // ONE COMMIT, in the follow-up that drops the retired tables, retires:
  //
  //   apps/api
  //     - `ProcessOutbox` (application/use-cases/process-outbox.ts) + its test
  //     - `OutboxRepositoryPort` (application/ports/outbox-repository.port.ts),
  //       including every surviving `OUTBOX_*` constant and `ClaimedOutboxRow`
  //     - `DrizzleOutboxRepository` + its test
  //     - `OutboxHandler`, THIS map, and `WorkerDependencies.processOutbox`
  //     - `worker-bootstrap.test.ts`'s outbox coverage, including the `it.each`
  //       that pins "no handler is registered" (ONE declaration, SIX runs —
  //       the test count drops by six, not one)
  //     - `db/test-helpers.ts`'s `outbox` import and its `db.delete(outbox)`
  //     - `db/schema-phase4.test.ts`'s outbox import and its
  //       "defaults an outbox row to pending with no attempts" case
  //     - `routes/webhooks.test.ts`'s `outbox` import and the
  //       `expect(await db.select().from(outbox)).toHaveLength(0)` line inside
  //       "writes NOTHING outside the membership tables — no outbox row, no
  //       audit row". Delete the ASSERTION and the import, KEEP the test: the
  //       audit half of what it pins is unrelated to the outbox, and its name
  //       needs the outbox clause dropped with it
  //     - `test/new-world-smoke.test.ts` — FLOW 4, "every surviving worker pass
  //       runs without throwing". Step 1 of that flow IS the outbox: the
  //       `outbox` and `DrizzleOutboxRepository` imports, the `outboxRepository`
  //       /`enqueue` block, and the four `outboxResult`/`outboxRow` assertions
  //       (including `lastError` contains "no handler is registered"). The
  //       flow's own prose says "All SIX, in the order the process starts them"
  //       and its docstring header says ALL SIX — both become FIVE. This is the
  //       phase's flagship net, so read it before cutting rather than deleting
  //       by grep
  //     - `.env.example`'s `WORKER_POLL_INTERVAL_MS` entry
  //     - the `outbox` table in `db/schema.ts`
  //
  //   apps/worker
  //     - `main.ts`: the `processOutbox` destructure from `bootstrapWorker()`,
  //       the whole `outboxLoop` block, the `resolvePollIntervalMs` call and its
  //       `intervalMs`, `outboxLoop` in the shutdown list, `outboxLoop.run()`,
  //       and the "polling the outbox every Nms" clause of the startup log
  //     - `poll-loop.ts`: `DEFAULT_POLL_INTERVAL_MS` and
  //       `resolvePollIntervalMs` ONLY — **`PollLoop` itself and
  //       `resolveIntervalMs` STAY**, because the five scheduled passes in
  //       `scheduled-passes.ts` are built on them. Deleting that file wholesale
  //       takes the whole worker down; this is the one line of this list that
  //       is a subtraction rather than a deletion.
  //     - `poll-loop.test.ts`'s `resolvePollIntervalMs` cases
  //     - `scheduled-passes.ts`: the `"outbox"` member of `formatPassFailure`'s
  //       `pass` union (and the matching case in `scheduled-passes.test.ts`)
  //
  // Prose that merely MENTIONS the outbox as a comparison needs REWORDING, not
  // deleting, and is deliberately not itemised above because none of it is
  // load-bearing — but it is much wider than the three files the first version
  // of this paragraph named. At the time of writing the same
  // `grep -rn "\boutbox\b"` also hits `log-safety.ts` (which justifies its
  // truncation budget by `outbox.last_error` being `varchar(500)`),
  // `application/errors.ts`, `request-password-reset.ts`,
  // `payment-activation-unit-of-work.port.ts`, `handle-payment-webhook.ts`,
  // both messaging adapters, `db/test-database.ts`, `test-env-preload.ts`,
  // `db/schema-phase5.test.ts`, `log-safety.test.ts`, `error-handler.test.ts`
  // and — outside `src/` entirely, so no grep of the source tree finds it —
  // **`CONTRIBUTING.md`**, which describes the whole `apps/worker` workspace
  // partly in terms of the outbox drain. Sweep the repository, not just
  // `apps/*/src`.
  //
  // NOT BEFORE the table drops, for the reason above: a drainer deleted while
  // the table survives turns a loud failure into silence. `enqueueMany` was the
  // one piece that did NOT wait — Task 7 deleted it, because the argument
  // above is about draining and cannot be made for a writer.
  //
  // Anything added later that must happen AFTER a payment commits reinstates the
  // real reason to keep all of it: see `PaymentActivationUnitOfWorkPort`.
  const handlers = new Map<string, OutboxHandler>();
  // Task 4 of Phase 5b: reminding a member BEFORE their membership ends. Selected
  // through the SAME allowlist the API root uses, and it may legitimately be `null` —
  // a box with no `RESEND_API_KEY`/`EMAIL_FROM` outside development has no email
  // channel at all. That is not a boot failure (see `selectEmailProvider`'s own
  // docstring for why it degrades instead of throwing), and the reminder pass is built
  // to see the absence and record the skip rather than reach nobody in silence.
  const email = selectEmailProvider({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    nodeEnv: process.env.NODE_ENV,
  });

  const remindExpiringMemberships = new RemindExpiringMembership(
    new DrizzleUserSubscriptionRepository(db),
    new DrizzleUserRepository(db),
    new DrizzleMembershipReminderRepository(db),
    email,
    messaging.notifier,
    // The SAME clock instance every other pass here shares — see
    // `WorkerDependencies.clock` for why a second clock constructed here would be a
    // bug and not a style choice. The window boundary this pass reads is a moment,
    // not a WIB day, but two clocks in one worker is still two answers to "now".
    clock,
    {
      appBaseUrl: resolveAppBaseUrl({
        appBaseUrl: process.env.APP_BASE_URL,
        nodeEnv: process.env.NODE_ENV,
      }),
    }
  );

  return {
    processOutbox: new ProcessOutbox(new DrizzleOutboxRepository(db), handlers),
    remindExpiringMemberships,
    email,
    clock,
    messaging,
  };
}
