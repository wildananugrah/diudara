import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { userSubscriptions, userTransactions } from "../../db/schema";
import { uniqueViolationConstraint } from "./pg-errors";
import type {
  PendingSubscriptionClaim,
  PendingUserCheckout,
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
  UserTransactionRow,
} from "../../application/ports/user-subscription-repository.port";

/**
 * Every id that reaches this repository from OUTSIDE is shape-checked against
 * this before it reaches the driver, exactly as `DrizzleSubscriptionRepository`
 * does for the community flow.
 *
 * Postgres raises on a malformed uuid, and Task 7's webhook — a PUBLIC endpoint
 * — resolves its transaction id by slicing a prefix off an attacker-chosen
 * `external_id`: `usub_` yields `""` and `usub_x` yields `"x"`. Unshaped, each
 * of those is a 500 anybody can trigger at will. A miss must read as `null`,
 * which is exactly what "no such row" is.
 */
/**
 * The partial unique index that arbitrates a double tap — see
 * `UserSubscriptionRepositoryPort.claimPending`. Matched by NAME so the catch
 * below cannot widen: a different unique violation on this table is a different
 * bug and must not be reported as "somebody else is already paying".
 */
const PENDING_SUBSCRIPTION_CONSTRAINT = "user_subscription_one_pending";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /**
   * The narrow catch. `uniqueViolationConstraint` returns the constraint name
   * ONLY for SQLSTATE `23505` (see `pg-errors.ts` for the verified error shape),
   * and only THIS name is turned into a claim result — every other error, unique
   * or not, is rethrown untouched. A blanket catch here would report "somebody
   * else holds the slot" for a connection failure.
   *
   * NOT SAFE INSIDE AN ENCLOSING TRANSACTION, the same caveat
   * `DrizzleFollowRepository.follow` and `DrizzleJoinRequestRepository` record:
   * a unique violation aborts the surrounding transaction, so the SELECT below
   * would fail too. Nothing calls this inside one.
   */
  async claimPending(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<PendingSubscriptionClaim> {
    try {
      return { subscription: await this.create(input), created: true };
    } catch (err) {
      if (uniqueViolationConstraint(err) !== PENDING_SUBSCRIPTION_CONSTRAINT) {
        throw err;
      }
      const existing = await this.findPending(input.subscriberId, input.ownerId);
      if (!existing) {
        // The holder settled or released between the violation and this read.
        // Rethrowing is the honest answer — the caller retries and claims it —
        // rather than inventing a row for it to reuse.
        throw err;
      }
      return { subscription: existing, created: false };
    }
  }

  /** The pair's pending subscription, whatever its tier. Private: `claimPending` is the contract. */
  private async findPending(
    subscriberId: string,
    ownerId: string
  ): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.subscriberId, subscriberId),
          eq(userSubscriptions.ownerId, ownerId),
          eq(userSubscriptions.status, "pending")
        )
      )
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<UserSubscriptionRow | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
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
    if (!UUID_PATTERN.test(subscriberId) || !UUID_PATTERN.test(ownerId)) {
      return null;
    }
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
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
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
    gatewayReferenceId: string,
    invoiceUrl: string
  ): Promise<boolean> {
    if (!UUID_PATTERN.test(transactionId)) {
      return false;
    }
    const rows = await this.db
      .update(userTransactions)
      .set({ gatewayReferenceId, gatewayInvoiceUrl: invoiceUrl })
      .where(
        and(
          eq(userTransactions.id, transactionId),
          isNull(userTransactions.gatewayReferenceId)
        )
      )
      .returning({ id: userTransactions.id });
    return rows.length > 0;
  }

  /**
   * ONE query, joining the pair's pending subscription to its pending
   * transaction — see the port's docstring for the double-charge this exists to
   * prevent. `isNotNull(gatewayInvoiceUrl)` is the load-bearing predicate: a
   * transaction with no invoice url is an attempt whose provider call failed,
   * and treating that as "a payment is already in progress" would lock the
   * buyer out of a purchase nobody ever charged them for.
   */
  async findPendingCheckout(
    subscriberId: string,
    ownerId: string
  ): Promise<PendingUserCheckout | null> {
    if (!UUID_PATTERN.test(subscriberId) || !UUID_PATTERN.test(ownerId)) {
      return null;
    }
    const [row] = await this.db
      .select({
        subscriptionId: userSubscriptions.id,
        tierId: userSubscriptions.tierId,
        transactionId: userTransactions.id,
        invoiceUrl: userTransactions.gatewayInvoiceUrl,
      })
      .from(userSubscriptions)
      .innerJoin(
        userTransactions,
        eq(userTransactions.userSubscriptionId, userSubscriptions.id)
      )
      .where(
        and(
          eq(userSubscriptions.subscriberId, subscriberId),
          eq(userSubscriptions.ownerId, ownerId),
          eq(userSubscriptions.status, "pending"),
          eq(userTransactions.status, "pending"),
          isNotNull(userTransactions.gatewayInvoiceUrl)
        )
      )
      // Newest first: if an earlier attempt somehow left more than one, the
      // invoice we hand back is the one most recently opened.
      .orderBy(desc(userTransactions.createdAt))
      .limit(1);
    if (!row || row.invoiceUrl === null) return null;
    return {
      subscriptionId: row.subscriptionId,
      tierId: row.tierId,
      transactionId: row.transactionId,
      invoiceUrl: row.invoiceUrl,
    };
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
