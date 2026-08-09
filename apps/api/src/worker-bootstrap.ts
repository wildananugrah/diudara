import { db } from "./db/client";
import {
  resolveAppBaseUrl,
  selectMessagingProviders,
  type MessagingProviders,
} from "./bootstrap";
import { DrizzleActivityLogRepository } from "./infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "./infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { DrizzleMemberRepository } from "./infrastructure/repositories/drizzle-member.repository";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "./infrastructure/repositories/drizzle-subscription.repository";
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
    grantChannelAccess,
    retryChannelAccessRevocation,
    sendRenewalReminder,
    revokeChannelAccessForSystem,
    messaging,
  };
}
