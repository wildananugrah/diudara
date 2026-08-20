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
  /** Flips a transaction to `paid` and records when. */
  markTransactionPaid(id: string, paidAt: Date): Promise<UserTransactionRow | null>;
}
