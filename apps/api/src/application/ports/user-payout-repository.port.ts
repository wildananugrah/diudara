/**
 * The ONLY shape that carries `app_user.xendit_account_id`, and the reason this
 * is a port of its own rather than four more methods on `UserRepositoryPort`.
 *
 * `UserRecord` is projected straight into HTTP responses (`toOwnProfile`,
 * `PATCH /users/me`), so widening it with the payout column would put a
 * provider account id on the wire everywhere a profile is returned. Keeping the
 * column on a separate shape — exactly the way `UserCredentials` is the only
 * shape that carries the password hash — means a handler has to ask for it on
 * purpose. It also matches Phase 5a's other two additions (`user_tier`,
 * `user_subscription`), each of which got its own port and its own Drizzle
 * repository rather than growing an existing one.
 */
export interface UserPayoutAccount {
  id: string;
  /** `app_user.email` is NOT NULL, unlike `creator.email` — the provider call always has one. */
  email: string;
  /** The business name sent to the provider. A user has no separate legal name. */
  displayName: string;
  /**
   * THREE states, not two: NULL, the `XENDIT_ACCOUNT_PROVISIONING` sentinel,
   * and a real account id. Read it through `isConnectedPaymentAccount` /
   * `isProvisioningPlaceholder` (`domain/payment-account.ts`) and never with a
   * truthiness check — the sentinel is truthy, and a truthy read is what would
   * send `for_account_id: "provisioning:in-progress"` to the provider.
   */
  xenditAccountId: string | null;
}

/**
 * The claim-first payout column on `app_user`, mirroring
 * `CreatorRepositoryPort`'s three provisioning methods for a different owner
 * table. Read that port's docstrings and `domain/payment-account.ts` for the
 * measured incident all of this exists to prevent: 30 concurrent connects once
 * produced 30 Xendit sub-accounts, 29 of them permanently orphaned, because the
 * only way to claim the row was to already HAVE the id.
 *
 * `creator.xendit_account_id` is untouched by any of this — a creator and an
 * app_user are different owners, and generalising the creator flow was
 * explicitly out of scope.
 */
export interface UserPayoutRepositoryPort {
  /** `null` when no such user. The payout column is never returned by any other read. */
  findPayoutAccount(userId: string): Promise<UserPayoutAccount | null>;
  /**
   * Claims the user's EMPTY `xendit_account_id` by writing
   * `XENDIT_ACCOUNT_PROVISIONING` into it, BEFORE any provider call happens.
   *
   * True only when this call was the one that filled it; false when the column
   * already held anything at all — a real id, or another caller's sentinel. The
   * implementation MUST decide that in a single conditional UPDATE
   * (`where id = ? and xendit_account_id is null`) and report the affected row
   * count. A `findPayoutAccount` in the use-case is a check-then-act and cannot
   * arbitrate two simultaneous callers.
   */
  beginXenditAccountProvisioning(userId: string): Promise<boolean>;
  /**
   * Replaces THIS caller's sentinel with the real account id, in one
   * conditional UPDATE predicated on the column still holding the sentinel.
   *
   * False when it does not — which, since only the sentinel holder ever writes
   * here, means someone edited the column by hand. An unconditional write would
   * silently redirect this user's money to an account they never connected.
   */
  finishXenditAccountProvisioning(userId: string, accountId: string): Promise<boolean>;
  /**
   * Releases THIS caller's sentinel back to NULL, same predicate as `finish`.
   *
   * Called when the provider call FAILS. Without it a single provider timeout
   * wedges the user forever: the sentinel blocks every later claim and there is
   * no operator-facing reset path for this column.
   */
  abandonXenditAccountProvisioning(userId: string): Promise<boolean>;
}
