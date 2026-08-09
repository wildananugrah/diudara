import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { communities, membershipTiers, subscriptions, transactions } from "../../db/schema";
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
 * `subscription.status` for the LOSER of a double-submit: the member already had
 * an active subscription to this tier, so this one was never granted. `cancelled`
 * rather than a new status because Phase 5's churn logic already knows it, and an
 * unrecognised status would make a superseded row look like a live membership.
 */
const SUPERSEDED_SUBSCRIPTION = "cancelled";

/** `subscription.status` for a member whose renewal is late but still inside grace. */
const PAST_DUE_SUBSCRIPTION = "past_due";

/**
 * The only statuses the renewal pass may look at — see `findDueForRenewal`'s port
 * docstring for why this filter is load-bearing rather than tidy.
 *
 * An ALLOWLIST, in the same spirit as `VISIBLE_STATUSES`: `subscription.status` is a
 * free varchar, so a status added later must be excluded until somebody decides it
 * should be dunned, rather than start receiving payment reminders by default.
 */
const RENEWABLE_STATUSES = [ACTIVE_SUBSCRIPTION, PAST_DUE_SUBSCRIPTION];

export class DrizzleSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * See the port docstring. Scoped to `active` only: a `cancelled` or `past_due`
   * subscription must not block a member from buying again, which is the whole point
   * of letting a churned member re-pay.
   */
  async hasActiveSubscriptionForTier(memberId: string, tierId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(memberId) || !UUID_PATTERN.test(tierId)) {
      // A MISS, not a driver error — same rule as `findById`. `tierId` arrives from
      // the request body.
      return false;
    }
    const [existing] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.memberId, memberId),
          eq(subscriptions.tierId, tierId),
          eq(subscriptions.status, ACTIVE_SUBSCRIPTION)
        )
      )
      .limit(1);
    return existing !== undefined;
  }

  async createPending(input: { memberId: string; tierId: string }): Promise<SubscriptionRecord> {
    const [row] = await this.db
      .insert(subscriptions)
      .values({ memberId: input.memberId, tierId: input.tierId })
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
   */
  async markPaid(input: {
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
      const [context] = await tx
        .select({
          memberId: subscriptions.memberId,
          tierId: subscriptions.tierId,
          startedAt: subscriptions.startedAt,
          billingCycle: membershipTiers.billingCycle,
          communityId: membershipTiers.communityId,
        })
        .from(subscriptions)
        .innerJoin(membershipTiers, eq(subscriptions.tierId, membershipTiers.id))
        .where(eq(subscriptions.id, transaction.subscriptionId))
        .limit(1);
      if (!context) {
        throw new Error(`markPaid: subscription for transaction ${input.transactionId} not found`);
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
          nextBillingDate: computeNextBillingDate(input.paidAt, context.billingCycle),
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

      return {
        outcome: "activated",
        transaction,
        subscription,
        communityId: context.communityId,
      };
    });
  }
}
