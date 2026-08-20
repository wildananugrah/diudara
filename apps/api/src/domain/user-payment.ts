/**
 * Prefixes the `external_id` of every user-subscription invoice.
 *
 * Xendit delivers ONE webhook stream, and the community-scoped handler already
 * resolves its own invoices by treating `external_id` as a bare `transaction.id`
 * uuid. A user-subscription invoice must be distinguishable WITHOUT GUESSING —
 * so it is namespaced here, the webhook routes on the prefix, and anything
 * matching neither shape is IGNORED rather than assumed to be either.
 */
export const USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX = "usub_";

export function userSubscriptionExternalId(transactionId: string): string {
  return `${USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX}${transactionId}`;
}

/** `null` when this external id belongs to something else — never a guess. */
export function userTransactionIdFromExternalId(externalId: string): string | null {
  return externalId.startsWith(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX)
    ? externalId.slice(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX.length)
    : null;
}
