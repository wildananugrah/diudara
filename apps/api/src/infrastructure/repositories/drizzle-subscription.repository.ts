import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { membershipTiers, subscriptions, transactions } from "../../db/schema";
import type {
  MarkPaidResult,
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

export class DrizzleSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

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
   */
  async markPaid(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
  }): Promise<MarkPaidResult> {
    return this.db.transaction(async (tx) => {
      const now = new Date();

      const [transaction] = await tx
        .update(transactions)
        .set({
          status: "success",
          gatewayReferenceId: input.gatewayReferenceId,
          paidAt: input.paidAt,
          updatedAt: now,
        })
        .where(eq(transactions.id, input.transactionId))
        .returning();
      if (!transaction) {
        throw new Error(`markPaid: transaction ${input.transactionId} not found`);
      }

      // The tier carries the billing cycle, and the community the audit entry
      // belongs to. Joined here rather than fetched by the use-case because
      // there is no unscoped tier-by-id port method, and this is one round trip
      // inside the transaction that is already open.
      const [context] = await tx
        .select({
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

      const [subscription] = await tx
        .update(subscriptions)
        .set({
          status: "active",
          startedAt: context.startedAt ?? input.paidAt,
          nextBillingDate: computeNextBillingDate(input.paidAt, context.billingCycle),
          updatedAt: now,
        })
        .where(eq(subscriptions.id, transaction.subscriptionId))
        .returning();
      if (!subscription) {
        throw new Error(`markPaid: subscription for transaction ${input.transactionId} not found`);
      }

      return { transaction, subscription, communityId: context.communityId };
    });
  }
}
