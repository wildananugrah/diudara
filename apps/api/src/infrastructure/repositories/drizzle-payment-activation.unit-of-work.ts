import type { db as DbClient } from "../../db/client";
import type {
  PaymentActivationRepositories,
  PaymentActivationUnitOfWorkPort,
} from "../../application/ports/payment-activation-unit-of-work.port";
import { DrizzleActivityLogRepository } from "./drizzle-activity-log.repository";
import { DrizzleOutboxRepository } from "./drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";
import { DrizzleWebhookEventRepository } from "./drizzle-webhook-event.repository";

export class DrizzlePaymentActivationUnitOfWork implements PaymentActivationUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening the
   * transaction is this class's entire job, so it needs the one handle that can.
   */
  constructor(private readonly db: typeof DbClient) {}

  /**
   * Each repository is constructed against the transaction handle `tx` rather
   * than the pool, so every statement they issue joins this transaction. They
   * accept `DatabaseExecutor`, which `PgTransaction` satisfies, so none of them
   * needed a code change or a cast to become transaction-aware.
   *
   * `markPaid` opens a transaction of its own; nested inside this one drizzle
   * turns that into a SAVEPOINT, which is exactly right — it stays atomic when
   * called standalone and still rolls all the way out when it throws in here.
   */
  async run<T>(work: (repositories: PaymentActivationRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        subscriptions: new DrizzleSubscriptionRepository(tx),
        // Phase 5a's parallel flow. Constructed against `tx` for the same reason
        // as everything else here: a user subscription's activation and the
        // webhook_event row that authorises it must commit together.
        userSubscriptions: new DrizzleUserSubscriptionRepository(tx),
        userTiers: new DrizzleUserTierRepository(tx),
        webhookEvents: new DrizzleWebhookEventRepository(tx),
        activityLog: new DrizzleActivityLogRepository(tx),
        // Constructed against `tx` like the rest, which is the entire mechanism
        // behind "the intent to invite is atomic with the payment": the INSERT it
        // issues is inside this transaction, so a failure anywhere in `work`
        // discards it along with everything else.
        outbox: new DrizzleOutboxRepository(tx),
      })
    );
  }
}
