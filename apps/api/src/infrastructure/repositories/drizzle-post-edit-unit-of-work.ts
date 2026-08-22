import type { db as DbClient } from "../../db/client";
import type {
  PostEditRepositories,
  PostEditUnitOfWorkPort,
} from "../../application/ports/post-edit-unit-of-work.port";
import { DrizzleMediaRepository } from "./drizzle-media.repository";
import { DrizzlePostRepository } from "./drizzle-post.repository";

export class DrizzlePostEditUnitOfWork implements PostEditUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening
   * the transaction is this class's entire job — see
   * `DrizzlePaymentActivationUnitOfWork`, which this mirrors exactly.
   */
  constructor(private readonly db: typeof DbClient) {}

  /**
   * Each repository is constructed against the transaction handle `tx`
   * rather than the pool, so `lockForEdit`'s row lock, the resulting-state
   * check, `updateBody` and `claim` all join the SAME transaction and commit
   * or roll back together. Both repositories accept `DatabaseExecutor`,
   * which `PgTransaction` satisfies, so neither needed a code change to
   * become transaction-aware.
   *
   * `DrizzleMediaRepository.claim` opens a transaction OF ITS OWN
   * (`release-then-claim`, two statements, one unit). Nested inside this
   * one, drizzle turns that into a SAVEPOINT — exactly the same shape
   * `DrizzlePaymentActivationUnitOfWork` already relies on for `markPaid`,
   * and verified safe here for the same reason: `claim` contains no
   * catch-driven unique-violation arbitration (it is a plain release/claim
   * UPDATE loop, not an INSERT racing a constraint), so there is nothing in
   * it that "current transaction is aborted" could poison. That hazard is
   * real elsewhere — see `UserSubscriptionRepositoryPort.claimPending`'s own
   * docstring — but it does not apply to this method.
   */
  async run<T>(work: (repositories: PostEditRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        posts: new DrizzlePostRepository(tx),
        media: new DrizzleMediaRepository(tx),
      })
    );
  }
}
