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
   * — and since retire-telegram Task 4 deleted `ProcessRenewals` and
   * `SendRenewalReminder`, THE HANDLER MAP IS EMPTY (see `bootstrapWorker`).
   * The dispatcher is kept deliberately: it is the mechanism the outbox table
   * exists for, nothing in the new world enqueues yet, and a row of any type
   * fails loudly with "no handler is registered" rather than sitting unclaimed.
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

  // THE MAP IS EMPTY, and that is the whole of retire-telegram's effect on this
  // process's queue. Task 2 removed four registrations — `grant_access`,
  // `revoke_access`, `revoke_subscription_access` and `notify_join_request` —
  // whose handlers went with the channel-access and join-request use cases;
  // Task 3 removed `notify_stream_live` with `NotifyStreamLive` (that also
  // removed this root's ONLY reader of `STREAM_TOKEN_SECRET`, so the worker
  // signs nothing now and no longer refuses to boot over its length); and Task 4
  // removed the last one, `send_renewal_reminder`, with `SendRenewalReminder`
  // and the `ProcessRenewals` pass that was its only writer.
  //
  // Nothing in the surviving world enqueues an outbox row today: the user
  // membership reminder is a SCHEDULED pass that sends directly
  // (`RemindExpiringMembership`), not a queued one. The dispatcher stays because
  // the table and its claim/retry machinery stay, and because a row of an
  // unknown type must fail loudly rather than sit unclaimed.
  //
  // An unregistered type is NOT silent: `ProcessOutbox` fails the row (bounded
  // retry, then permanent) with "no handler is registered", which is what
  // `worker-bootstrap.test.ts` asserts on — and with an empty map that is now
  // the outcome for EVERY type.
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
