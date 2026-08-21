import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, userSubscriptions, userTransactions } from "../../db/schema";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import type {
  ExpirableInvoiceRef,
  PendingSubscriptionClaim,
  PendingUserCheckout,
  SubscriberRow,
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
  UserTransactionRow,
} from "../../application/ports/user-subscription-repository.port";

/**
 * The CLOSED wire projection for `listActiveSubscribers` — see
 * `SubscriberRow`'s own docstring for exactly why these three columns and
 * no others. Named explicitly, same discipline as
 * `DrizzleFollowRepository`'s `publicListColumns`: the excluded columns
 * (`app_user.email`, `.whatsapp_number`, `.xendit_account_id`, `.id`, and
 * every OTHER subscription this subscriber holds) are never fetched from
 * the database at all, not merely stripped from a wider row afterwards.
 */
const subscriberProjection = {
  handle: appUsers.handle,
  displayName: appUsers.displayName,
  since: userSubscriptions.createdAt,
} as const;

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
   * `ON CONFLICT ... DO NOTHING`, deliberately NOT a bare INSERT caught for
   * `23505` — which is what this method did until Phase 5b, Task 2 put it
   * inside a transaction.
   *
   * **A CAUGHT UNIQUE VIOLATION IS ONLY CLEAN WHEN IT IS THE LAST STATEMENT OF
   * ITS TRANSACTION.** Postgres aborts the transaction the moment the violation
   * is raised, so everything after the catch — starting with `findPending`
   * below, which the catch itself needs — fails with `25P02`, "current
   * transaction is aborted, commands ignored until end of transaction block".
   * On the pool that never showed, because the implicit transaction was one
   * statement wide. `StartUserSubscription` now retires a lapsed membership and
   * claims this slot inside ONE transaction (see `UserPurchaseUnitOfWorkPort`),
   * where the loser of a double tap is emphatically not the last statement: it
   * goes on to read its winner's checkout. Measured before the fix — thirty
   * concurrent taps, twenty-nine `25P02` five-hundreds.
   *
   * `DO NOTHING` never raises the error in the first place: the loser's INSERT
   * is a no-op, `RETURNING` yields no row, and `created: false` is genuinely
   * clean with the transaction intact. Exactly the conclusion, and exactly the
   * fix, `JoinRequestRepositoryPort.createPending` records — see its docstring
   * for the two failure modes of getting `target`/`where` wrong, only one of
   * which is loud.
   *
   * `target` + `where` reproduce `user_subscription_one_pending`'s own partial
   * predicate, and BOTH must be kept in step with the index in `db/schema.ts`.
   * They also keep this narrow, which is what the old catch's constraint-name
   * check bought: a conflict on any OTHER index of this table is a different
   * bug and still raises rather than being reported as "somebody else is
   * already paying".
   */
  async claimPending(input: {
    subscriberId: string;
    tierId: string;
    ownerId: string;
  }): Promise<PendingSubscriptionClaim> {
    const [row] = await this.db
      .insert(userSubscriptions)
      .values({
        subscriberId: input.subscriberId,
        tierId: input.tierId,
        ownerId: input.ownerId,
      })
      .onConflictDoNothing({
        target: [userSubscriptions.subscriberId, userSubscriptions.ownerId],
        where: sql`${userSubscriptions.status} = 'pending'`,
      })
      .returning();
    if (row) {
      return { subscription: row, created: true };
    }
    const existing = await this.findPending(input.subscriberId, input.ownerId);
    if (!existing) {
      // The holder settled or released between the conflict and this read.
      // Failing is the honest answer — the caller retries and claims it —
      // rather than inventing a row for it to reuse.
      throw new Error(
        "DrizzleUserSubscriptionRepository.claimPending: the pending slot was refused " +
          "but no pending subscription exists for this pair — it settled or was released " +
          "in between; retry"
      );
    }
    return { subscription: existing, created: false };
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

  /**
   * **A TERMINAL STATUS IS NEVER REWRITTEN** — the final whole-branch review's m-2.
   * Before 5b nothing but this method ever ended a `user_subscription`, so an
   * unconditional UPDATE was safe. Task 5's sweep now writes `expired` to abandoned
   * pending rows and Task 2/3's retirement writes it to lapsed active ones, which
   * gives an abandoned row two possible enders — and without this predicate what the
   * row says afterwards would depend on which one ran last. Nothing breaks either way
   * (both statuses are terminal and both free the partial indexes), but "cancelled"
   * and "expired" are different facts about why a membership stopped, and the record
   * is the only reason the row is kept rather than deleted.
   *
   * So only a LIVE row can be cancelled, and a caller is told when nothing moved —
   * see `StartUserSubscription.releaseClaim`, which treats "already terminal" as the
   * success it is rather than warning about a claim that is no longer held.
   */
  async cancel(id: string): Promise<UserSubscriptionRow | null> {
    const [row] = await this.db
      .update(userSubscriptions)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(userSubscriptions.id, id),
          or(eq(userSubscriptions.status, "pending"), eq(userSubscriptions.status, "active"))
        )
      )
      .returning();
    return row ?? null;
  }

  /**
   * THE CONDITIONAL UPDATE — see the port's own docstring for why this must
   * be the arbiter rather than a read followed by a write. `<=` on
   * `current_period_end` matches `NOW` at the exact boundary, which is
   * deliberate: a period that ends AT `now` is over, not still running.
   */
  async retireExpired(subscriberId: string, ownerId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(userSubscriptions)
      .set({ status: "expired" })
      .where(
        and(
          eq(userSubscriptions.subscriberId, subscriberId),
          eq(userSubscriptions.ownerId, ownerId),
          eq(userSubscriptions.status, "active"),
          lte(userSubscriptions.currentPeriodEnd, now)
        )
      )
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  /**
   * What Task 3's worker sweep pages through, retiring each row it gets back
   * by calling `retireExpired` on it. Oldest period-end first, so a backlog
   * drains in the order members actually lapsed.
   */
  async listExpiredActive(now: Date, limit: number): Promise<UserSubscriptionRow[]> {
    return this.db
      .select()
      .from(userSubscriptions)
      .where(and(eq(userSubscriptions.status, "active"), lte(userSubscriptions.currentPeriodEnd, now)))
      .orderBy(userSubscriptions.currentPeriodEnd)
      .limit(limit);
  }

  /**
   * Task 5's stale-pending sweep: what the worker sweep pages through, expiring each
   * row it gets back by calling `expireStalePending` on it. Oldest first, so a
   * backlog of abandoned carts drains in the order they were abandoned.
   *
   * Served by `user_subscription_status_current_period_end_idx` for its leading
   * `status` equality — the same index Task 3 added and the same reasoning: the
   * planner can use a leading column of a composite btree index for an equality
   * filter even though `current_period_end` (its trailing column) plays no part
   * here. No new index was needed: `pending` rows are a small, fast-turning slice
   * of this table by construction (`user_subscription_one_pending` allows at most
   * one per pair), unlike `active`, which is why Task 3's covering index mattered
   * enough to add and this does not.
   */
  async listStalePending(cutoff: Date, limit: number): Promise<UserSubscriptionRow[]> {
    return this.db
      .select()
      .from(userSubscriptions)
      .where(and(eq(userSubscriptions.status, "pending"), lte(userSubscriptions.createdAt, cutoff)))
      .orderBy(userSubscriptions.createdAt)
      .limit(limit);
  }

  /**
   * THE CONDITIONAL UPDATE — see the port's own docstring for why `status = 'pending'`
   * alone is the whole arbiter here, unlike `retireExpired`'s two-predicate WHERE.
   */
  async expireStalePending(id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    const rows = await this.db
      .update(userSubscriptions)
      .set({ status: "expired" })
      .where(and(eq(userSubscriptions.id, id), eq(userSubscriptions.status, "pending")))
      .returning({ id: userSubscriptions.id });
    return rows.length > 0;
  }

  /**
   * The invoice a stale pending row opened, for the sweep to cancel at the provider
   * — see the port's own docstring for why each `null` below is a case where the
   * call would be WRONG rather than merely pointless.
   *
   * ONE query, three tables: the subscription for its owner, the transaction for
   * the gateway reference, and `app_user` for the sub-account the invoice was
   * created under. It is run at most once per swept row (and stale pending rows are
   * a small, fast-turning slice by construction — `user_subscription_one_pending`
   * allows at most one per pair), so it is not on any hot path.
   *
   * `isConnectedPaymentAccount` is applied HERE rather than left to the caller: the
   * sentinel is truthy, and the worker's structural port deliberately knows nothing
   * about this codebase's domain. A row whose owner is half-connected reads as "no
   * invoice to cancel", which is the safe answer — the provider would refuse the
   * call anyway, and the sweep would count a failure for it.
   *
   * Newest transaction first, matching `findPendingCheckout`: if an earlier attempt
   * left more than one, the invoice we kill is the one most recently opened — the
   * same one that method would have handed back to the buyer.
   */
  async findExpirableInvoice(subscriptionId: string): Promise<ExpirableInvoiceRef | null> {
    if (!UUID_PATTERN.test(subscriptionId)) {
      return null;
    }
    const [row] = await this.db
      .select({
        invoiceId: userTransactions.gatewayReferenceId,
        forAccountId: appUsers.xenditAccountId,
      })
      .from(userSubscriptions)
      .innerJoin(userTransactions, eq(userTransactions.userSubscriptionId, userSubscriptions.id))
      .innerJoin(appUsers, eq(appUsers.id, userSubscriptions.ownerId))
      .where(
        and(
          eq(userSubscriptions.id, subscriptionId),
          eq(userTransactions.status, "pending"),
          isNotNull(userTransactions.gatewayReferenceId)
        )
      )
      .orderBy(desc(userTransactions.createdAt))
      .limit(1);
    if (!row || row.invoiceId === null) return null;
    // NOT `if (row.forAccountId)`. The provisioning sentinel is truthy — see the
    // port docstring, and `isConnectedPaymentAccount`'s own.
    if (!isConnectedPaymentAccount(row.forAccountId)) return null;
    return { invoiceId: row.invoiceId, forAccountId: row.forAccountId };
  }

  /**
   * Task 4's reminder pass: whom to warn BEFORE their membership ends. See the port
   * docstring for why `from` is exclusive and `to` inclusive, and why this is paged
   * by keyset rather than capped.
   *
   * Served by `user_subscription_status_current_period_end_idx` — the same index
   * Task 3 added for `listExpiredActive`, and for the same reason: `status` leads
   * because the equality is what makes it selective, and `current_period_end` trails
   * because both predicates on it here are ranges. Nothing new was needed.
   *
   * The keyset is a tuple comparison spelled out rather than a row constructor,
   * exactly as `DrizzleSubscriptionRepository.findDueForRenewal` writes it, and it
   * sorts in the SAME order it compares in — otherwise the walk can skip rows.
   */
  async listExpiringActive(input: {
    from: Date;
    to: Date;
    limit: number;
    after?: { currentPeriodEnd: Date; id: string };
  }): Promise<UserSubscriptionRow[]> {
    const { after } = input;
    return this.db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.status, "active"),
          // Redundant with the two comparisons below in Postgres (NULL compared with
          // anything is NULL, so the row is excluded either way), and kept because it
          // states the intent: a subscription that never activated has no period to
          // be near the end of.
          isNotNull(userSubscriptions.currentPeriodEnd),
          // EXCLUSIVE. A membership already past its end is the retirement sweep's,
          // and `listExpiredActive`'s `<= now` is the exact complement of this — so
          // no row can ever be in both result sets.
          gt(userSubscriptions.currentPeriodEnd, input.from),
          lte(userSubscriptions.currentPeriodEnd, input.to),
          after === undefined
            ? undefined
            : or(
                gt(userSubscriptions.currentPeriodEnd, after.currentPeriodEnd),
                and(
                  eq(userSubscriptions.currentPeriodEnd, after.currentPeriodEnd),
                  gt(userSubscriptions.id, after.id)
                )
              )
        )
      )
      .orderBy(asc(userSubscriptions.currentPeriodEnd), asc(userSubscriptions.id))
      .limit(input.limit);
  }

  /**
   * THE query `findActiveFor` runs — pulled out and returned UN-AWAITED so a
   * test can introspect the exact object the driver receives, via drizzle's
   * synchronous `.toSQL()`. `findActiveFor` itself is `async` and used to
   * build and await this inline, which left `is-member-of.test.ts`'s EXPLAIN
   * test with nothing to hook into except a hand-copied literal string of the
   * WHERE clause — a test that matched today but could not fail if this
   * query's predicates ever changed. Now it can: the EXPLAIN test calls this
   * method directly, exactly as `drizzle-post.repository.test.ts` calls
   * `listGlobal`/`listByAuthor` un-awaited for the same reason.
   *
   * Not part of `UserSubscriptionRepositoryPort` — this is an implementation
   * detail `findActiveFor` composes, not a capability the application layer
   * is meant to reach for.
   */
  activeMembershipQuery(subscriberId: string, ownerId: string) {
    return this.db
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
  }

  async findActiveFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null> {
    if (!UUID_PATTERN.test(subscriberId) || !UUID_PATTERN.test(ownerId)) {
      return null;
    }
    const [row] = await this.activeMembershipQuery(subscriberId, ownerId);
    return row ?? null;
  }

  /**
   * See the port's own docstring for the full contract. `gt` on
   * `current_period_end` is the SAME strict comparison
   * `IsMemberOf.membershipStanding` uses (`> now`, not `>=`) — a period
   * ending at exactly `now` has ended, not one tick from ending.
   *
   * Selects `subscriberProjection` ONLY — never `userSubscriptions.*` or
   * `appUsers.*` — so the closed shape is enforced at the query, the same
   * discipline `findPendingCheckout` and `DrizzleFollowRepository`'s
   * `listFollowers` both already follow.
   */
  async listActiveSubscribers(ownerId: string, now: Date): Promise<SubscriberRow[]> {
    if (!UUID_PATTERN.test(ownerId)) {
      return [];
    }
    return this.db
      .select(subscriberProjection)
      .from(userSubscriptions)
      .innerJoin(appUsers, eq(userSubscriptions.subscriberId, appUsers.id))
      .where(
        and(
          eq(userSubscriptions.ownerId, ownerId),
          eq(userSubscriptions.status, "active"),
          gt(userSubscriptions.currentPeriodEnd, now)
        )
      )
      .orderBy(desc(userSubscriptions.createdAt), desc(userSubscriptions.id));
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
