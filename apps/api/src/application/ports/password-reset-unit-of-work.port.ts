import type { PasswordResetRepositoryPort } from "./password-reset-repository.port";
import type { UserRepositoryPort } from "./user-repository.port";

/** The repositories a completed reset must write through together. */
export interface PasswordResetRepositories {
  passwordResets: PasswordResetRepositoryPort;
  users: UserRepositoryPort;
}

/**
 * Runs the three writes a completed reset triggers — mark the presented
 * token used, mark every other outstanding token for that user used, and
 * `setPasswordAndBumpEpoch` — as ONE atomic unit, modelled on
 * `PaymentActivationUnitOfWorkPort`.
 *
 * This exists for the same reason that port does: a password changed with
 * no epoch bump would end no sessions (the reset becomes cosmetic — see
 * `requireUserAuth`'s docstring for why the epoch bump is the entire
 * mechanism), and an epoch bump with no password change would lock the
 * owner out with the old password still live nowhere. Splitting these two
 * writes across two transactions reopens exactly the window
 * `PaymentActivationUnitOfWorkPort` was built to close: a crash, a
 * connection drop, or a bug between them leaves the account in a state
 * nothing recovers from automatically.
 *
 * Unlike `PaymentActivationUnitOfWorkPort`, nothing INSERTed inside `work`
 * can raise a unique violation — both token-marking calls are UPDATEs, and
 * `setPasswordAndBumpEpoch` is too — so the hazard `drizzle-join-request.
 * repository.ts`'s `createPending` docstring describes (a raw 23505
 * aborting the enclosing transaction) does not apply here. Noted, not
 * guarded against, because there is nothing in this unit of work that could
 * raise one.
 *
 * The work function receives repositories already bound to the transaction,
 * so no port method grows a "pass the handle in" parameter and no
 * repository has to know whether it is inside a transaction.
 *
 * Anything thrown out of `work` must roll the whole unit back and propagate.
 */
export interface PasswordResetUnitOfWorkPort {
  run<T>(work: (repositories: PasswordResetRepositories) => Promise<T>): Promise<T>;
}
