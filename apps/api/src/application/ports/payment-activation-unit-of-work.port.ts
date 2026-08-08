import type { ActivityLogRepositoryPort } from "./activity-log-repository.port";
import type { SubscriptionRepositoryPort } from "./subscription-repository.port";
import type { WebhookEventRepositoryPort } from "./webhook-event-repository.port";

/** The repositories that must succeed or fail together when a payment lands. */
export interface PaymentActivationRepositories {
  subscriptions: SubscriptionRepositoryPort;
  webhookEvents: WebhookEventRepositoryPort;
  activityLog: ActivityLogRepositoryPort;
}

/**
 * Runs the three writes a successful payment triggers — record the event,
 * activate the subscription, write the audit entry — as ONE atomic unit.
 *
 * This exists because of a specific, expensive failure. The idempotency row
 * (`webhook_event.provider_event_id`, UNIQUE) has to be claimed BEFORE the
 * activation, or two concurrent deliveries both activate. But if the claim
 * commits on its own and the activation then fails, the event id is spent:
 * every retry Xendit makes is treated as a replay and returns 200 while the
 * member is never activated. Money taken, access never granted, no automatic
 * recovery.
 *
 * Wrapping both in one transaction removes the choice. A failed activation
 * rolls the claim back, so the retry finds no row and processes normally; a
 * successful one commits both together, so a replay still finds the row and
 * no-ops. Concurrency is unaffected: `onConflictDoNothing` still means the
 * database decides which delivery wins.
 *
 * The work function receives repositories already bound to the transaction, so
 * no port method grows a "pass the handle in" parameter and no repository has
 * to know whether it is inside a transaction.
 *
 * Anything thrown out of `work` must roll the whole unit back and propagate.
 */
export interface PaymentActivationUnitOfWorkPort {
  run<T>(work: (repositories: PaymentActivationRepositories) => Promise<T>): Promise<T>;
}
