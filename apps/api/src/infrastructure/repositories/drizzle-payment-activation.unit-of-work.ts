import type { db as DbClient } from "../../db/client";
import type {
  PaymentActivationRepositories,
  PaymentActivationUnitOfWorkPort,
} from "../../application/ports/payment-activation-unit-of-work.port";
import { DrizzleActivityLogRepository } from "./drizzle-activity-log.repository";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";
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
        webhookEvents: new DrizzleWebhookEventRepository(tx),
        activityLog: new DrizzleActivityLogRepository(tx),
      })
    );
  }
}
