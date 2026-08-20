/** One (subscriber, owner) membership relationship over time. */
export interface UserSubscriptionRow {
  id: string;
  subscriberId: string;
  tierId: string;
  ownerId: string;
  status: string;
  currentPeriodEnd: Date | null;
  createdAt: Date;
}

/**
 * A payment record for a subscription — what WE believe is owed. Task 7's
 * webhook compares the payment gateway's claim against `amount` and never
 * the other way round; see `handle-payment-webhook.ts`'s own docstring for
 * why that direction is the security property.
 */
export interface UserTransactionRow {
  id: string;
  userSubscriptionId: string;
  amount: number;
  status: string;
  gatewayReferenceId: string | null;
  /**
   * The provider's hosted payment page for this transaction, or `null` when no
   * invoice was ever opened for it (a failed provider call). Written together
   * with `gatewayReferenceId`; see `findPendingCheckout` for what it is for.
   */
  gatewayInvoiceUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** What `claimPending` hands back: the pair's pending subscription, and who put it there. */
export interface PendingSubscriptionClaim {
  subscription: UserSubscriptionRow;
  /**
   * True when THIS call inserted the row; false when another caller already
   * held the pair's pending slot and this is THEIR row.
   *
   * A caller that reads `false` must NOT open an invoice: the holder either has
   * one already (hand it back) or is opening one right now (tell the buyer to
   * try again in a moment). That is the whole point of the claim.
   */
  created: boolean;
}

/** What `findPendingCheckout` hands back: enough to re-answer a second tap without the provider. */
export interface PendingUserCheckout {
  subscriptionId: string;
  /** The tier the pending invoice was opened FOR — not necessarily the one now being asked for. */
  tierId: string;
  transactionId: string;
  invoiceUrl: string;
}

export interface UserSubscriptionRepositoryPort {
  /**
   * Raw INSERT. Rejects — it does not return null — when the pair already holds
   * a pending subscription, because `user_subscription_one_pending` is a
   * database constraint and not an application rule. `claimPending` below is
   * what production code calls; this stays for fixtures that want the row and
   * nothing else.
   */
  create(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<UserSubscriptionRow>;
  /**
   * CLAIMS this pair's one pending subscription slot, and reports whether this
   * call is what filled it.
   *
   * THE ARBITER, and it has to be the INSERT rather than a read before it.
   * `StartUserSubscription` used to check for a pending subscription and then
   * create one, and a re-review fired two concurrent `POST /subscribe` calls at
   * the real database: four runs serialised, the fifth produced two live
   * invoices, two subscriptions and two transactions for the identical pair —
   * one person charged twice for one membership, with no refund path anywhere
   * in 5a. A double tap on a phone is concurrent, not sequential.
   *
   * So the loser of the race learns it lost from `user_subscription_one_pending`
   * and is handed the WINNER's row with `created: false`, which routes it into
   * the reuse path instead of a second invoice. Nothing here is decided by a
   * read: this is the same conclusion Task 2's constraints and Task 3's
   * claim-first sentinel each reached.
   *
   * Implementations MUST match the unique violation narrowly — SQLSTATE `23505`
   * AND the constraint name — and rethrow anything else untouched. A blanket
   * catch would swallow a real failure and answer as though a row existed.
   */
  claimPending(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<PendingSubscriptionClaim>;
  findById(id: string): Promise<UserSubscriptionRow | null>;
  /**
   * Flips `status` to `active` and sets `current_period_end`. Task 7's
   * webhook calls this once the payment gateway confirms payment.
   */
  activate(id: string, periodEnd: Date): Promise<UserSubscriptionRow | null>;
  /**
   * Cancels a subscription — flips `status` to `cancelled`. This is the
   * other half of what makes `user_subscription_one_active` a PARTIAL unique
   * index rather than a permanent one-and-done: cancelling here is what lets
   * the same (subscriber, owner) pair become active again later.
   */
  cancel(id: string): Promise<UserSubscriptionRow | null>;
  /** Task 8's membership check: is this subscriber an active member of this owner. */
  findActiveFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null>;
  createTransaction(input: {
    userSubscriptionId: string;
    amount: number;
    gatewayReferenceId?: string | null;
  }): Promise<UserTransactionRow>;
  findTransactionById(id: string): Promise<UserTransactionRow | null>;
  /**
   * Records the provider's own invoice id against a transaction we already
   * created, so Task 7's webhook has something of OURS to check the delivered
   * `body.id` against.
   *
   * Written AFTER the invoice exists, and therefore as a second statement:
   * `StartUserSubscription` creates the rows BEFORE calling the provider (a
   * failed call must leave a pending row, never a live invoice pointing at
   * nothing), so the id it anchors on cannot be known at insert time.
   *
   * False when the transaction does not exist or already carries a reference —
   * the column is written exactly once, and overwriting it would destroy the
   * anchor. Mirrors `SubscriptionRepositoryPort.attachGatewayReference`, whose
   * own docstring records why the community webhook fails closed without it.
   */
  attachGatewayReference(
    transactionId: string,
    gatewayReferenceId: string,
    invoiceUrl: string
  ): Promise<boolean>;
  /**
   * The invoice already waiting to be paid for this (subscriber, owner) pair,
   * or `null` when there is none.
   *
   * THE SECOND-TAP GUARD (Phase 5a fix round 1, F2). Nothing dedupes PENDING
   * subscriptions: a buyer who taps "Jadi anggota" twice used to get two live
   * invoices, and if both were paid the second activation hit
   * `user_subscription_one_active` as a 500 with provider retries behind it —
   * so the person was simply charged twice, and 5a has no refund path. A second
   * live invoice must not be minted while one is pending for the same pair.
   *
   * "Pending" here means all three of: the subscription is `pending`, its
   * transaction is `pending`, and that transaction actually HAS an invoice url.
   * The third condition is what keeps a failed provider call — which leaves a
   * pending row with no invoice — from blocking the buyer forever.
   *
   * The most recent such transaction, when a subscription somehow has several.
   */
  findPendingCheckout(subscriberId: string, ownerId: string): Promise<PendingUserCheckout | null>;
  /** Flips a transaction to `paid` and records when. */
  markTransactionPaid(id: string, paidAt: Date): Promise<UserTransactionRow | null>;
}
