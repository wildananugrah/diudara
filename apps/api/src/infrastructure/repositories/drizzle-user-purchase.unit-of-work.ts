import type { db as DbClient } from "../../db/client";
import type {
  UserPurchaseRepositories,
  UserPurchaseUnitOfWorkPort,
} from "../../application/ports/user-purchase-unit-of-work.port";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";

export class DrizzleUserPurchaseUnitOfWork implements UserPurchaseUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening the
   * transaction is this class's entire job — see
   * `DrizzlePaymentActivationUnitOfWork`, which this mirrors exactly.
   */
  constructor(private readonly db: typeof DbClient) {}

  /**
   * The repository is constructed against the transaction handle `tx` rather
   * than the pool, so the retirement and the claim it issues join the same
   * transaction and commit or roll back together. It accepts `DatabaseExecutor`,
   * which `PgTransaction` satisfies, so it needed no code change to become
   * transaction-aware — only `claimPending` did, and for a different reason
   * (see `UserPurchaseUnitOfWorkPort`'s own docstring).
   */
  async run<T>(work: (repositories: UserPurchaseRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({ subscriptions: new DrizzleUserSubscriptionRepository(tx) })
    );
  }
}
