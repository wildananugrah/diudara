import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { subscriptions, transactions } from "../../db/schema";
import type {
  SubscriptionRecord,
  SubscriptionRepositoryPort,
  TransactionRecord,
} from "../../application/ports/subscription-repository.port";

export class DrizzleSubscriptionRepository implements SubscriptionRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

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

  async findTransactionByExternalId(id: string): Promise<TransactionRecord | null> {
    const [row] = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Task 7's webhook handler. Both rows are UPDATEs against columns with no
   * `BEFORE UPDATE` trigger backing `updated_at` (see the carry-forward
   * comment on `subscription`/`transaction` in db/schema.ts), so both set
   * `updatedAt: new Date()` explicitly — otherwise the column would silently
   * freeze at creation time.
   */
  async markPaid(input: {
    transactionId: string;
    gatewayReferenceId: string;
    paidAt: Date;
  }): Promise<{ transaction: TransactionRecord; subscription: SubscriptionRecord }> {
    const now = new Date();

    const [transaction] = await this.db
      .update(transactions)
      .set({
        status: "paid",
        gatewayReferenceId: input.gatewayReferenceId,
        paidAt: input.paidAt,
        updatedAt: now,
      })
      .where(eq(transactions.id, input.transactionId))
      .returning();
    if (!transaction) {
      throw new Error(`markPaid: transaction ${input.transactionId} not found`);
    }

    const [subscription] = await this.db
      .update(subscriptions)
      .set({
        status: "active",
        startedAt: input.paidAt,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, transaction.subscriptionId))
      .returning();
    if (!subscription) {
      throw new Error(`markPaid: subscription for transaction ${input.transactionId} not found`);
    }

    return { transaction, subscription };
  }
}
