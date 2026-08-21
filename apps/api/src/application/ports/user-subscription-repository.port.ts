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

/**
 * One live invoice at the payment provider, addressed the way the provider needs
 * it: the invoice's own id, and the CREATOR's sub-account it was created under.
 * `SweepStalePendingCheckouts` hands this straight to
 * `PaymentProviderPort.expireInvoice`.
 */
export interface ExpirableInvoiceRef {
  invoiceId: string;
  forAccountId: string;
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

/**
 * One row of a creator's subscriber list — the wire's CLOSED public
 * projection and nothing else. Spec §8 of the 5b design: a subscriber list
 * is NOT public information, and what may ever cross this boundary is
 * `{ handle, displayName, since }` — never an email, a `whatsapp_number`,
 * a payout id (`app_user.xendit_account_id`), and never a subscriber's own
 * memberships to anyone else. Selected as exactly these three columns at
 * the query (see `DrizzleUserSubscriptionRepository`'s
 * `subscriberProjection`), the same discipline `DrizzleFollowRepository`'s
 * `publicListColumns` uses — the excluded columns are never fetched from
 * the database in the first place, not merely stripped afterwards.
 */
export interface SubscriberRow {
  handle: string;
  displayName: string;
  /** When this membership began — the subscription row's own `created_at`. */
  since: Date;
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
   * Implementations MUST arbitrate with `ON CONFLICT ... DO NOTHING` naming
   * `user_subscription_one_pending`'s own partial predicate, NEVER a bare
   * INSERT caught for a unique violation. A caught `23505` is clean on its own
   * connection, and poison inside a transaction: Postgres has already aborted
   * the transaction by the time the catch runs, so the read that follows — and
   * everything the CALLER does afterwards in the same transaction — fails with
   * "current transaction is aborted" instead of proceeding. Phase 5b's
   * `UserPurchaseUnitOfWorkPort` calls this inside one, and the loser is
   * emphatically not the last statement there: it goes on to read its winner's
   * checkout. Identical reasoning, and identical wording, to
   * `JoinRequestRepositoryPort.createPending`.
   *
   * Naming the conflict target keeps the arbitration narrow, which is what a
   * constraint-name check used to buy: a conflict on any OTHER index of this
   * table is a different bug and must still raise, never be answered as
   * "somebody else is already paying".
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
  /**
   * Retires this pair's ACTIVE subscription once its period has lapsed —
   * flips `status` to `expired`, which is what frees
   * `user_subscription_one_active`'s slot for a fresh purchase.
   *
   * There is no recurring charge anywhere in this system — the Xendit
   * adapter has exactly two operations and no tokenisation — so "renewal"
   * means "buy again", and the only thing standing between a lapsed member
   * and a second purchase is this row still holding the unique-index slot.
   * Task 2 calls this inside the purchase transaction; Task 3 calls it from
   * the worker sweep.
   *
   * THE ARBITER is a conditional UPDATE — `status = 'active' and
   * current_period_end <= now` in the WHERE clause — not a read followed by
   * a write. 5a reached the same conclusion three times over (its
   * subscription constraints, its payout claim, its pending checkout): the
   * read-then-write version passes its tests right up until two callers run
   * concurrently.
   *
   * Returns whether a row actually moved: false when there is nothing active
   * for the pair, or its period has not lapsed yet.
   */
  retireExpired(subscriberId: string, ownerId: string, now: Date): Promise<boolean>;
  /**
   * ACTIVE subscriptions whose period has already lapsed — what Task 3's
   * worker sweep pages through, retiring each one by calling `retireExpired`
   * on it in turn. `limit` bounds a single pass.
   */
  listExpiredActive(now: Date, limit: number): Promise<UserSubscriptionRow[]>;
  /**
   * `pending` subscriptions whose `created_at` is at or before `cutoff` — what
   * Task 5's worker sweep pages through, expiring each one by calling
   * `expireStalePending` on it in turn. `limit` bounds a single pass.
   *
   * This is 5a's most likely real-world money loss (final review): nothing in
   * 5a ever expires a pending row, so an abandoned cart returned to later is
   * handed back the same now-dead invoice — `findPendingCheckout` requires
   * only `status = 'pending'` plus a recorded invoice url, and neither of
   * those goes stale on its own. Expiring the row here is what frees
   * `user_subscription_one_pending`'s slot so the next attempt mints a fresh
   * one, exactly as `retireExpired` frees `user_subscription_one_active`.
   *
   * `cutoff` carries the window; this method does not know its own reasoning
   * — see `STALE_PENDING_CHECKOUT_WINDOW_MS` in
   * `apps/worker/src/scheduled-passes.ts` for why it sits where it does,
   * between a person's checkout and an invoice's life at the provider.
   */
  listStalePending(cutoff: Date, limit: number): Promise<UserSubscriptionRow[]>;
  /**
   * Expires ONE stale pending subscription — flips `status` to `expired`,
   * which is what frees `user_subscription_one_pending`'s slot for a fresh
   * purchase. See `retireExpired`'s own docstring for why "expired" rather
   * than deleting the row: it stays for the record the same way a lapsed
   * membership does.
   *
   * THE ARBITER is a conditional UPDATE — `status = 'pending'` in the WHERE
   * clause — never a read followed by a write, same reasoning as
   * `retireExpired`. Unlike that method this one is NOT re-given the cutoff:
   * `created_at` cannot change after the row is listed, so the only thing
   * that can have moved between `listStalePending` producing this id and this
   * call is its STATUS — paid via the webhook, cancelled, or already expired
   * by a concurrent sweep or by Task 2's own claim-then-retire path — and
   * `status = 'pending'` alone is what catches every one of those.
   *
   * Returns whether a row actually moved: false when it was no longer
   * pending by the time this call reached it.
   */
  expireStalePending(id: string): Promise<boolean>;
  /**
   * The still-payable invoice a stale pending subscription opened, so the sweep
   * can cancel it at the provider instead of leaving it alive — the final
   * whole-branch review's I-1.
   *
   * **WHY THE SWEEP NEEDS THIS AT ALL.** `expireStalePending` frees
   * `user_subscription_one_pending`'s slot after two hours, so the buyer's next
   * tap mints a SECOND invoice. Xendit's invoices live 24 hours, so for the
   * remaining ~22 the abandoned link (sitting in the buyer's WhatsApp — spec §7's
   * own example) and the new one are both payable. Paying both is a duplicate
   * charge: the webhook detects it, grants no second membership and logs that a
   * refund is likely owed, and there is no refund path in this product.
   *
   * **EVERY `null` IS A CASE WHERE CALLING THE PROVIDER WOULD BE WRONG**, not
   * merely useless:
   *
   *  - no `gateway_reference_id` — no invoice was ever opened (a failed
   *    `createInvoice`, 5a's own recorded case). There is nothing to cancel;
   *  - the transaction is no longer `pending` — most importantly, it was PAID.
   *    Cancelling a settled invoice is the one call here that could cost real
   *    money;
   *  - the owner's `xendit_account_id` is absent or the provisioning SENTINEL —
   *    the sentinel is truthy, and sending it as `for-user-id` puts a literal
   *    English phrase where a 24-character object id belongs
   *    (`isConnectedPaymentAccount`, and `StartCheckout`'s own version of this
   *    bug);
   *  - the id is unknown or malformed — a miss, like every other read here.
   *
   * The invoice ID only, never the invoice URL: the url is the payer-facing page,
   * it must not travel to a pass that logs, and the provider does not accept it as
   * an identifier.
   */
  findExpirableInvoice(subscriptionId: string): Promise<ExpirableInvoiceRef | null>;
  /**
   * ACTIVE memberships whose period ends inside the reminder window — what Task
   * 4's `RemindExpiringMembership` pass walks so a member is told BEFORE their
   * membership ends rather than discovering it by losing access.
   *
   * `from` is EXCLUSIVE and `to` is INCLUSIVE, which is what keeps this method and
   * `listExpiredActive` from ever returning the same row: `from` is `now`, and a
   * membership whose period has already lapsed (`current_period_end <= now`)
   * belongs to the retirement sweep, not to a warning about something that has
   * already happened.
   *
   * KEYSET-PAGED, and that is load-bearing rather than tidy. A reminded membership
   * does NOT leave this result set — the claim lives in `membership_reminder`, not
   * in a status this query could filter on — so a caller that simply took the first
   * `limit` rows every pass would return the same rows for ever and never reach
   * anybody behind them. `ProcessRenewals` measured exactly that (a limit of 1 and
   * two due members: the second was never reminded, and no pass ever would have).
   * `after` is strictly-greater in the SAME order the query sorts by, so the walk
   * terminates and no row is visited twice.
   */
  listExpiringActive(input: {
    from: Date;
    to: Date;
    limit: number;
    after?: { currentPeriodEnd: Date; id: string };
  }): Promise<UserSubscriptionRow[]>;
  /** Task 8's membership check: is this subscriber an active member of this owner. */
  findActiveFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null>;
  /**
   * A creator's OWN subscriber list — Task 6 of Phase 5b, spec §8. Only
   * CURRENTLY subscribed members: `status = 'active'` AND
   * `current_period_end > now`, strict — the exact same "currently
   * subscribed" definition `is-member-of.ts`'s `membershipStanding` uses,
   * mirrored here rather than composed from it: `IsMemberOf` answers a
   * per-pair question off `findActiveFor`'s single row, and this answers a
   * per-owner LIST, so sharing a call would mean an N+1 query per
   * subscriber. `isMemberOf` itself is untouched — see that class's own
   * docstring on why it stays exactly as reviewed and mutation-pinned in 5a.
   *
   * A membership whose period has lapsed is a PAST subscriber, not a current
   * one — it still holds `status = 'active'` until Task 3's sweep retires
   * it (§9's honest limitation, and the sweep may not have run yet), so a
   * status-only filter would list somebody the paywall has already stopped
   * admitting. `now` is a parameter, never read inside this method, for the
   * same `ClockPort` reason every time-sensitive read in this codebase takes
   * one: the boundary — the exact instant `current_period_end` passes — is
   * what a caller needs to place deliberately in a test.
   *
   * NEWEST FIRST (`created_at` desc, `id` desc tiebreak) — mirrors
   * `DrizzleFollowRepository.listFollowers`'s own ordering, and its own
   * reason: `created_at` alone is not a guaranteed total order.
   *
   * Returns the CLOSED projection (`SubscriberRow`) — see that type's own
   * docstring for exactly what may and may not cross this boundary.
   */
  listActiveSubscribers(ownerId: string, now: Date): Promise<SubscriberRow[]>;
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
