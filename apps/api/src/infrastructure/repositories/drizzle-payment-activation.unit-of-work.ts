import type { db as DbClient } from "../../db/client";
import type {
  PaymentActivationRepositories,
  PaymentActivationUnitOfWorkPort,
} from "../../application/ports/payment-activation-unit-of-work.port";
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
   * THAT BINDING IS THE WHOLE POINT OF THIS CLASS and it is invisible from the
   * outside — a repository built against the pool here would leave every test
   * that breaks the activation still green, because those failures happen before
   * the write. `drizzle-payment-activation.unit-of-work.test.ts` fails a unit of
   * work AFTER a write specifically to catch it.
   */
  async run<T>(work: (repositories: PaymentActivationRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        userSubscriptions: new DrizzleUserSubscriptionRepository(tx),
        userTiers: new DrizzleUserTierRepository(tx),
        webhookEvents: new DrizzleWebhookEventRepository(tx),
      })
    );
  }
}
