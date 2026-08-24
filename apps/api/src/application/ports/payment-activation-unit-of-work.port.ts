import type { UserSubscriptionRepositoryPort } from "./user-subscription-repository.port";
import type { UserTierRepositoryPort } from "./user-tier-repository.port";
import type { WebhookEventRepositoryPort } from "./webhook-event-repository.port";

/** The repositories that must succeed or fail together when a payment lands. */
export interface PaymentActivationRepositories {
  /**
   * `user_subscription`/`user_transaction` — the membership the payment buys.
   *
   * In HERE, and not read off the pool, for exactly the reason `webhookEvents` is:
   * the replay claim and the activation it authorises must commit together or not
   * at all. A claim that committed alone would spend the event id on a delivery
   * that activated nobody, and every provider retry after it would be answered
   * "already handled" — money taken, membership never granted, no way back.
   */
  userSubscriptions: UserSubscriptionRepositoryPort;
  /**
   * Read-only in this unit of work, for one value: the tier's `billing_cycle`,
   * which is what the paid period's length is computed from. Bound to the
   * transaction like everything else rather than to the pool, so the cycle a
   * period is measured with is the one that was true when the payment settled.
   */
  userTiers: UserTierRepositoryPort;
  webhookEvents: WebhookEventRepositoryPort;
}

/**
 * Runs the writes a successful payment triggers — record the event, settle the
 * transaction, activate the subscription — as ONE atomic unit.
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
 * RETIRE-TELEGRAM TASK 5 REMOVED THREE MEMBERS of this set — `subscriptions`,
 * `activityLog` and `outbox` — with the community branch of
 * `HandlePaymentWebhook` that was the only thing that used them. The `outbox`
 * one is worth naming: its presence here was the mechanism behind "the intent to
 * invite is atomic with the payment", and with the invite gone there is no
 * intent left to make atomic. A membership grants access by BEING active, so
 * nothing has to be sent for the activation to mean anything, and nothing here
 * queues work for the worker. Anything added later that must happen *after* a
 * payment commits belongs in this set for the reason above, and its SEND does
 * not: an external HTTP call inside this transaction would roll back a payment
 * we have already taken (plan, Global Constraints).
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
