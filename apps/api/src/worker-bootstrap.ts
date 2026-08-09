import { db } from "./db/client";
import {
  resolveAppBaseUrl,
  selectMessagingProviders,
  type MessagingProviders,
} from "./bootstrap";
import type { ClockPort } from "./application/ports/clock.port";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { DrizzleActivityLogRepository } from "./infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "./infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { DrizzleMemberRepository } from "./infrastructure/repositories/drizzle-member.repository";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleRenewalReminderRepository } from "./infrastructure/repositories/drizzle-renewal-reminder.repository";
import { DrizzleSubscriptionRepository } from "./infrastructure/repositories/drizzle-subscription.repository";
import { ProcessChurn } from "./application/use-cases/process-churn";
import { ProcessRenewals } from "./application/use-cases/process-renewals";
import {
  GrantChannelAccess,
  grantAccessOutboxHandler,
} from "./application/use-cases/grant-channel-access";
import {
  RetryChannelAccessRevocation,
  RevokeChannelAccessForSystem,
  revokeAccessOutboxHandler,
  revokeSubscriptionAccessOutboxHandler,
} from "./application/use-cases/revoke-channel-access";
import {
  SendRenewalReminder,
  sendRenewalReminderOutboxHandler,
} from "./application/use-cases/send-renewal-reminder";
import { ProcessOutbox, type OutboxHandler } from "./application/use-cases/process-outbox";
import {
  OUTBOX_GRANT_ACCESS,
  OUTBOX_REVOKE_ACCESS,
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  OUTBOX_SEND_RENEWAL_REMINDER,
} from "./application/ports/outbox-repository.port";

/**
 * What `apps/worker` needs to do its job. `messaging` is exposed so a test can
 * prove which adapters a given environment selected — the API's `Dependencies`
 * exposes `payments` for the same reason.
 */
export interface WorkerDependencies {
  processOutbox: ProcessOutbox;
  /**
   * Phase 5's two SCHEDULED passes — the reason this process now has a cadence and not
   * just a queue.
   *
   * Everything else here is a handler: something reacts to a row somebody else wrote.
   * These two are the only things in the codebase that act because time has passed, and
   * until Task 7 nothing constructed them at all. `apps/worker/src/main.ts` runs each on
   * its own `PollLoop`.
   */
  processRenewals: ProcessRenewals;
  processChurn: ProcessChurn;
  /**
   * The ONE clock both passes read, exposed so a test can prove this root injected the
   * real one. `FixedClock` lives in the same workspace, and a root that wired it by
   * accident would leave every member's reminder stage frozen on the day the worker
   * booted — silently, and for a whole billing cycle.
   */
  clock: ClockPort;
  grantChannelAccess: GrantChannelAccess;
  /**
   * Exposed for the same reason as `grantChannelAccess`: a test must be able to prove
   * the worker can actually complete a removal the API failed to make, rather than
   * only that a handler is registered under the right string.
   */
  retryChannelAccessRevocation: RetryChannelAccessRevocation;
  /**
   * Phase 5's reminder delivery. Exposed for the same reason as the two above, and for
   * one more: its message carries a checkout link built from `APP_BASE_URL`, and this is
   * the process that sends it — so a test has to be able to prove the value reached
   * THIS root and not only the API's. Phase 3 shipped a confirmation page that was
   * unreachable for a whole phase because nothing checked that wiring.
   */
  sendRenewalReminder: SendRenewalReminder;
  /**
   * Phase 5's system-initiated revoke — the other end of the churn pass.
   *
   * Exposed for the same reason as the three above, and for one specific to it: it is
   * the ONE use-case in the codebase with no authorization check, so a test has to be
   * able to prove that the thing wired against `revoke_subscription_access` is this
   * class and not the creator-facing one with an invented creator id (spec §5).
   */
  revokeChannelAccessForSystem: RevokeChannelAccessForSystem;
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
 * IT ALSO NEEDS `APP_BASE_URL` NOW, which it did not before Phase 5. This comment used
 * to say the worker had "no confirmation page to link to"; that stopped being true when
 * renewal reminders started carrying a checkout link to `/c/:slug`, built from the same
 * origin Phase 3 uses for `success_redirect_url`. It is resolved through the SAME
 * `resolveAppBaseUrl` the API calls, deliberately — including its guard, so a
 * production worker with the variable unset refuses to boot instead of sending every
 * member a link to `localhost:5173` on their own phone. That is the loud failure; the
 * quiet one is worse.
 *
 * The outbox is read with the POOLED client. Nothing here opens a transaction:
 * sends are external HTTP calls, and one must never be able to roll back a
 * payment (plan, Global Constraints).
 */
export function bootstrapWorker(): WorkerDependencies {
  const messaging = selectMessagingProviders({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    fonnteApiToken: process.env.FONNTE_API_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  const grantChannelAccess = new GrantChannelAccess(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleChannelRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // The WhatsApp provider, never the gating one: TelegramBotAdapter.notify
    // throws, because it addresses a WhatsApp number it has no way to reach.
    messaging.notifier
  );

  // The other direction, and the half that had no retry at all: a platform removal
  // the API could not perform. `RevokeChannelAccess` enqueues one of these instead of
  // dropping it, so a churned member does not stay in the paid group forever with no
  // record that a removal is owed — which is what Phase 5's churn job would otherwise
  // inherit. Same bounded retries as every other event type.
  const retryChannelAccessRevocation = new RetryChannelAccessRevocation(
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating
  );

  // Phase 5's reminder delivery. The base URL comes from the same resolver the API
  // uses, so the link in a reminder and the `success_redirect_url` in an invoice can
  // never disagree about which deployment they belong to.
  const sendRenewalReminder = new SendRenewalReminder(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleActivityLogRepository(db),
    // The WhatsApp provider, never the gating one — `TelegramBotAdapter.notify` throws,
    // so a reminder routed there would leave the member unwarned before revocation.
    messaging.notifier,
    {
      appBaseUrl: resolveAppBaseUrl({
        appBaseUrl: process.env.APP_BASE_URL,
        nodeEnv: process.env.NODE_ENV,
      }),
    }
  );

  // Phase 5's churn revoke. NO creator repository is passed, because it performs no
  // creator scoping — see the class docstring for why resolving a creator id from the
  // subscription and calling `RevokeChannelAccess` instead would be authorization
  // theatre. The composition root is where that would have been done, so this is where
  // saying it matters.
  const revokeChannelAccessForSystem = new RevokeChannelAccessForSystem(
    new DrizzleSubscriptionRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // A removal the provider refuses becomes a `revoke_access` row here, exactly as it
    // does on the creator-facing path: the shared revoker owns that, so churn inherits
    // the bounded retry rather than growing its own.
    new DrizzleOutboxRepository(db)
  );

  // ONE clock for the process, exactly as `bootstrap()` keeps one for the API. Two
  // clocks would be two answers to "what WIB day is it" inside the same worker, and the
  // renewal pass writes the grace deadline the churn pass then measures against.
  const clock = new SystemClock();

  // Phase 5's SCHEDULED passes. Nothing constructed these before Task 7: their outbox
  // handlers were registered above and their use-cases were tested, but no process ever
  // called `execute()` — the reminders and the churn were reachable only from a test.
  // This is the line that makes the phase run.
  //
  // Each takes the pooled `db`, like every other reader here: neither opens a
  // transaction, because both deliberately do their writing one row at a time so a
  // failure on the hundredth member cannot undo the ninety-nine reminders already
  // claimed.
  const processRenewals = new ProcessRenewals(
    new DrizzleSubscriptionRepository(db),
    new DrizzleRenewalReminderRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );
  const processChurn = new ProcessChurn(
    new DrizzleSubscriptionRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );

  const handlers = new Map<string, OutboxHandler>([
    [OUTBOX_GRANT_ACCESS, grantAccessOutboxHandler(grantChannelAccess)],
    [OUTBOX_REVOKE_ACCESS, revokeAccessOutboxHandler(retryChannelAccessRevocation)],
    [OUTBOX_SEND_RENEWAL_REMINDER, sendRenewalReminderOutboxHandler(sendRenewalReminder)],
    [
      OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
      revokeSubscriptionAccessOutboxHandler(revokeChannelAccessForSystem),
    ],
  ]);

  return {
    processOutbox: new ProcessOutbox(new DrizzleOutboxRepository(db), handlers),
    processRenewals,
    processChurn,
    clock,
    grantChannelAccess,
    retryChannelAccessRevocation,
    sendRenewalReminder,
    revokeChannelAccessForSystem,
    messaging,
  };
}
