export interface SubscriptionRecord {
  id: string;
  memberId: string;
  tierId: string;
  status: string;
  nextBillingDate: string | null;
  startedAt: Date | null;
  retryCount: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionRecord {
  id: string;
  subscriptionId: string;
  amount: number;
  paymentMethod: string;
  status: string;
  gatewayReferenceId: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `subscription` and `transaction` both have an `updated_at` column with no
 * `BEFORE UPDATE` trigger (drizzle-kit does not generate triggers, and the
 * migration constraint forbids hand-written SQL). Every method here that
 * updates either table MUST set `updatedAt: new Date()` explicitly, or the
 * column silently freezes at creation time.
 */
export interface SubscriptionRepositoryPort {
  createPending(input: { memberId: string; tierId: string }): Promise<SubscriptionRecord>;
  createTransaction(input: {
    subscriptionId: string;
    amount: number;
    paymentMethod: string;
  }): Promise<TransactionRecord>;
  /** Used by Task 7's webhook handler: Xendit echoes our transaction id back as external_id. */
  findTransactionByExternalId(id: string): Promise<TransactionRecord | null>;
  /**
   * Used by Task 7: marks a transaction paid and activates its subscription.
   * Both rows are updates, so both must carry `updatedAt: new Date()`.
   */
  markPaid(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
  }): Promise<{ transaction: TransactionRecord; subscription: SubscriptionRecord }>;
}
