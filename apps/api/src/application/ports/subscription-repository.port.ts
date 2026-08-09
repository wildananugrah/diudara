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

export interface MarkPaidResult {
  transaction: TransactionRecord;
  subscription: SubscriptionRecord;
  /**
   * The community the activated subscription belongs to, resolved through
   * `subscription → membership_tier → community` while activating.
   *
   * Returned rather than looked up again by the caller because the audit entry
   * (`activity_log.community_id` is NOT NULL) needs it, and there is no
   * unscoped tier-by-id port method to reach it with —
   * `MembershipTierRepositoryPort` is deliberately community-scoped throughout.
   */
  communityId: string;
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
  /**
   * Backs the public, unauthenticated status endpoint
   * (`GET /c/subscription/:subscriptionId/status`) — the id travels in a
   * redirect URL after checkout and may sit in browser history, so a value
   * that cannot possibly be an id must be reported as a MISS (`null`), never
   * raised as a driver error that would become a 500 instead of the 404 an
   * unknown/malformed id deserves. Same shape as
   * `findTransactionByExternalId` below, for the same reason.
   */
  findById(id: string): Promise<SubscriptionRecord | null>;
  /**
   * The subscription plus the community it belongs to, resolved through
   * `subscription → membership_tier → community`.
   *
   * Exists because the outbox worker starts from a subscription id and needs the
   * community to find the channels to grant — and there is no unscoped
   * tier-by-id port method to reach it with, for the same reason `MarkPaidResult`
   * carries `communityId`. Same MISS-not-error rule as `findById`.
   */
  findByIdWithCommunity(
    id: string
  ): Promise<{ subscription: SubscriptionRecord; communityId: string } | null>;
  createTransaction(input: {
    subscriptionId: string;
    amount: number;
    paymentMethod: string;
  }): Promise<TransactionRecord>;
  /**
   * Used by the webhook handler: Xendit echoes our transaction id back as
   * `external_id`. The argument therefore comes from an untrusted body, and a
   * value that cannot possibly be an id must be reported as a MISS (`null`) —
   * never raised as an error, which on this path would become a 500 instead of
   * the 404 an unknown external id deserves.
   */
  findTransactionByExternalId(id: string): Promise<TransactionRecord | null>;
  /**
   * Records the provider's own invoice id against a transaction we just created,
   * so the webhook has something of OURS to check `body.id` against.
   *
   * Returns false when the transaction does not exist or already carries a
   * reference: the column is written exactly once, at checkout, and overwriting
   * it would destroy the anchor the replay guard depends on. Conditional for the
   * same reason as `CreatorRepositoryPort.setXenditAccountId`.
   */
  attachGatewayReference(transactionId: string, gatewayReferenceId: string): Promise<boolean>;
  /**
   * Marks a transaction `success` and activates its subscription: `active`,
   * `started_at` (first activation only), and `next_billing_date` derived from
   * the tier's `billing_cycle`.
   *
   * Both rows are updates, so both must carry `updatedAt: new Date()`. The two
   * writes must be atomic with each other — a transaction recorded as collected
   * against a subscription that never activated is unrecoverable money.
   *
   * Returns **null** when the transaction was not `pending` — it has already
   * been settled, so this call is a no-op and the caller must not treat it as an
   * activation. The implementation MUST decide that with the status IN the UPDATE
   * predicate, not with a preceding read: `webhook_event.provider_event_id` is
   * the first line of replay defence, and this is the second, so it has to hold
   * even when two deliveries with different event ids reach the same transaction.
   * Throws only when the transaction does not exist at all.
   */
  markPaid(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
    /**
     * What the callback reported the payer actually used. Left alone when
     * `undefined`, so a callback that omits it does not overwrite the value
     * `createTransaction` recorded with the placeholder it is being replaced by.
     */
    paymentMethod?: string | undefined;
  }): Promise<MarkPaidResult | null>;
}
