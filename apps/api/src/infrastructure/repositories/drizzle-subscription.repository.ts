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
  RenewalReminderContext,
  SubscriptionRecord,
  SubscriptionRepositoryPort,
  TransactionRecord,
} from "../../application/ports/subscription-repository.port";
import { computeNextBillingDate } from "../../domain/billing-cycle";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";

/**
 * Matches the canonical 8-4-4-4-12 hex form Postgres accepts for `uuid`.
 * `subscription.id` and `transaction.id` are uuid columns, so comparing one
 * against a value that is not a uuid makes Postgres raise SQLSTATE 22P02
 * (`invalid input syntax for type uuid`) rather than returning no rows. Every
 * read here that takes an id from outside — an outbox payload, a URL, a token's
 * claims — must report a MISS instead, because a `DrizzleQueryError` carries the
 * statement's bound parameters onto the log path and turns an unknown id into a
 * 500 rather than the 404 it deserves.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `subscription.status` for a member who currently has access. */
const ACTIVE_SUBSCRIPTION = "active";

/** `subscription.status` for a member whose renewal is late but still inside grace. */
const PAST_DUE_SUBSCRIPTION = "past_due";

/**
 * `subscription.status` for a member whose grace period ran out unpaid. Terminal: the
 * churn pass writes it once, and nothing moves a row out of it — a member who pays again
 * gets a NEW subscription, which is what makes their re-grant an honest new grant
 * (`unbanChatMember` and a fresh invite) rather than a renewal.
 *
 * "Nothing moves a row out of it" USED TO BE ENFORCED HERE, by `markPaid`: a payment
 * arriving for a churned subscription was refused and rolled its whole statement back.
 * Retire-telegram Task 5 deleted `markPaid` with its last caller, so the enforcement went
 * with the payment path it guarded — there is now no code anywhere that settles a
 * `transaction` row, so nothing can flip this status at all. The record is kept because
 * the failure it closed is instructive: predicated only on the id, the UPDATE turned
 * `churned` → `active` for a payment created while `past_due` and settled after the churn
 * pass ran, which advanced the billing date, cleared the deadline, deleted the reminder
 * claims, and let a stale revoke row evict a paid-up member.
 */
const CHURNED_SUBSCRIPTION = "churned";

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
    try {
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
    } catch (err) {
      // This is a bare INSERT — unlike an UPDATE, which a caller can predicate on
      // the row's own current status: nothing here can see whether the member
      // already holds an active row for this tier before attempting it.
      // `subscription_member_tier_active_unique` is the only thing that can catch
      // it, and it is REACHABLE — an already-approved member can file a fresh
      // `join_request` (its partial unique index only covers `pending` rows), and
      // `DecideJoinRequest` approving it a second time lands exactly here. Mapped
      // rather than left raw so the caller gets a typed `UniqueViolationError`
      // instead of a driver error carrying this statement's bound parameters.
      rethrowUniqueViolation(err, {
        subscription_member_tier_active_unique: {
          rule: UniqueRule.subscriptionMemberTierActive,
          message: "member already holds an active subscription to this tier",
        },
      });
    }
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
   * `id` arrives straight off a public URL — see the port docstring — so it is
   * shape-checked before it reaches the driver. See `UUID_PATTERN`.
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
}
