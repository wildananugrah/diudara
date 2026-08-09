/**
 * The `event_type` of the row a payment activation queues: "give this
 * subscription's member access to their community's channels". Exported so the
 * writer (HandlePaymentWebhook) and the dispatcher (the worker's ProcessOutbox)
 * agree on the string without either importing the other.
 */
export const OUTBOX_GRANT_ACCESS = "grant_access";

/**
 * The `event_type` of the row a FAILED platform removal queues: "this member's
 * entitlement is gone but they are still in the group — try the removal again".
 *
 * Revocation itself stays synchronous, because a creator clicking "remove" has to be
 * told whether it worked. This is the durable record of what is still OUTSTANDING
 * when the provider call failed. Without it the membership was marked `revoked`,
 * `automated: false` was returned, and NOTHING ever retried — which for a creator
 * clicking a button is honest, but for Phase 5's churn job means a churned member
 * stays in the paid group forever with no record that a removal is owed.
 */
export const OUTBOX_REVOKE_ACCESS = "revoke_access";

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
  /**
   * Restarts a row's staleness clock, called as the row is DEQUEUED for handling.
   *
   * `claimBatch` stamps `updated_at` once for the whole batch and the rows are then
   * handled serially, so with `batchSize: 10` and a 15s adapter timeout a degraded
   * provider makes a pass outlive `staleProcessingMs` — and a second worker reclaims
   * rows the first has not reached yet. For a `grant_access` row that is a double
   * claim, which is how a second invite link gets minted for one paying member.
   *
   * Touching per row means the clock measures "how long has THIS row been worked on",
   * which is what the staleness threshold is actually about. `ProcessOutbox` also
   * bounds a pass's wall time and RELEASES what it did not reach, so the rows behind
   * a slow one are handed back deliberately rather than reclaimed out from under it.
   */
  touchProcessing(id: string): Promise<void>;
  /**
   * Returns rows this worker claimed but chose not to handle to `pending`, so they
   * are immediately claimable by anyone — including this worker's next pass.
   *
   * The counterpart to bounding a pass's wall time. Leaving them `processing` would
   * mean waiting for the reclaim timer, and the point of stopping early is to hand
   * them back BEFORE they look stale.
   *
   * `attempts` is deliberately untouched: the row was claimed, and a claim spends an
   * attempt whatever the outcome, or a row that always lands at the end of a slow
   * batch would be retried forever.
   */
  releaseToPending(ids: string[]): Promise<number>;
  markSent(id: string): Promise<void>;
  /**
   * Transient failure: the row becomes claimable again at `nextAttemptAt`.
   * `error` is stored for an operator to read, so it must never contain an invite
   * link or a provider token.
   */
  markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void>;
  /** Terminal failure. The row is never claimed again, and keeps `error`. */
  markPermanentlyFailed(id: string, error: string): Promise<void>;
  /**
   * Returns rows that have been `processing` since before `stuckBefore` to
   * `pending`, and answers how many.
   *
   * Without this, a worker killed mid-send (SIGKILL, OOM, a dead box) strands
   * its row in `processing` FOREVER: `claimBatch` only looks at `pending`, so
   * nothing retries it and a member who paid never receives an invite. That is
   * the same class of failure as losing the outbox row, arriving by a different
   * route.
   *
   * It must NOT reset `attempts`. A row that kills its worker on every attempt
   * would otherwise be reclaimed forever, which is exactly the unbounded retry
   * the phase forbids; keeping the count means the retry bound still ends it.
   */
  reclaimStaleProcessing(stuckBefore: Date): Promise<number>;
}
