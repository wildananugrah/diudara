/** One (subscriber, owner) membership relationship over time. */
export interface UserSubscriptionRow {
  id: string;
  subscriberId: string;
  tierId: string;
  ownerId: string;
  status: string;
  /** 'paid' | 'free'. See spec §3: this is what keeps a PAID row's NULL period reading as a bug, while a free row's NULL is the intended shape. */
  kind: string;
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
  /** 'paid' | 'free'. Only a FREE membership may be revoked by its owner. */
  kind: string;
}

/** What `findPendingCheckout` hands back: enough to re-answer a second tap without the provider. */
export interface PendingUserCheckout {
  subscriptionId: string;
  /** The tier the pending invoice was opened FOR — not necessarily the one now being asked for. */
  tierId: string;
  transactionId: string;
  invoiceUrl: string;
}

/**
 * One row of an owner's pending free-membership queue — Task 5 of
 * "free memberships", `GET /users/me/membership-requests`. The wire's CLOSED
 * public projection, same discipline `SubscriberRow` above documents: only
 * what the owner needs to recognise the request and decide on it, never
 * `subscriberId` (an internal id the owner has no use for and which would let
 * a client correlate this list against other endpoints that DO take an id)
 * and never an email or a `whatsapp_number` — the same two columns
 * `SubscriberRow`'s docstring excludes from the subscriber list, for the same
 * reason.
 *
 * `id` IS a `user_subscription` row id, not excluded like `subscriberId`
 * above — it is what the owner sends straight back on
 * `POST /me/membership-requests/:id/approve` and `/reject`, so withholding it
 * would make the list useless for the one thing it exists to drive.
 */
export interface PendingRequestRow {
  id: string;
  subscriberHandle: string;
  subscriberDisplayName: string;
  /** The free tier this request is for — an owner may run more than one. */
  tierName: string;
  createdAt: Date;
}

export interface UserSubscriptionRepositoryPort {
  /**
   * Raw INSERT. Rejects — it does not return null — when the pair already holds
   * a pending subscription, because `user_subscription_one_pending` is a
   * database constraint and not an application rule. `claimPending` below is
   * what production code calls for a PAID purchase; `StartUserSubscription`'s
   * free path (Task 4 of "free memberships") calls THIS one directly instead
   * — a free request never risks a second live invoice (there is no invoice
   * at all), so the pending-slot claim dance `claimPending` exists for buys
   * nothing here, and a plain INSERT is the honest shape.
   *
   * `kind` is OPTIONAL and defaults to `'paid'` — the same default
   * `db/schema.ts` gives the column itself (Task 1), so an omitted `kind`
   * here and an omitted `kind` at the driver agree. This keeps every
   * pre-existing caller of this method (there are dozens, across fixtures
   * this task does not otherwise touch) creating exactly the paid row it
   * always created, with nothing to update. `StartUserSubscription`'s free
   * branch is the one caller that passes `kind: "free"` explicitly, because
   * that is the one call site where the value is NOT the default.
   */
  create(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
    /** 'paid' | 'free', defaults to 'paid'. See `UserSubscriptionRow.kind`'s own docstring. */
    kind?: string;
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
    /**
     * 'paid' | 'free', defaulting to 'paid' via the column's own DEFAULT.
     * A FREE request takes the pending slot through THIS method, not through
     * `create`, for the reason this method exists: the slot is arbitrated by
     * `user_subscription_one_pending`, and a plain insert turns a second tap of
     * "Minta jadi anggota" into a 23505 and a 500.
     */
    kind?: string;
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
   *
   * **ONLY A LIVE ROW** — `pending` or `active`. A row already `expired` or
   * `cancelled` is left exactly as it is and this answers `null`: since 5b there
   * are two other actors that can end a row (`retireExpired` and
   * `expireStalePending`), and a terminal status is a fact about WHY a membership
   * stopped, not a slot for whoever writes last. Final whole-branch review, m-2.
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
   * Task 6 of "free memberships": is there a `status = 'pending'` row for
   * this (subscriber, owner) pair, whatever put it there — a PAID checkout
   * with an open invoice (`StartUserSubscription`'s paid path) or a FREE
   * request awaiting the owner's decision (`claimPending({ ..., kind: "free"
   * })`). `status = 'pending'` alone, nothing else — deliberately NOT
   * `findPendingCheckout`'s three-way predicate (subscription pending,
   * transaction pending, transaction has an invoice url): that method exists
   * to dedupe a SECOND paid checkout tap and a free request has no
   * transaction at all, so it would never be found through it. This read
   * stays a truthful, general-purpose "is there a pending row for this
   * pair" — a caller that only cares about ONE kind (the public profile
   * cares about free only, so it is not left mid-payment being told "awaiting
   * approval") decides that in its own projection, off the `kind` this
   * method hands back, rather than this query silently narrowing to one kind
   * and becoming useless for the other caller.
   *
   * The most recent such row, when a pair somehow has more than one (it
   * should not: `user_subscription_one_pending` allows only one).
   */
  findPendingFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null>;
  /**
   * A creator's OWN subscriber list — Task 6 of Phase 5b, spec §8. Only
   * CURRENTLY subscribed members: `status = 'active'` AND (`kind = 'free'`
   * OR `current_period_end > now`, strict) — the exact same "currently
   * subscribed" definition `is-member-of.ts`'s `membershipStanding` uses,
   * mirrored here rather than composed from it: `IsMemberOf` answers a
   * per-pair question off `findActiveFor`'s single row, and this answers a
   * per-owner LIST, so sharing a call would mean an N+1 query per
   * subscriber. `isMemberOf` itself is untouched — see that class's own
   * docstring on why it stays exactly as reviewed and mutation-pinned in 5a.
   *
   * A PAID membership whose period has lapsed is a PAST subscriber, not a
   * current one — it still holds `status = 'active'` until Task 3's sweep
   * retires it (§9's honest limitation, and the sweep may not have run yet),
   * so a status-only filter would list somebody the paywall has already
   * stopped admitting. A FREE membership (`kind = 'free'`) has no period at
   * all by design (spec §3) and is admitted on `kind` alone, the same order
   * `membershipStanding` checks it in. `now` is a parameter, never read
   * inside this method, for the same `ClockPort` reason every time-sensitive
   * read in this codebase takes one: the boundary — the exact instant
   * `current_period_end` passes — is what a caller needs to place
   * deliberately in a test.
   *
   * NEWEST FIRST (`created_at` desc, `id` desc tiebreak) — mirrors
   * `DrizzleFollowRepository.listFollowers`'s own ordering, and its own
   * reason: `created_at` alone is not a guaranteed total order.
   *
   * Returns the CLOSED projection (`SubscriberRow`) — see that type's own
   * docstring for exactly what may and may not cross this boundary.
   */
  listActiveSubscribers(ownerId: string, now: Date): Promise<SubscriberRow[]>;
  /**
   * Phase 6's paywall question, asked once for a whole feed page: which of
   * `ownerIds` is `subscriberId` CURRENTLY a member of. Same "currently
   * subscribed" definition as `listActiveSubscribers` and `is-member-of.ts`'s
   * `membershipStanding` — `status = 'active'` AND (`kind = 'free'` OR
   * `current_period_end > now`, strict) — mirrored here rather than composed
   * from either, for the same reason `listActiveSubscribers`'s own docstring
   * gives: a feed holds posts from many authors, and answering this
   * per-owner would be an N+1 query on the page that matters most.
   * `is-member-of.ts` stays untouched — see its own docstring on why it is
   * pinned exactly as reviewed in 5a.
   *
   * A lapsed PAID membership — `status` still `active` but its period
   * already over, because Task 3 of 5b's sweep has not yet retired it (§9's
   * honest limitation) — is excluded, not merely a past subscriber: a
   * status-only filter would let a lapsed member keep seeing gated images
   * they no longer pay for. A FREE membership (`kind = 'free'`) is admitted
   * on `kind` alone, regardless of `current_period_end` — which is always
   * `NULL` for a free row by design (spec §3), never a period to compare.
   *
   * `now` is a parameter, never read inside this method, for the same
   * `ClockPort` reason every time-sensitive read in this codebase takes one.
   *
   * Returns only the ids from `ownerIds` that are currently paid-or-free
   * members for — never the whole membership row, and never an id outside
   * `ownerIds`. Order is unspecified; a caller building a per-post gate turns
   * this into a Set.
   *
   * An empty `ownerIds` answers `[]` without touching the database — an
   * empty `IN ()` is a SQL error in some drivers and a pointless round trip
   * in all of them.
   */
  listActiveOwnersAmong(subscriberId: string, ownerIds: string[], now: Date): Promise<string[]>;
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
   * anchor. Mirrors the retired community port's `attachGatewayReference`,
   * whose own docstring recorded why that webhook failed closed without it.
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
  /**
   * Task 5 of "free memberships": an owner's queue of free-membership
   * requests awaiting a decision — `status = 'pending'` AND `kind = 'free'`
   * for this owner. A PAID pending checkout (an open Xendit invoice) is
   * deliberately excluded by the `kind` predicate: it belongs to
   * `findPendingCheckout`'s world, not this queue, and an owner approving it
   * here would activate a membership nobody has paid for yet.
   *
   * Returns the CLOSED projection (`PendingRequestRow`) — see that type's own
   * docstring for exactly what may and may not cross this boundary.
   *
   * Oldest first (`created_at` asc, `id` asc tiebreak): a queue, worked in the
   * order people asked.
   */
  listPendingRequests(ownerId: string): Promise<PendingRequestRow[]>;
  /**
   * THE CONDITIONAL UPDATE that approves one free-membership request —
   * flips `status` to `active` and leaves `current_period_end` NULL (a free
   * row's permanent shape, spec §3; see `MembershipStanding`'s own docstring
   * on `kind = 'free'`).
   *
   * THE ARBITER is the WHERE clause, never a read followed by a write: this
   * row's id, THIS owner, still `status = 'pending'` AND `kind = 'free'`.
   * Two concurrent approvals of the same request race to one winner —
   * Postgres serialises the two UPDATEs on the row's own lock, and by the
   * time the loser's UPDATE re-evaluates its WHERE the winner has already
   * moved the row off `pending`, so the loser matches zero rows and this
   * answers `null`. The SAME predicate is why a second approval after the
   * first has already landed also answers `null` — nothing here is a special
   * case, both are just "no longer pending".
   *
   * `ownerId` in the WHERE, not a separate ownership check afterwards, is
   * what makes a foreign owner's attempt answer `null` exactly like a missing
   * id — the same "gated and absent look identical from outside" the media
   * routes already follow, and what lets the use case throw one
   * `NotFoundError` for both without this method ever having to distinguish
   * them.
   *
   * Can raise a unique-violation on `user_subscription_one_active` when the
   * subscriber already holds a DIFFERENT active row for this owner (a
   * pending free request survives alongside an existing active membership —
   * nothing stops both existing at once, since they are different rows).
   * Implementations MUST translate that into `UniqueViolationError` (via
   * `rethrowUniqueViolation`) rather than let the raw driver error escape —
   * this codebase never lets a driver error reach a route.
   */
  approveFreeRequest(id: string, ownerId: string): Promise<UserSubscriptionRow | null>;
  /**
   * Rejects one free-membership request by DELETING the row — not a status
   * flip, unlike every other terminal transition on this table
   * (`cancel`/`retireExpired`/`expireStalePending`). A rejected request keeps
   * no record on purpose: rejecting it must free the person to ask again, and
   * a soft-deleted `rejected` row sitting where a fresh pending request wants
   * to go would either need its own carve-out in `user_subscription_one_pending`
   * or would permanently block a second ask — worse than simply not existing.
   *
   * Same WHERE-clause arbitration as `approveFreeRequest`: this row's id,
   * THIS owner, `status = 'pending'` AND `kind = 'free'`. Returns whether a
   * row actually moved — `false` for a missing id, a foreign owner's id, or a
   * request already decided, all indistinguishable to the caller for the same
   * "gated and absent look identical" reason `approveFreeRequest` documents.
   */
  rejectRequest(id: string, ownerId: string): Promise<boolean>;
}
