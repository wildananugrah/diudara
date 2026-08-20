import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { userSubscriptions, userTransactions } from "../../db/schema";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
  UserTransactionRow,
} from "../../application/ports/user-subscription-repository.port";

export class DrizzleUserSubscriptionRepository implements UserSubscriptionRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<UserSubscriptionRow> {
    const [row] = await this.db
      .insert(userSubscriptions)
      .values({
        subscriberId: input.subscriberId,
        tierId: input.tierId,
        ownerId: input.ownerId,
      })
      .returning();
    return row!;
  }

  async findById(id: string): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, id))
      .limit(1);
    return row ?? null;
  }

  async activate(id: string, periodEnd: Date): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .update(userSubscriptions)
      .set({ status: "active", currentPeriodEnd: periodEnd })
      .where(eq(userSubscriptions.id, id))
      .returning();
    return row ?? null;
  }

  async cancel(id: string): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .update(userSubscriptions)
      .set({ status: "cancelled" })
      .where(eq(userSubscriptions.id, id))
      .returning();
    return row ?? null;
  }

  async findActiveFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.subscriberId, subscriberId),
          eq(userSubscriptions.ownerId, ownerId),
          eq(userSubscriptions.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async createTransaction(input: {
    userSubscriptionId: string;
    amount: number;
    gatewayReferenceId?: string | null;
  }): Promise<UserTransactionRow> {
    const [row] = await this.db
      .insert(userTransactions)
      .values({
        userSubscriptionId: input.userSubscriptionId,
        amount: input.amount,
        gatewayReferenceId: input.gatewayReferenceId ?? null,
      })
      .returning();
    return row!;
  }

  async findTransactionById(id: string): Promise<UserTransactionRow | null> {
    const [row] = await this.db
      .select()
      .from(userTransactions)
      .where(eq(userTransactions.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Conditional on the column still being NULL, so the reference is written
   * exactly once — see the port's own docstring for why overwriting it would
   * destroy the anchor Task 7's webhook checks the delivered `body.id` against.
   */
  async attachGatewayReference(
    transactionId: string,
    gatewayReferenceId: string
  ): Promise<boolean> {
    const rows = await this.db
      .update(userTransactions)
      .set({ gatewayReferenceId })
      .where(
        and(
          eq(userTransactions.id, transactionId),
          isNull(userTransactions.gatewayReferenceId)
        )
      )
      .returning({ id: userTransactions.id });
    return rows.length > 0;
  }

  async markTransactionPaid(id: string, paidAt: Date): Promise<UserTransactionRow | null> {
    const [row] = await this.db
      .update(userTransactions)
      .set({ status: "paid", paidAt })
      .where(eq(userTransactions.id, id))
      .returning();
    return row ?? null;
  }
}
