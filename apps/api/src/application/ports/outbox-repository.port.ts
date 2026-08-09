/**
 * The `event_type` of the row a payment activation queues: "give this
 * subscription's member access to their community's channels". Exported so the
 * writer (HandlePaymentWebhook) and the dispatcher (the worker's ProcessOutbox)
 * agree on the string without either importing the other.
 */
export const OUTBOX_GRANT_ACCESS = "grant_access";

/** A row handed to a worker by `claimBatch`, already marked as being processed. */
export interface ClaimedOutboxRow {
  id: string;
  eventType: string;
  /** Whatever the enqueuer wrote. Ids only — never a provider payload. */
  payload: unknown;
  /**
   * How many times this row has been claimed, INCLUDING this claim. A bounded
   * retry policy reads it to decide between `markFailed` and
   * `markPermanentlyFailed`.
   */
  attempts: number;
}

/**
 * The transactional outbox.
 *
 * `enqueue` is called INSIDE the payment activation transaction (see
 * `PaymentActivationUnitOfWorkPort`), which is the whole point: the intent to
 * invite commits with the payment or not at all. Everything else is called by the
 * worker, outside any transaction — an external HTTP send must never be able to
 * roll back a paid activation.
 *
 * `claimBatch` is the only method with a concurrency requirement: two workers
 * polling the same table must never receive the same row, because one
 * `grant_access` row is one invite link and a double send means two links for one
 * paying member. It is therefore a conditional claim arbitrated by the database
 * (`WHERE status = 'pending' AND next_attempt_at <= now()` … `FOR UPDATE SKIP
 * LOCKED` … `RETURNING`), never a read followed by a write.
 */
export interface OutboxRepositoryPort {
  enqueue(input: { eventType: string; payload: unknown }): Promise<{ id: string }>;
  claimBatch(limit: number): Promise<ClaimedOutboxRow[]>;
  /** Terminal success. The row is never claimed again. */
  markSent(id: string): Promise<void>;
  /**
   * Transient failure: the row becomes claimable again at `nextAttemptAt`.
   * `error` is stored for an operator to read, so it must never contain an invite
   * link or a provider token.
   */
  markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void>;
  /** Terminal failure. The row is never claimed again, and keeps `error`. */
  markPermanentlyFailed(id: string, error: string): Promise<void>;
}
