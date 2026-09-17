import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { payments, subscriptions } from "../db/schema.ts";
import type { PaymentRepository, SubscriptionRepository } from "../../domain/ports.ts";
import type { PaymentStatus, SubscriptionStatus } from "../../domain/types.ts";

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    communityId: string; userId: string; tierId: string; status: SubscriptionStatus;
  }): Promise<{ id: string }> {
    const [row] = await this.db.insert(subscriptions).values(input).returning({ id: subscriptions.id });
    return { id: row!.id };
  }

  async cancelForMember(communityId: string, userId: string): Promise<void> {
    // ne(), not eq('active'): a 'pending' subscription must also stop, or an
    // unpaid signup could still activate after the member was removed.
    await this.db.update(subscriptions)
      .set({ status: "cancelled", endsAt: new Date() })
      .where(and(
        eq(subscriptions.communityId, communityId),
        eq(subscriptions.userId, userId),
        ne(subscriptions.status, "cancelled"),
      ));
  }

  async markActive(subscriptionId: string): Promise<void> {
    const startedAt = new Date();
    const endsAt = new Date(startedAt);
    endsAt.setMonth(endsAt.getMonth() + 1);
    await this.db.update(subscriptions)
      .set({ status: "active", startedAt, endsAt })
      .where(eq(subscriptions.id, subscriptionId));
  }
}

export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    subscriptionId: string; amountCents: number; method: string;
    status: PaymentStatus; gatewayRef: string | null;
  }): Promise<{ id: string }> {
    const [row] = await this.db.insert(payments)
      .values({ ...input, paidAt: input.status === "paid" ? new Date() : null })
      .returning({ id: payments.id });
    return { id: row!.id };
  }

  async markStatus(paymentId: string, status: PaymentStatus): Promise<void> {
    await this.db.update(payments)
      .set({ status, paidAt: status === "paid" ? new Date() : null })
      .where(eq(payments.id, paymentId));
  }

  async findByGatewayRef(ref: string) {
    const [row] = await this.db.select({ id: payments.id, subscriptionId: payments.subscriptionId })
      .from(payments).where(eq(payments.gatewayRef, ref)).limit(1);
    return row ?? null;
  }
}
