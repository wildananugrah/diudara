import type { db as DbClient } from "../../db/client";
import type {
  StreamLifecycleRepositories,
  StreamLifecycleUnitOfWorkPort,
} from "../../application/ports/stream-lifecycle-unit-of-work.port";
import { DrizzleActivityLogRepository } from "./drizzle-activity-log.repository";
import { DrizzleEventRepository } from "./drizzle-event.repository";
import { DrizzleOutboxRepository } from "./drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";

/**
 * Mirrors `DrizzlePaymentActivationUnitOfWork` exactly — see that class's docstring for
 * the shape and why each repository is constructed against `tx` rather than the pool.
 */
export class DrizzleStreamLifecycleUnitOfWork implements StreamLifecycleUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening the
   * transaction is this class's entire job, so it needs the one handle that can.
   */
  constructor(private readonly db: typeof DbClient) {}

  async run<T>(work: (repositories: StreamLifecycleRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        events: new DrizzleEventRepository(tx),
        subscriptions: new DrizzleSubscriptionRepository(tx),
        activityLog: new DrizzleActivityLogRepository(tx),
        // Constructed against `tx` like the rest, which is the entire mechanism behind
        // "one notify row per member is atomic with the transition": the INSERTs it
        // issues are inside this transaction, so a failure anywhere in `work` discards
        // them along with everything else.
        outbox: new DrizzleOutboxRepository(tx),
      })
    );
  }
}
