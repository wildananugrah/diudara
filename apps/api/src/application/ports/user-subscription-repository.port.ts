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
  paidAt: Date | null;
  createdAt: Date;
}

export interface UserSubscriptionRepositoryPort {
  create(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<UserSubscriptionRow>;
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
  attachGatewayReference(transactionId: string, gatewayReferenceId: string): Promise<boolean>;
  /** Flips a transaction to `paid` and records when. */
  markTransactionPaid(id: string, paidAt: Date): Promise<UserTransactionRow | null>;
}
