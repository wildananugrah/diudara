/**
 * The replay defence for provider webhooks.
 *
 * Xendit authenticates callbacks with a STATIC `X-CALLBACK-TOKEN` header rather
 * than an HMAC over the payload, so the token authenticates the SENDER and
 * carries no nonce, no timestamp and therefore NO replay protection at all.
 * Anyone who captures one delivery can resend it verbatim forever. The UNIQUE
 * constraint on `webhook_event.provider_event_id` is the entire defence: the
 * existence of a row means "already handled".
 */
export interface WebhookEventRepositoryPort {
  /**
   * Records an event and reports whether it is NEW.
   *
   * Implementations MUST let the database arbitrate — `onConflictDoNothing` on
   * `provider_event_id`, never a `select`-then-`insert` pre-check. Two Xendit
   * retries landing on two workers at the same instant both pass any pre-check,
   * and the loser then 500s on the unique violation while the caller has
   * already decided to activate. Phase 2 shipped that exact shape twice.
   *
   * @returns `true` when this call inserted the row, `false` when the event id
   *   was already present (the caller must then do nothing at all).
   */
  recordIfNew(input: {
    provider: string;
    /**
     * A PER-DELIVERY identity, not the invoice id. Keying on the invoice would
     * make a legitimate `invoice.expired` arriving after `invoice.paid` for the
     * same invoice look like a replay and be silently swallowed.
     */
    providerEventId: string;
    eventType: string;
    payload: unknown;
  }): Promise<boolean>;
}
