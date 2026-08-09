export interface SubscriptionRecord {
  id: string;
  memberId: string;
  tierId: string;
  status: string;
  /**
   * The `date` column verbatim — `"2026-03-10"`, a DAY and not an instant. Phase 5's
   * reminder pass turns it into `new Date("2026-03-10")` (UTC midnight, 07:00 WIB,
   * comfortably inside the intended Asia/Jakarta day) and compares WIB calendar days;
   * see `jakartaDayNumber` for why anything else moves the boundary by seven hours.
   */
  nextBillingDate: string | null;
  /**
   * When this subscription's grace period runs out, or null when it is not `past_due`.
   *
   * WRITTEN ONCE, when the subscription ENTERS `past_due`, and never recomputed — see
   * the column comment in db/schema.ts and `markPastDue` below. It is a promise made to
   * a member about the day they lose access, so a later pass, a config change or a
   * timezone correction must not be able to move it.
   */
  graceEndsAt: Date | null;
  startedAt: Date | null;
  retryCount: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A subscription the renewal pass has to consider, with the community it belongs to
 * resolved through `subscription → membership_tier → community`.
 *
 * The community's STATUS travels with it because the pass has to decide whether the
 * community still wants renewals at all (an archived one gets no reminders and no
 * revocation, spec §8) — and there is no unscoped community-by-id port method to look
 * it up with, for exactly the same reason `MarkPaidResult` carries `communityId`:
 * `CommunityRepositoryPort` is deliberately creator-scoped, and the renewal pass has no
 * creator.
 */
export interface DueRenewalRecord {
  subscription: SubscriptionRecord;
  communityId: string;
  communityStatus: string;
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
 * What `markPaid` did, or why it did nothing.
 *
 * This used to be `MarkPaidResult | null`, and the `null` conflated two states
 * that must be handled differently. The UPDATE is predicated on
 * `status = 'pending'`, so it affects zero rows for `success` AND for `failed` —
 * and the caller reported both as "already settled, no second activation", HTTP
 * 200. For `success` that is exactly right: it is a replay, and a 2xx is what
 * stops the provider retrying.
 *
 * For `failed` it silently threw a real payment away. Xendit does not retry a
 * 200, and the delivery cannot be replayed afterwards either, because the event id
 * is spent — so money was taken, access was never granted, and the only trace was
 * a log line that called it a duplicate. `failed` is not a status a payment
 * *arrives* into by accident; it means our record and the provider's disagree,
 * which is a person's problem rather than a no-op.
 *
 * The status is already in hand — the implementation reads it to tell "no such
 * transaction" from "not pending any more" — so carrying it out costs nothing.
 */
export type MarkPaidOutcome =
  /** Was `pending`, now `success`; the subscription is active. */
  | ({ outcome: "activated" } & MarkPaidResult)
  /** Already `success`. An idempotent no-op, and the caller must answer 2xx. */
  | { outcome: "already_settled"; status: string }
  /**
   * Some other non-`pending` status — today only `failed`. A genuine payment for
   * one of these must be surfaced, never absorbed.
   */
  | { outcome: "conflicting_status"; status: string }
  /**
   * The transaction settled, but the member ALREADY holds an active subscription
   * to this tier, so this one was `cancelled` instead of activated.
   *
   * A double-submit at checkout creates two pending subscriptions for one
   * (member, tier), and Phase 4 is the first phase to act on one — each
   * activation enqueues a `grant_access` row, so two activations mean two
   * single-use invite links for the same member, one of which can be forwarded to
   * somebody who never paid. The rule is first-to-activate wins; the second is
   * superseded.
   *
   * The transaction is still `success`, because the money really did arrive.
   * Recording it as anything else would hide a refund that is owed, and would let
   * a later delivery activate it. The caller must audit this and must NOT enqueue
   * a grant. `subscription` is the cancelled row, so the audit entry has the
   * member and the id.
   */
  | ({ outcome: "superseded" } & MarkPaidResult);

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
   * Whether this member ALREADY holds an active subscription to this tier.
   *
   * Read by `StartCheckout` to refuse a purchase before an invoice exists, and it is
   * not a nicety: re-paying is exactly what a member does when an invite did not
   * arrive. Without this the member was charged, `markPaid` returned `superseded`,
   * the subscription was `cancelled`, NO outbox row was enqueued so no WhatsApp
   * message was sent at all, and the status page read `cancelled`. Money in, nothing
   * out, member never told.
   *
   * A READ, so it is inherently racy — two checkouts a millisecond apart both see
   * "no". That is fine and deliberate: `subscription_member_tier_active_unique` plus
   * the `superseded` outcome remain the backstop for the race. This closes the
   * ORDINARY case, which is a person tapping pay again a minute later, and it closes
   * it at the only point where refusing costs nobody any money.
   */
  hasActiveSubscriptionForTier(memberId: string, tierId: string): Promise<boolean>;
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
   * same reason as `CreatorRepositoryPort.beginXenditAccountProvisioning`.
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
   * Reports what happened as a `MarkPaidOutcome` — see that type for why a bare
   * `null` was not enough. The implementation MUST decide "was it pending?" with
   * the status IN the UPDATE predicate, not with a preceding read:
   * `webhook_event.provider_event_id` is the first line of replay defence and
   * this is the second, so it has to hold even when two deliveries with different
   * event ids reach the same transaction. Throws only when the transaction does
   * not exist at all.
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
  }): Promise<MarkPaidOutcome>;
  /**
   * Subscriptions the renewal pass has to look at: those due on or before
   * `dueOnOrBefore`, longest-overdue first.
   *
   * IT MUST FILTER BY STATUS — `active` and `past_due` only. Two reasons, and the
   * second is the one that bites: `dueStageFor` saturates at `overdue_7d` rather than
   * ever returning null again, so a `churned` subscription from a year ago would be
   * read on every pass for ever and the pass would keep attempting inserts the unique
   * index rejects (safe, but noisy); and a `pending` subscription that never activated,
   * or a `cancelled` one, would be dunned for a membership nobody holds.
   *
   * `dueOnOrBefore` is INCLUSIVE and is a `YYYY-MM-DD` date string, not an instant —
   * `next_billing_date` names a day. Callers build it with
   * `latestDueDateInReminderWindow`, so the SQL cut-off and the schedule agree about
   * which Asia/Jakarta day it is; a row filtered out here is never offered to the
   * schedule at all, and the member is simply never reminded.
   *
   * `limit` bounds ONE QUERY, and `after` is how the caller walks past it — a keyset
   * cursor on the same `(next_billing_date, id)` the results are ordered by. That
   * pairing is not an optimisation, it is the only correct shape: unlike the outbox,
   * a reminded subscription does NOT leave this result set (the claim lives in
   * `renewal_reminder`, and adding a "not yet claimed" predicate here would need the
   * stage, which only the schedule knows). So a bare `limit` returns the SAME rows on
   * every pass, and any subscription past the limit is never reminded at all — a
   * silent starvation that grows with the backlog. Measured as exactly that: with a
   * limit of 1 and two due members, the second was never reached.
   *
   * `id` is in both the order and the cursor because `next_billing_date` is a DAY: a
   * whole cohort ties on it, and a cursor that only carried the date would either skip
   * or repeat the rest of the cohort.
   */
  findDueForRenewal(input: {
    dueOnOrBefore: string;
    limit: number;
    /** Exclusive: return rows ordered strictly after this one. */
    after?: { nextBillingDate: string; id: string };
  }): Promise<DueRenewalRecord[]>;
  /**
   * Moves an `active` subscription to `past_due` and records the grace deadline it is
   * measured against. Answers whether it actually made the transition.
   *
   * `status = 'active'` MUST be in the UPDATE predicate, not read first. That is what
   * makes `grace_ends_at` WRITE-ONCE: a later pass — or a concurrent one — never
   * reaches a row that is already `past_due`, so a deadline a member has already been
   * given cannot move under them. A read followed by an unconditional write would look
   * identical in every sequential test and shift the deadline the moment two passes
   * overlapped, or the moment the grace length was reconfigured.
   *
   * `subscription` has no `BEFORE UPDATE` trigger, so this must set `updatedAt`
   * explicitly like every other write here.
   */
  markPastDue(subscriptionId: string, graceEndsAt: Date): Promise<boolean>;
}
