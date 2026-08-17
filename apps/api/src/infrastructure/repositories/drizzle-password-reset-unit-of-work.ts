import type { db as DbClient } from "../../db/client";
import type {
  PasswordResetRepositories,
  PasswordResetUnitOfWorkPort,
} from "../../application/ports/password-reset-unit-of-work.port";
import { DrizzlePasswordResetRepository } from "./drizzle-password-reset.repository";
import { DrizzleUserRepository } from "./drizzle-user.repository";

export class DrizzlePasswordResetUnitOfWork implements PasswordResetUnitOfWorkPort {
  /**
   * Takes the pooled client specifically, not a `DatabaseExecutor`: opening
   * the transaction is this class's entire job — see
   * `DrizzlePaymentActivationUnitOfWork`, which this mirrors exactly.
   */
  constructor(private readonly db: typeof DbClient) {}

  /**
   * Both repositories are constructed against the transaction handle `tx`
   * rather than the pool, so every statement they issue joins this
   * transaction. `DrizzleUserRepository` needed its constructor widened from
   * `typeof DbClient` to `DatabaseExecutor` for this to type-check — see
   * that class's own docstring.
   */
  async run<T>(work: (repositories: PasswordResetRepositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      work({
        passwordResets: new DrizzlePasswordResetRepository(tx),
        users: new DrizzleUserRepository(tx),
      })
    );
  }
}
