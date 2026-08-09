import { db } from "./db/client";
import { selectMessagingProviders, type MessagingProviders } from "./bootstrap";
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
import { ProcessOutbox, type OutboxHandler } from "./application/use-cases/process-outbox";
import { OUTBOX_GRANT_ACCESS } from "./application/ports/outbox-repository.port";

/**
 * What `apps/worker` needs to do its job. `messaging` is exposed so a test can
 * prove which adapters a given environment selected — the API's `Dependencies`
 * exposes `payments` for the same reason.
 */
export interface WorkerDependencies {
  processOutbox: ProcessOutbox;
  grantChannelAccess: GrantChannelAccess;
  messaging: MessagingProviders;
}

/**
 * The WORKER's composition root, deliberately separate from `bootstrap()`.
 *
 * The worker serves no HTTP request, so it has no session tokens to sign, no
 * confirmation page to link to and no invoices to create — and making it refuse
 * to start without `JWT_SECRET`, `APP_BASE_URL` or the Xendit keys would be a
 * deployment hazard, not a safety guard. What it DOES need is the messaging
 * configuration, which is selected through the same allowlist
 * (`selectMessagingProviders`): a worker running the fake adapters looks exactly
 * like a working one while every paying member waits for a message that never
 * arrives.
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

  const handlers = new Map<string, OutboxHandler>([
    [OUTBOX_GRANT_ACCESS, grantAccessOutboxHandler(grantChannelAccess)],
  ]);

  return {
    processOutbox: new ProcessOutbox(new DrizzleOutboxRepository(db), handlers),
    grantChannelAccess,
    messaging,
  };
}
