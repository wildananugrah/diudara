## Task 6: Starting a subscription

**Files:**
- Create: `apps/api/src/application/use-cases/start-user-subscription.ts`
- Create: `apps/api/src/domain/user-payment.ts`
- Modify: `apps/api/src/routes/users.ts`
- Test: alongside both.

**Interfaces:**
- Consumes: Tasks 1-3, the existing `PaymentProviderPort`.
- Produces: `StartUserSubscription`, `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX`, `POST /users/:handle/subscribe`.

- [ ] **Step 1: Write the namespace, and its reason, in `domain/user-payment.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing tests for the refusals**

Each in Bahasa, each naming the remedy: signed out is a 401; subscribing to yourself is refused (the DB check is the backstop, not the message); an inactive tier is refused; an owner with no connected payout account is refused; **already holding an active membership to this owner is refused** rather than creating a second pending row.

- [ ] **Step 3: Write the failing test for the happy path**

A `pending` subscription and a `pending` transaction are created, the invoice is opened against **the owner's** sub-account, and the returned `external_id` carries the prefix.

- [ ] **Step 4: Run, watch fail, implement**

Row before provider call, so a failed provider call leaves a `pending` row rather than an invoice pointing at nothing.

- [ ] **Step 5: Run the api suite once, then commit**

---

