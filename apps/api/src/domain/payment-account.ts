/**
 * The three states of `creator.xendit_account_id`, and the one value that is not
 * an account id.
 *
 * The column started with two states — NULL (not connected) and an id (connected)
 * — and that is exactly why `POST /payment-account` could mint orphaned Xendit
 * sub-accounts: with nowhere to record "a connection is in flight", the only way
 * to claim the row was to already HAVE the id, so the provider had to be called
 * first. Measured on this branch: 30 concurrent requests produced 30 sub-accounts,
 * 29 of them unreferenced; the same requests sequentially produced 1. Xendit
 * MANAGED sub-accounts are KYC entities with no delete endpoint, so every orphan
 * is permanent.
 *
 * The sentinel adds the missing third state, so the conditional UPDATE can happen
 * BEFORE the HTTP call and losing callers never reach the provider at all.
 */

/**
 * Written into `creator.xendit_account_id` for the duration of one
 * `POST /payment-account` attempt, then replaced by the real account id.
 *
 * Deliberately not id-shaped. Xendit account ids are 24-character hex object ids,
 * so the colon and the words are enough that this value can never be mistaken for
 * one — by a human reading the table, by a `for_account_id` sent to the provider,
 * or by a future migration. Do NOT change it to something id-like, and do not
 * make it random per attempt: `finishProvisioning`'s UPDATE predicate compares
 * against it, so it has to be a constant.
 */
export const XENDIT_ACCOUNT_PROVISIONING = "provisioning:in-progress";

/** True when the column holds the sentinel: claimed, but not yet connected. */
export function isProvisioningPlaceholder(xenditAccountId: string | null): boolean {
  return xenditAccountId === XENDIT_ACCOUNT_PROVISIONING;
}

/**
 * True only when the column names an account money can actually settle into.
 *
 * Every reader of `creator.xendit_account_id` must go through this rather than a
 * truthiness check, because the sentinel is truthy. `StartCheckout`'s truthiness
 * check would have passed the sentinel to `createInvoice` as `for_account_id`,
 * charging a member against an account that does not exist at the provider — the
 * half-provisioned window this function exists to close.
 */
export function isConnectedPaymentAccount(
  xenditAccountId: string | null
): xenditAccountId is string {
  return (
    xenditAccountId !== null &&
    xenditAccountId.length > 0 &&
    !isProvisioningPlaceholder(xenditAccountId)
  );
}
