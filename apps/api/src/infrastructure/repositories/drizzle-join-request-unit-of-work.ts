import type { db as DbClient } from "../../db/client";
import type {
  JoinRequestRepositories,
  JoinRequestUnitOfWorkPort,
} from "../../application/ports/join-request-unit-of-work.port";
import { DrizzleActivityLogRepository } from "./drizzle-activity-log.repository";
import { DrizzleJoinRequestRepository } from "./drizzle-join-request.repository";
import { DrizzleOutboxRepository } from "./drizzle-outbox.repository";
import { DrizzleSubscriptionRepository } from "./drizzle-subscription.repository";

export class DrizzleJoinRequestUnitOfWork implements JoinRequestUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening the
   * transaction is this class's entire job, so it needs the one handle that can
   * — see `DrizzlePaymentActivationUnitOfWork`, which this mirrors exactly.
   */
  constructor(private readonly db: typeof DbClient) {}

  /**
   * Each repository is constructed against the transaction handle `tx` rather
   * than the pool, so every statement they issue joins this transaction. They
   * accept `DatabaseExecutor`, which `PgTransaction` satisfies, so none of them
   * needed a code change or a cast to become transaction-aware.
   */
  async run<T>(work: (repositories: JoinRequestRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        joinRequests: new DrizzleJoinRequestRepository(tx),
        // Constructed against `tx` like the rest, which is the entire mechanism
        // behind "the notification is atomic with the request": the INSERT it
        // issues is inside this transaction, so a failure anywhere in `work`
        // discards it along with everything else.
        outbox: new DrizzleOutboxRepository(tx),
        activityLog: new DrizzleActivityLogRepository(tx),
        // Task 4: `createActiveWithoutBilling` must run in the SAME transaction
        // as `joinRequests.decide` and the `grant_access` enqueue — see
        // `JoinRequestRepositories.subscriptions`'s own docstring.
        subscriptions: new DrizzleSubscriptionRepository(tx),
      })
    );
  }
}
