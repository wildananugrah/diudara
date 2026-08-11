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

/**
 * Everything a renewal reminder MESSAGE needs, resolved in one read.
 *
 * The message names the community and the amount and carries a checkout link to
 * `/c/:slug`, so the sender needs the community's name and slug and the tier's price —
 * and it runs in the worker, which has no creator to scope a community lookup by and no
 * unscoped tier-by-id read to reach the price with. Rather than adding two unscoped
 * by-id methods to two deliberately-scoped repositories, the join that already exists
 * (`subscription → membership_tier → community`) hands back what the message needs.
 *
 * The community's `status` is included so a reminder is not sent for a community
 * archived between the pass claiming the stage and the worker handling the row.
 */
export interface RenewalReminderContext {
  subscription: SubscriptionRecord;
  tier: { id: string; name: string; priceAmount: number; billingCycle: string };
  community: { id: string; name: string; slug: string; status: string };
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
  /**
   * The transaction is now `success` and the subscription is `active`.
   *
   * `renewed` distinguishes a first activation from a RENEWAL, which is a distinction
   * only this method can make: `StartCheckout` reuses the subscription row when a member
   * renews, so the caller cannot tell afterwards what status the row was in before. The
   * two are audited differently — Phase 6 counts new members, and a renewal recorded as
   * a join would inflate that for ever.
   */
  | ({ outcome: "activated"; renewed: boolean } & MarkPaidResult)
  /** Already `success`. An idempotent no-op, and the caller must answer 2xx. */
  | { outcome: "already_settled"; status: string }
  /**
   * Some other non-`pending` status — today only `failed`. A genuine payment for
   * one of these must be surfaced, never absorbed.
   */
  | { outcome: "conflicting_status"; status: string }
  /**
   * The transaction was `pending` and settleable, but its SUBSCRIPTION has already
   * been CHURNED. Nothing was written: the whole statement is rolled back, including
   * the transaction's own settlement, so the delivery can be replayed.
   *
   * `churned` is terminal (see `CHURNED_SUBSCRIPTION` in the implementation) and this
   * outcome is what makes that true rather than merely stated. The window is real: a
   * member goes `past_due`, opens the checkout link in their own reminder, and the
   * churn pass reaches their deadline between the invoice being created and the
   * callback arriving. Left unguarded, the UPDATE — predicated only on the id —
   * flipped `churned` back to `active`, and three things followed: the member's
   * pending `revoke_subscription_access` row then evicted a paid-up member; the
   * "renewal" reactivated a revoked membership and minted a SECOND invite link, which
   * spec §7 forbids; and the state machine's terminal state was no longer terminal,
   * which every later reader (Phase 6 included) would have been misled by.
   *
   * IT MUST NOT SILENTLY DROP THE MONEY, which is why it is a rollback and not a
   * shrug. The caller gets the same loud `ALERT` + refusal treatment as
   * `conflicting_status`: nothing is recorded, the webhook event id stays unspent, and
   * the payment is visible and replayable once a person has decided what the member
   * should get — which is a fresh subscription, not a resurrected one.
   */
  | { outcome: "subscription_churned"; subscriptionStatus: string }
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
   * The member's CURRENT subscription to this tier — `active` or `past_due` — or null.
   *
   * Read by `StartCheckout`, which has to tell three cases apart and cannot do it with a
   * boolean:
   *
   *   - nothing         → an ordinary first purchase.
   *   - `past_due`, or `active` inside the reminder window → a RENEWAL. The row is
   *     reused; see `isInsideRenewalWindow` for the predicate and why it is that one.
   *   - `active` and nowhere near renewal → 409, which is Phase 3's rule unchanged.
   *     Without it the member was charged, `markPaid` returned `superseded`, the
   *     subscription was `cancelled`, no outbox row was enqueued so no WhatsApp message
   *     was sent at all, and the status page read `cancelled`. Money in, nothing out,
   *     member never told.
   *
   * This REPLACED a `hasActiveSubscriptionForTier(): boolean`, which could not express
   * the middle case and therefore refused every renewal by an `active` member — including
   * the one who clicked the link in their own `pre_3d` reminder.
   *
   * `past_due` is included precisely because it is renewable; `churned` and `cancelled`
   * are NOT, so a member who was revoked buys a fresh subscription (and a fresh grant,
   * with the unban that needs) rather than resurrecting a dead one.
   *
   * A READ, so it is inherently racy — two checkouts a millisecond apart both see
   * "nothing". That is fine and deliberate: `subscription_member_tier_active_unique` plus
   * the `superseded` outcome remain the backstop for the race. This closes the ORDINARY
   * case, which is a person tapping pay again a minute later, and it closes it at the
   * only point where refusing costs nobody any money.
   *
   * When both an `active` and a `past_due` row somehow exist for one (member, tier) — the
   * partial unique index only covers `active`, so history can contain it — the `active`
   * one is authoritative, because it is the one that grants access.
   */
  findCurrentSubscriptionForTier(
    memberId: string,
    tierId: string
  ): Promise<SubscriptionRecord | null>;
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
   * IT IS ALSO THE RENEWAL PATH, because `StartCheckout` reuses the subscription row
   * when a member renews (see `findCurrentSubscriptionForTier`). Three things therefore
   * happen here that only matter for a renewal, and all three are in the SAME
   * transaction as the status change:
   *
   *  1. `grace_ends_at` is CLEARED. A renewed subscription has no deadline.
   *  2. The subscription's `renewal_reminder` rows are DELETED. That table's unique
   *     `(subscription_id, stage)` is total, not partial, so a row that survives a
   *     renewal makes the next period's reminder for that stage read as already
   *     claimed — the member is never reminded again, invisibly, for a whole cycle.
   *     Same transaction, so a failure cannot leave them half-cleared.
   *  3. `next_billing_date` advances from the LATER of `paidAt` and the due date being
   *     paid for, so renewing early does not shorten the membership. See
   *     `renewalAnchor` in the implementation.
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
  /**
   * Subscriptions the CHURN pass has to act on: `past_due`, with a STORED
   * `grace_ends_at` that `now` is already past.
   *
   * IT MUST FILTER BY STATUS, for a sharper reason than `findDueForRenewal`'s. The
   * deadline column is not cleared when a subscription leaves `past_due` — a renewal
   * clears it, but nothing else does, and a status is the only thing that says whether
   * a deadline still means anything. A query on `grace_ends_at <= now` alone would read
   * a member who PAID ON DAY 5 as overdue and revoke the access they had just renewed;
   * it would also keep re-reading every subscription churned in the last year, since
   * their deadlines stay in the past for ever.
   *
   * The deadline is READ, never recomputed from `next_billing_date` (Global
   * Constraints): it is a promise made to a member about the day they lose access, and
   * a `null` here means "no deadline was ever stored", which must exclude the row
   * rather than derive one. Strictly `<`, matching `isPastGrace` — at the deadline the
   * member still has access, because losing it is irreversible from their side.
   *
   * UNLIKE `findDueForRenewal` THIS NEEDS NO CURSOR, and the asymmetry is the point: a
   * churned subscription LEAVES this result set, because the pass writes the very
   * status the filter excludes. So `limit` bounds a query without starving the tail —
   * successive queries see a strictly smaller backlog. `findDueForRenewal` has the
   * opposite property (a reminded subscription stays `past_due`), which is why it
   * carries a keyset.
   *
   * `communityStatus` travels with each row for the same reason it does on
   * `DueRenewalRecord`: an archived community's member is not evicted (spec §8), and
   * the pass has no creator to scope a community lookup by.
   */
  findPastGraceDeadline(input: { now: Date; limit: number }): Promise<DueRenewalRecord[]>;
  /**
   * Moves a `past_due` subscription to `churned`, and answers whether this call is the
   * one that did it.
   *
   * `status = 'past_due'` MUST be in the UPDATE predicate, not read first. That is the
   * entire idempotency mechanism of the churn pass: the row that flips the status is
   * also the row that decides who enqueues the revoke, so a second pass — or a
   * concurrent one — gets `false` and enqueues nothing. A read followed by an
   * unconditional write looks identical in every sequential test and revokes twice the
   * moment two passes overlap.
   *
   * `grace_ends_at` is deliberately LEFT AS IT IS: it records the deadline this member
   * was actually measured against, and an audit of a disputed eviction needs it. Only a
   * renewal clears it, because only a renewal makes it meaningless.
   *
   * `subscription` has no `BEFORE UPDATE` trigger, so this must set `updatedAt`
   * explicitly like every other write here.
   */
  markChurned(subscriptionId: string): Promise<boolean>;
  /**
   * Whether this member still holds a LIVE subscription — `active` or `past_due` — to
   * ANY tier of this community.
   *
   * It answers one question, asked at the far end of the outbox by
   * `RevokeChannelAccessForSystem`: is this member still entitled to be in this
   * community's groups? A `revoke_subscription_access` row can sit for a long time (a
   * provider outage, a stopped worker, a reclaimed row), and access must reflect the
   * entitlement as it is NOW — the same rule `GrantChannelAccess`, `SendRenewalReminder`
   * and `RetryChannelAccessRevocation` each apply at their own end of the queue.
   *
   * WHY IT IS NOT "is this subscription still churned". That question is asked too, and
   * it is not enough on its own: a churned member who pays again gets a NEW subscription
   * row (see `findCurrentSubscriptionForTier`), so the row the stale revoke names stays
   * `churned` for ever while the member is legitimately back in the group. Only the
   * community-wide entitlement covers that, and it also covers the member who holds two
   * tiers of one community and churns out of one of them — channel access is
   * community-wide, so evicting them for the tier they dropped would take away the one
   * they still pay for.
   *
   * Community-scoped through `subscription → membership_tier → community`, for the same
   * reason `findByIdWithCommunity` is: the worker has no creator to scope a lookup by.
   */
  hasLiveSubscriptionInCommunity(memberId: string, communityId: string): Promise<boolean>;
  /**
   * One subscription with the tier and community a reminder message needs — see
   * `RenewalReminderContext`.
   *
   * Same MISS-not-error rule as `findById`: the id arrives out of an outbox payload,
   * which is a jsonb column that can outlive a deploy, so a value that cannot be a uuid
   * must be reported as a miss and turned into a clear "not found" by the caller rather
   * than a driver error carrying bound parameters into the worker's log.
   */
  findRenewalContext(subscriptionId: string): Promise<RenewalReminderContext | null>;
  /**
   * Every subscription CURRENTLY `active` in this community, resolved through
   * `subscription → membership_tier → community` like the other community-scoped
   * reads on this port — the set `NotifyStreamLive` (Task 5) messages when a
   * creator goes live.
   *
   * DELIBERATELY NARROWER than `RENEWABLE_STATUSES` (`active` only, not
   * `past_due`): a grace-period member keeps their Telegram access, but
   * `AuthoriseStream`'s read entitlement re-check requires `active` for the
   * SAME reason a watch token must — see `ENTITLED_STATUS` in
   * `authorise-stream.ts`. Sending a `past_due` member a watch link whose
   * every segment request then 403s would be worse than not sending one.
   *
   * READ FRESH, at delivery time, by design — see the port docstring's note
   * on `findDueForRenewal` for the general shape, and `NotifyStreamLive`'s own
   * docstring for why THIS particular read is the one that answers "did this
   * member churn between go-live and delivery".
   */
  listActiveForCommunity(communityId: string): Promise<{ id: string; memberId: string }[]>;
}
