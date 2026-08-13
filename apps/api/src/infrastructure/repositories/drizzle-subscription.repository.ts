import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import {
  communities,
  membershipTiers,
  renewalReminders,
  subscriptions,
  transactions,
} from "../../db/schema";
import type {
  DueRenewalRecord,
  MarkPaidOutcome,
  RenewalReminderContext,
  SubscriptionRecord,
  SubscriptionRepositoryPort,
  TransactionRecord,
} from "../../application/ports/subscription-repository.port";
import { computeNextBillingDate } from "../../domain/billing-cycle";

/**
 * Matches the canonical 8-4-4-4-12 hex form Postgres accepts for `uuid`.
 * `transaction.id` is a uuid column, so comparing it against a value that is not
 * one makes Postgres raise SQLSTATE 22P02 (`invalid input syntax for type uuid`)
 * rather than returning no rows. On the webhook path that turns a forged
 * `external_id` into a 500 plus a driver error on the unhandled-error log path,
 * where a `DrizzleQueryError` carries the statement's bound parameters — instead
 * of the plain 404 an unknown external id deserves.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `transaction.status` as created by `createTransaction` (the column's own
 * default). The only status `markPaid` will settle — see its docstring.
 */
const PENDING = "pending";

/**
 * The settled status `markPaid` writes, and the ONE non-`pending` status that
 * makes a second delivery an idempotent no-op rather than something a person has
 * to look at. See `MarkPaidOutcome`.
 */
const SUCCESS = "success";

/** `subscription.status` for a member who currently has access. */
const ACTIVE_SUBSCRIPTION = "active";

/**
 * `subscription.status` as created by `createPending` (the column's own default). What
 * tells a FIRST activation from a renewal: `StartCheckout` reuses the row when a member
 * renews, so the row `markPaid` activates is already `active` or `past_due` in that case.
 */
const PENDING_SUBSCRIPTION = "pending";

/**
 * `subscription.status` for the LOSER of a double-submit: the member already had
 * an active subscription to this tier, so this one was never granted. `cancelled`
 * rather than a new status because Phase 5's churn logic already knows it, and an
 * unrecognised status would make a superseded row look like a live membership.
 */
const SUPERSEDED_SUBSCRIPTION = "cancelled";

/** `subscription.status` for a member whose renewal is late but still inside grace. */
const PAST_DUE_SUBSCRIPTION = "past_due";

/**
 * `subscription.status` for a member whose grace period ran out unpaid. Terminal: the
 * churn pass writes it once, and nothing moves a row out of it — a member who pays again
 * gets a NEW subscription, which is what makes their re-grant an honest new grant
 * (`unbanChatMember` and a fresh invite) rather than a renewal.
 *
 * "Nothing moves a row out of it" IS ENFORCED, not just asserted, and the enforcement is
 * in `markPaid`: a payment that arrives for a churned subscription is refused with
 * `subscription_churned` and rolls the whole statement back. It used to be only the
 * comment. The UPDATE was predicated on the id and the no-sibling-active subquery and on
 * nothing else, so a transaction created while `past_due` and settled after the churn
 * pass ran flipped `churned` → `active`, advanced the billing date, cleared the deadline
 * and deleted the reminder claims. See `MarkPaidOutcome`'s `subscription_churned` for the
 * three things that followed, one of which was a paid-up member being evicted by their
 * own stale revoke row.
 */
const CHURNED_SUBSCRIPTION = "churned";

/**
 * Thrown inside `markPaid`'s transaction to REFUSE a payment for a churned subscription,
 * and caught immediately outside it.
 *
 * A throw rather than a return, because the transaction has already settled the
 * `transaction` row by the time the subscription's status is known, and a return would
 * COMMIT that — money recorded as collected against a subscription that was never
 * activated, which is the exact unrecoverable state `markPaid`'s wrapper exists to
 * prevent. Throwing rolls it back (to the savepoint, when nested inside
 * `DrizzlePaymentActivationUnitOfWork`), and the catch turns it back into an ordinary
 * `MarkPaidOutcome` so the caller branches on a value like it does for every other
 * outcome instead of pattern-matching on an error.
 *
 * Reading the subscription's status BEFORE settling the transaction was the alternative,
 * and it is worse: the status has to be read under `for update of subscription` to be
 * trustworthy, and taking that lock before the `transaction` row's would reverse this
 * method's lock order against itself — see the block comment on that read.
 */
class ChurnedSubscriptionRefusal extends Error {
  constructor(readonly subscriptionStatus: string) {
    super("markPaid: the subscription is churned, which is terminal");
    this.name = "ChurnedSubscriptionRefusal";
  }
}

/**
 * The statuses of a subscription that is still LIVE: one whose member is expected to pay
 * again. Read by `findDueForRenewal` (whom do we remind) and by
 * `findCurrentSubscriptionForTier` (what is this member renewing) — the same question
 * asked from two directions, which is why they share the constant.
 *
 * See `findDueForRenewal`'s port docstring for why this filter is load-bearing rather
 * than tidy.
 *
 * An ALLOWLIST, in the same spirit as `VISIBLE_STATUSES`: `subscription.status` is a
 * free varchar, so a status added later must be excluded until somebody decides it
 * should be dunned, rather than start receiving payment reminders by default.
 */
const RENEWABLE_STATUSES = [ACTIVE_SUBSCRIPTION, PAST_DUE_SUBSCRIPTION];

/**
 * The instant a renewed period is measured FROM: the later of the payment and the due
 * date it was paying for.
 *
 * For everything except an early renewal the two are the same choice — a first purchase
 * has no due date, and a `past_due` member's due date is in the past — so this only ever
 * changes the answer for a member who pays INSIDE the reminder window, before their
 * period has run out. There it matters twice over:
 *
 *  1. Anchoring on `paidAt` alone would silently shorten the membership by however many
 *     days early they acted. The `pre_3d` reminder's whole purpose is "renew without
 *     losing access", so it must not cost the member three days for using it — and the
 *     loss compounds: renewing three days early every month walks the billing date back
 *     a month over a year.
 *  2. It is what makes a genuine double-payment inside the window buy a SECOND period
 *     instead of vanishing. Two payments anchored on `paidAt` both land on nearly the
 *     same date, so the member pays twice and gets one period.
 *
 * THAT SECOND PROPERTY NEEDS THE ROW LOCK IN `markPaid` TO HOLD AT ALL. This function is
 * pure, and its caller reads `next_billing_date` and then writes a value derived from it:
 * without `for update of subscription` on that read, two concurrent deliveries both see
 * the old due date and both compute the same new one, which is exactly the vanishing this
 * exists to prevent. See the block comment on that read.
 *
 * `next_billing_date` is a `date`, so `new Date("2026-03-10")` is UTC midnight — inside
 * the WIB day the column names, which is the frame the rest of this phase reads it in.
 */
function renewalAnchor(paidAt: Date, currentNextBillingDate: string | null): Date {
  if (currentNextBillingDate === null) return paidAt;
  const dueAt = new Date(currentNextBillingDate);
  return dueAt.getTime() > paidAt.getTime() ? dueAt : paidAt;
}

export class DrizzleSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * See the port docstring. `active` OR `past_due`, because both are renewable and the
   * caller has to be able to tell them apart from each other and from nothing at all.
   * `cancelled` and `churned` are excluded: a member whose access was taken away buys a
   * NEW subscription, which is what makes their re-grant an honest new grant.
   *
   * Ordered so `active` wins when a (member, tier) somehow has both — the partial unique
   * index only covers `active`, so history can contain the pair — and then by the latest
   * due date, so the answer is deterministic rather than whatever the planner returned.
   */
  async findCurrentSubscriptionForTier(
    memberId: string,
    tierId: string
  ): Promise<SubscriptionRecord | null> {
    if (!UUID_PATTERN.test(memberId) || !UUID_PATTERN.test(tierId)) {
      // A MISS, not a driver error — same rule as `findById`. `tierId` arrives from
      // the request body.
      return null;
    }
    const [existing] = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.memberId, memberId),
          eq(subscriptions.tierId, tierId),
          inArray(subscriptions.status, RENEWABLE_STATUSES)
        )
      )
      .orderBy(
        sql`case when ${subscriptions.status} = ${ACTIVE_SUBSCRIPTION} then 0 else 1 end`,
        desc(subscriptions.nextBillingDate)
      )
      .limit(1);
    return existing ?? null;
  }

  async createPending(input: { memberId: string; tierId: string }): Promise<SubscriptionRecord> {
    const [row] = await this.db
      .insert(subscriptions)
      .values({ memberId: input.memberId, tierId: input.tierId })
      .returning();
    return row;
  }

  /**
   * See the port docstring. `nextBillingDate` is omitted, not set to null
   * explicitly — the column has no default, so an omitted insert value is
   * already null, which is what keeps this row out of `findDueForRenewal`
   * (an explicit `isNotNull` there) and therefore out of the churn pass that
   * follows it. `startedAt` IS set, same as a first payment: this is the day
   * the free membership began, and churn timing elsewhere in the system reads
   * it the same way regardless of how the subscription became active.
   */
  async createActiveWithoutBilling(input: {
    memberId: string;
    tierId: string;
  }): Promise<SubscriptionRecord> {
    const now = new Date();
    const [row] = await this.db
      .insert(subscriptions)
      .values({
        memberId: input.memberId,
        tierId: input.tierId,
        status: ACTIVE_SUBSCRIPTION,
        startedAt: now,
      })
      .returning();
    return row;
  }

  async createTransaction(input: {
    subscriptionId: string;
    amount: number;
    paymentMethod: string;
  }): Promise<TransactionRecord> {
    const [row] = await this.db
      .insert(transactions)
      .values({
        subscriptionId: input.subscriptionId,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
      })
      .returning();
    return row;
  }

  /**
   * Conditional on the column still being empty — see the port docstring. Also
   * bumps `updatedAt`, because `transaction` has no BEFORE UPDATE trigger.
   */
  async attachGatewayReference(
    transactionId: string,
    gatewayReferenceId: string
  ): Promise<boolean> {
    if (!UUID_PATTERN.test(transactionId)) {
      return false;
    }
    const rows = await this.db
      .update(transactions)
      .set({ gatewayReferenceId, updatedAt: new Date() })
      .where(
        and(eq(transactions.id, transactionId), isNull(transactions.gatewayReferenceId))
      )
      .returning({ id: transactions.id });
    return rows.length > 0;
  }

  /**
   * `id` arrives straight off a public URL — see the port docstring — so it
   * is shape-checked before it reaches the driver for the same reason as
   * `findTransactionByExternalId` below.
   */
  async findById(id: string): Promise<SubscriptionRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * One join instead of a second port method the community-scoped tier
   * repository could not provide — see the port docstring.
   */
  async findByIdWithCommunity(
    id: string
  ): Promise<{ subscription: SubscriptionRecord; communityId: string } | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const [row] = await this.db
      .select({ subscription: subscriptions, communityId: membershipTiers.communityId })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .where(eq(subscriptions.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The renewal pass's batch. One join down to `community`, for the same reason
   * `findByIdWithCommunity` exists: the pass has no creator, and
   * `CommunityRepositoryPort` has no unscoped by-id read to reach the community's
   * status with.
   *
   * `inArray` on the status is the filter the port docstring insists on. No
   * shape-check on `dueOnOrBefore`: it is built by `latestDueDateInReminderWindow`
   * from the injected clock, never by a caller, so an unparseable value here is a
   * programming error that should surface rather than be turned into an empty batch
   * that silently reminds nobody.
   *
   * Ordered longest-overdue first, with `id` as the tie-break so the order is TOTAL
   * and the keyset cursor in `after` can walk it without skipping or repeating a row —
   * see the port docstring for why a bare `limit` starves the tail of the backlog.
   */
  async findDueForRenewal(input: {
    dueOnOrBefore: string;
    limit: number;
    after?: { nextBillingDate: string; id: string };
  }): Promise<DueRenewalRecord[]> {
    const { after } = input;
    return this.db
      .select({
        subscription: subscriptions,
        communityId: communities.id,
        communityStatus: communities.status,
      })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .innerJoin(communities, eq(membershipTiers.communityId, communities.id))
      .where(
        and(
          inArray(subscriptions.status, RENEWABLE_STATUSES),
          // Redundant with the comparison below in Postgres (NULL <= anything is
          // NULL, so the row is excluded either way), and kept because it states the
          // intent: a subscription that never activated has no due date to be late
          // for.
          isNotNull(subscriptions.nextBillingDate),
          lte(subscriptions.nextBillingDate, input.dueOnOrBefore),
          // The keyset: strictly after (date, id) in the SAME order as the ORDER BY
          // below. A tuple comparison, spelled out because the two columns are
          // different types.
          after === undefined
            ? undefined
            : or(
                gt(subscriptions.nextBillingDate, after.nextBillingDate),
                and(
                  eq(subscriptions.nextBillingDate, after.nextBillingDate),
                  gt(subscriptions.id, after.id)
                )
              )
        )
      )
      .orderBy(asc(subscriptions.nextBillingDate), asc(subscriptions.id))
      .limit(input.limit);
  }

  /**
   * The `active` → `past_due` transition, with the grace deadline written in the same
   * statement. See the port docstring: `status = 'active'` is IN the predicate, which
   * is what makes the deadline write-once under a second pass and under a concurrent
   * one, and `updatedAt` is set explicitly because no trigger backs the column.
   *
   * A malformed id is a MISS rather than a driver error, the same rule as `findById` —
   * though unlike that method the id here always comes from a row this process just
   * read, so it is a belt-and-braces guard rather than an untrusted-input one.
   */
  async markPastDue(subscriptionId: string, graceEndsAt: Date): Promise<boolean> {
    if (!UUID_PATTERN.test(subscriptionId)) {
      return false;
    }
    const moved = await this.db
      .update(subscriptions)
      .set({ status: PAST_DUE_SUBSCRIPTION, graceEndsAt, updatedAt: new Date() })
      .where(
        and(eq(subscriptions.id, subscriptionId), eq(subscriptions.status, ACTIVE_SUBSCRIPTION))
      )
      .returning({ id: subscriptions.id });
    return moved.length > 0;
  }

  /**
   * The churn pass's batch. Same join as `findDueForRenewal`, and the same reason for
   * it: the pass has no creator, so the community's id and status have to come down the
   * join rather than through the creator-scoped community repository.
   *
   * The three predicates are all load-bearing — see the port docstring. `isNotNull` on
   * the deadline is not redundant with the comparison the way it is in
   * `findDueForRenewal`: it says out loud that a subscription with no STORED deadline
   * has none, rather than one this pass could derive.
   *
   * No cursor, and no `after` parameter to add one with: the pass writes `churned`,
   * which the status filter excludes, so every row it handles leaves the result set.
   * Ordered oldest-deadline-first so the longest-overdue member is dealt with first
   * when a backlog is bigger than one batch.
   */
  async findPastGraceDeadline(input: { now: Date; limit: number }): Promise<DueRenewalRecord[]> {
    return this.db
      .select({
        subscription: subscriptions,
        communityId: communities.id,
        communityStatus: communities.status,
      })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .innerJoin(communities, eq(membershipTiers.communityId, communities.id))
      .where(
        and(
          eq(subscriptions.status, PAST_DUE_SUBSCRIPTION),
          isNotNull(subscriptions.graceEndsAt),
          // Strictly less than, which is `isPastGrace`'s boundary: at the deadline the
          // member still has access.
          lt(subscriptions.graceEndsAt, input.now)
        )
      )
      .orderBy(asc(subscriptions.graceEndsAt), asc(subscriptions.id))
      .limit(input.limit);
  }

  /**
   * The `past_due` → `churned` transition. See the port docstring: `status = 'past_due'`
   * is IN the predicate, which is what makes "running the pass twice churns once and
   * enqueues one revoke row" a property of the database rather than of the caller's
   * bookkeeping, and `updatedAt` is set explicitly because no trigger backs the column.
   *
   * `grace_ends_at` is not cleared: it is the deadline this member was measured against.
   */
  async markChurned(subscriptionId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(subscriptionId)) {
      return false;
    }
    const moved = await this.db
      .update(subscriptions)
      .set({ status: CHURNED_SUBSCRIPTION, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.status, PAST_DUE_SUBSCRIPTION)
        )
      )
      .returning({ id: subscriptions.id });
    return moved.length > 0;
  }

  /**
   * See the port docstring. The same `subscription → membership_tier` join every
   * unscoped read here uses, filtered to the community and to the statuses that mean
   * "still entitled" — `RENEWABLE_STATUSES`, shared with `findCurrentSubscriptionForTier`
   * so "which statuses are live" has one answer.
   *
   * `limit(1)`: it is an existence question, and a member with three live tiers must not
   * cost three rows to answer it.
   */
  async hasLiveSubscriptionInCommunity(memberId: string, communityId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(memberId) || !UUID_PATTERN.test(communityId)) {
      // A MISS, not a driver error — same rule as `findById`. The ids come out of an
      // outbox payload, which is a jsonb column that can outlive a deploy.
      return false;
    }
    const [row] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .where(
        and(
          eq(subscriptions.memberId, memberId),
          eq(membershipTiers.communityId, communityId),
          inArray(subscriptions.status, RENEWABLE_STATUSES)
        )
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * The reminder message's context, in one read. See the port docstring for why the
   * join lives here rather than becoming two unscoped by-id methods on the community
   * and tier repositories.
   */
  async findRenewalContext(subscriptionId: string): Promise<RenewalReminderContext | null> {
    if (!UUID_PATTERN.test(subscriptionId)) {
      return null;
    }
    const [row] = await this.db
      .select({
        subscription: subscriptions,
        tier: {
          id: membershipTiers.id,
          name: membershipTiers.name,
          priceAmount: membershipTiers.priceAmount,
          billingCycle: membershipTiers.billingCycle,
        },
        community: {
          id: communities.id,
          name: communities.name,
          slug: communities.slug,
          status: communities.status,
        },
      })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .innerJoin(communities, eq(membershipTiers.communityId, communities.id))
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    return row ?? null;
  }

  /**
   * See the port docstring. Same `subscription → membership_tier` join
   * `hasLiveSubscriptionInCommunity` uses, filtered to `active` alone (not
   * `RENEWABLE_STATUSES`) and to THIS community, with no `LIMIT` — unlike that
   * method this is not an existence check, it is the actual roster
   * `NotifyStreamLive` sends to.
   */
  async listActiveForCommunity(communityId: string): Promise<{ id: string; memberId: string }[]> {
    if (!UUID_PATTERN.test(communityId)) {
      // A MISS, not a driver error — same rule as `findRenewalContext`. `communityId`
      // is read out of `event.community_id`, resolved from an outbox payload's
      // `eventId`, so it can never legitimately be malformed — but nothing here
      // should turn "it somehow is" into a 500 in the worker's log.
      return [];
    }
    return this.db
      .select({ id: subscriptions.id, memberId: subscriptions.memberId })
      .from(subscriptions)
      .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
      .where(
        and(eq(membershipTiers.communityId, communityId), eq(subscriptions.status, ACTIVE_SUBSCRIPTION))
      );
  }

  /**
   * `id` arrives straight off an untrusted webhook body, so it is shape-checked
   * before it reaches the driver — see UUID_PATTERN above for why a malformed
   * value must be a miss and not an error.
   */
  async findTransactionByExternalId(id: string): Promise<TransactionRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const [row] = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Task 7's webhook handler: money in, access on.
   *
   * Everything runs inside ONE database transaction. The failure this prevents is
   * concrete: resolving the tier's billing cycle can throw (`billing_cycle` is a
   * varchar, not an enum), and without the wrapper that would leave a transaction
   * marked `success` — money recorded as collected — against a subscription that
   * never activated, with the webhook already recorded so no retry would fix it.
   *
   * Both rows are UPDATEs against columns with no `BEFORE UPDATE` trigger backing
   * `updated_at` (see the carry-forward comment on `subscription`/`transaction` in
   * db/schema.ts), so both set `updatedAt: new Date()` explicitly — otherwise the
   * column silently freezes at creation time and nothing looks like it happened.
   *
   * `startedAt` is only written on the FIRST activation: churn timing (spec 8.3)
   * measures from the day the membership began, so a renewal must not move it.
   * The read and the write are in the same transaction, so there is no race.
   *
   * `status = 'pending'` is IN the UPDATE predicate, which makes this the second
   * line of replay defence and the only one that does not depend on a provider
   * field. Probed before it was: 12 concurrent PAID deliveries with 12 DIFFERENT
   * `body.id` values produced 12 `activity_log` "joined" rows — 12 WhatsApp
   * invites in Phase 4 — because `provider_event_id` derives from `body.id` and
   * every one of them was distinct. Zero affected rows is reported, never an error
   * and never a second activation.
   *
   * WHAT IT REPORTS is a `MarkPaidOutcome` rather than a nullable result, and the
   * distinctions cost nothing because the reads that make them are already here:
   *
   *   already_settled    — the transaction is `success`. A replay; a 2xx no-op.
   *   conflicting_status — any other non-`pending` status (today `failed`). A real
   *                        payment nobody can settle without looking at it, and
   *                        answering "duplicate" used to throw it away.
   *   superseded         — the member already holds an active subscription to this
   *                        tier, so this one is `cancelled` rather than granted a
   *                        second time. The transaction still settles: the money
   *                        arrived, and hiding that hides a refund that is owed.
   *   subscription_churned
   *                      — the subscription is CHURNED, which is terminal. Nothing is
   *                        written at all, including the transaction's settlement: the
   *                        whole statement rolls back so the delivery can be replayed.
   *                        See `ChurnedSubscriptionRefusal` and the `MarkPaidOutcome`
   *                        entry for why resurrecting the row was the worse answer.
   */
  async markPaid(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
    paymentMethod?: string | undefined;
  }): Promise<MarkPaidOutcome> {
    try {
      return await this.markPaidInTransaction(input);
    } catch (err) {
      if (err instanceof ChurnedSubscriptionRefusal) {
        // The transaction (or savepoint) is rolled back by the time we get here, so
        // nothing this method touched survives. Reported as an outcome, because the
        // caller has a decision to make and an exception would make it guess.
        return { outcome: "subscription_churned", subscriptionStatus: err.subscriptionStatus };
      }
      throw err;
    }
  }

  private async markPaidInTransaction(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
    paymentMethod?: string | undefined;
  }): Promise<MarkPaidOutcome> {
    return this.db.transaction(async (tx) => {
      const now = new Date();

      const [transaction] = await tx
        .update(transactions)
        .set({
          status: SUCCESS,
          gatewayReferenceId: input.gatewayReferenceId,
          paidAt: input.paidAt,
          updatedAt: now,
          // Spread, not `?? existing`: an omitted payment_method must leave the
          // column alone rather than write `undefined` (which drizzle would turn
          // into a NULL against a NOT NULL column).
          ...(input.paymentMethod === undefined
            ? {}
            : { paymentMethod: input.paymentMethod }),
        })
        .where(and(eq(transactions.id, input.transactionId), eq(transactions.status, PENDING)))
        .returning();
      if (!transaction) {
        // Zero rows means either "no such transaction" or "not pending any
        // more". Only the first is a programming error, so one extra read inside
        // the already-open transaction resolves which.
        const [existing] = await tx
          .select({ status: transactions.status })
          .from(transactions)
          .where(eq(transactions.id, input.transactionId))
          .limit(1);
        if (!existing) {
          throw new Error(`markPaid: transaction ${input.transactionId} not found`);
        }
        // And the status this read already has decides which of the two
        // NOT-pending cases it is. Returning a bare "settled" for both meant a
        // real payment for a `failed` transaction was answered with a 200 and
        // thrown away — see MarkPaidOutcome.
        return existing.status === SUCCESS
          ? { outcome: "already_settled", status: existing.status }
          : { outcome: "conflicting_status", status: existing.status };
      }

      // The tier carries the billing cycle, and the community the audit entry
      // belongs to. Joined here rather than fetched by the use-case because
      // there is no unscoped tier-by-id port method, and this is one round trip
      // inside the transaction that is already open.
      //
      // ===================================================================
      // `for update of subscription` — WHY THIS READ TAKES A ROW LOCK
      //
      // `next_billing_date` is read here and WRITTEN BELOW from a value derived
      // from it (`renewalAnchor` picks the later of the due date and `paidAt`).
      // That is a read-modify-write, and under READ COMMITTED nothing else
      // serialises it: two deliveries for two invoices against the SAME
      // subscription both read the old due date, both compute the same new one,
      // and the second UPDATE — which blocks on the row lock the first takes and
      // then proceeds with the value it read BEFORE that — overwrites the first
      // with an identical date. The member pays twice and gets ONE period, and
      // both `activity_log` "renewed" entries claim that one date, so the audit
      // trail agrees with itself and hides it.
      //
      // Measured against the running API in Phase 5 Task 9, interleaving forced
      // with a third session holding this row: two payments moved a 2026-08-12
      // due date to 2026-09-12, not 2026-10-12.
      //
      // Locking here rather than in the UPDATE's predicate is deliberate: the
      // stale value is consumed by `computeNextBillingDate` in JS, so the write
      // has to be made to wait at the READ. Nothing else in this transaction has
      // touched `subscription` yet, and the only other row it holds is this
      // transaction's own `transaction` row — which no other caller takes before
      // a subscription row — so there is no lock-ordering cycle to deadlock on.
      //
      // `of subscription` restricts the lock to the subscription row: without it
      // the join makes Postgres lock `membership_tier` too, and a tier row is
      // shared by every member of that tier, so two unrelated members renewing at
      // once would queue behind each other for no reason.
      // ===================================================================
      const [context] = await tx
        .select({
          memberId: subscriptions.memberId,
          tierId: subscriptions.tierId,
          status: subscriptions.status,
          startedAt: subscriptions.startedAt,
          nextBillingDate: subscriptions.nextBillingDate,
          billingCycle: membershipTiers.billingCycle,
          communityId: membershipTiers.communityId,
        })
        .from(subscriptions)
        .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
        .where(eq(subscriptions.id, transaction.subscriptionId))
        .for("update", { of: subscriptions })
        .limit(1);
      if (!context) {
        throw new Error(`markPaid: subscription for transaction ${input.transactionId} not found`);
      }

      // CHURNED IS TERMINAL, AND THIS IS WHERE THAT IS TRUE RATHER THAN MERELY WRITTEN
      // DOWN. Read under the row lock taken just above, so it cannot race the churn
      // pass: whichever of the two gets the lock first, the other sees its result.
      //
      // Adding `status <> 'churned'` to the UPDATE below instead would not do, because
      // zero affected rows there already MEANS `superseded` — the two cases would become
      // indistinguishable, and a churned member's payment would be reported as a
      // duplicate and thrown away, which is the failure this refusal exists to avoid.
      if (context.status === CHURNED_SUBSCRIPTION) {
        throw new ChurnedSubscriptionRefusal(context.status);
      }

      // `not exists` is IN the predicate, so a subscription that is being
      // superseded never briefly reads as active — and the exclusion of the row
      // itself is what keeps a RENEWAL working, since a renewal settles a new
      // transaction against a subscription that is already active.
      //
      // This predicate is the graceful path, not the guarantee. Under READ
      // COMMITTED two concurrent activations cannot see each other's uncommitted
      // row, so both would pass it; `subscription_member_tier_active_unique` is
      // what actually arbitrates that, and the loser's transaction rolls back with
      // the webhook event id unspent so the provider's retry takes this path.
      //
      // Written as a raw fragment because the subquery needs a self-ALIAS and
      // neither drizzle's `alias()` (it renders the alias name with no FROM entry)
      // nor `notExists()` with a sub-builder survives being embedded in an UPDATE's
      // WHERE on drizzle 0.45. The column names are therefore literal — if
      // `subscription.member_id`, `tier_id`, `status` or `id` is ever renamed in
      // db/schema.ts, this fragment must be renamed with it, and the tests in
      // drizzle-subscription.repository.test.ts fail loudly if it is not.
      const [subscription] = await tx
        .update(subscriptions)
        .set({
          status: ACTIVE_SUBSCRIPTION,
          startedAt: context.startedAt ?? input.paidAt,
          nextBillingDate: computeNextBillingDate(
            renewalAnchor(input.paidAt, context.nextBillingDate),
            context.billingCycle
          ),
          // CLEARED, because a renewed subscription has no grace deadline. It is the one
          // thing that makes the stored deadline safe to leave alone everywhere else: the
          // churn query reads `past_due` rows, so a stale deadline on an `active` row is
          // inert — but leaving it would make every later reader guess which it was.
          graceEndsAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptions.id, transaction.subscriptionId),
            sql`not exists (
              select 1 from ${subscriptions} sibling
              where sibling.member_id = ${context.memberId}
                and sibling.tier_id = ${context.tierId}
                and sibling.status = ${ACTIVE_SUBSCRIPTION}
                and sibling.id <> ${transaction.subscriptionId}
            )`
          )
        )
        .returning();

      if (!subscription) {
        // The row exists — `context` came from it — so zero rows here means only
        // one thing: the member already holds an active subscription to this tier.
        // A double-submit at checkout. Supersede rather than grant twice; see
        // MarkPaidOutcome for why the transaction still settles as `success`.
        const [cancelled] = await tx
          .update(subscriptions)
          .set({ status: SUPERSEDED_SUBSCRIPTION, updatedAt: now })
          .where(eq(subscriptions.id, transaction.subscriptionId))
          .returning();
        if (!cancelled) {
          throw new Error(
            `markPaid: subscription for transaction ${input.transactionId} not found`
          );
        }
        return {
          outcome: "superseded",
          transaction,
          subscription: cancelled,
          communityId: context.communityId,
        };
      }

      // THE COMPLETED PERIOD'S REMINDER CLAIMS, RELEASED — inside this transaction, so a
      // failure cannot leave them half-cleared.
      //
      // `renewal_reminder` is unique on `(subscription_id, stage)` and that index is
      // TOTAL, not partial (Task 2's deliberate choice). The stage strings repeat every
      // period, so a row that survives a renewal makes the NEXT period's reminder for
      // that stage conflict and be read as "already claimed" — the member is never
      // reminded again, and the bug is invisible for a full billing cycle before it
      // surfaces as a member churning with no warning.
      //
      // CLEARING THE ROWS is the chosen fix, rather than scoping the key to a period.
      // A period-scoped key would mean inventing a period identifier that survives a
      // `next_billing_date` change and then widening the unique index that IS the
      // reminder-once lock — the one mechanism this phase's idempotency rests on. The
      // claims are spent when the period they belong to ends; deleting them says exactly
      // that, and leaves the lock alone.
      //
      // Unconditional on the activated path: a first activation has no rows and the
      // DELETE is a no-op, so there is no "is this a renewal" branch for a future change
      // to get wrong.
      await tx
        .delete(renewalReminders)
        .where(eq(renewalReminders.subscriptionId, transaction.subscriptionId));

      return {
        outcome: "activated",
        // A RENEWAL rather than a first payment, decided by the status this row was in
        // BEFORE the update — read inside the same transaction, so it cannot race. The
        // caller audits the two differently: Phase 6 counts new members, and a renewal
        // recorded as a join would inflate that for ever.
        renewed: context.status !== PENDING_SUBSCRIPTION,
        transaction,
        subscription,
        communityId: context.communityId,
      };
    });
  }
}
