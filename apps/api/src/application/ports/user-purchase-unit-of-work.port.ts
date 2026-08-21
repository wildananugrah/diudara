import type { UserSubscriptionRepositoryPort } from "./user-subscription-repository.port";

/** The repositories that must succeed or fail together when a membership is bought. */
export interface UserPurchaseRepositories {
  /**
   * `user_subscription` — and ONLY it. Everything else `StartUserSubscription`
   * touches inside this unit is a read of a table this transaction does not
   * write, so nothing else belongs in here.
   *
   * **NOTHING IN `work` MAY REACH FOR A SECOND CONNECTION.** This repository is
   * bound to the open transaction; a repository bound to the POOL, called from
   * inside `work`, checks out a second connection while this one is still held.
   * The pool is ten connections wide (postgres-js's default, unset in
   * `DATABASE_URL`), so ten concurrent buyers each holding a transaction and
   * each waiting for a second connection is a deadlock that resolves only by
   * timeout — measured on this endpoint's thirty-way race. That is why
   * `StartUserSubscription` reads the subscriber BEFORE it opens this unit.
   */
  subscriptions: UserSubscriptionRepositoryPort;
}

/**
 * Retiring a lapsed membership and claiming this pair's pending slot, as ONE
 * atomic unit — Phase 5b, Task 2.
 *
 * **WHY THESE TWO WRITES CANNOT COMMIT SEPARATELY.** 5b's renewal mechanism is
 * "buy again": there is no recurring charge anywhere in this system, so a
 * lapsed member's row — still `status = 'active'`, still holding
 * `user_subscription_one_active`'s slot — has to be retired before the same
 * pair can claim a fresh pending one. If the retirement committed on its own
 * and the claim then failed, that person would hold NEITHER an active
 * membership NOR a pending checkout: their history says their membership
 * expired and nothing was opened in its place. Wrapping both removes the
 * choice — the claim's failure rolls the retirement back, so the row is exactly
 * as the buyer left it and the next tap starts from the same place.
 *
 * The provider call is emphatically NOT in here, and neither are
 * `createTransaction` or `attachGatewayReference`. `StartUserSubscription`
 * writes its rows before calling Xendit precisely so a failed call leaves an
 * inspectable pending row; holding a database transaction open across an
 * outbound HTTP request is the failure `PaymentActivationUnitOfWorkPort`'s own
 * docstring forbids for the same reason.
 *
 * **THE CLAIM'S ARBITRATION HAD TO CHANGE TO LIVE IN HERE.**
 * `UserSubscriptionRepositoryPort.claimPending` used to catch `23505` on
 * `user_subscription_one_pending` — clean while it was the last statement of
 * its own connection, and poison inside a transaction, because Postgres has
 * already aborted the transaction by the time the catch runs and the read that
 * follows fails with "current transaction is aborted". It now arbitrates with
 * `ON CONFLICT ... DO NOTHING`, exactly as `JoinRequestRepositoryPort.createPending`
 * does and for exactly that reason. See that port's docstring.
 *
 * The work function receives a repository already bound to the transaction, so
 * no port method grows a "pass the handle in" parameter and no repository has
 * to know whether it is inside a transaction.
 *
 * Anything thrown out of `work` must roll the whole unit back and propagate —
 * including the `ConflictError` that refuses a member who is still inside their
 * paid period. Nothing was retired in that case (the refusal and the retirement
 * are mutually exclusive by construction: `retireExpired` only moves a row
 * whose period has already lapsed), so the rollback discards nothing.
 */
export interface UserPurchaseUnitOfWorkPort {
  run<T>(work: (repositories: UserPurchaseRepositories) => Promise<T>): Promise<T>;
}
