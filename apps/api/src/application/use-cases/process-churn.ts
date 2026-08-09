import { isPastGrace } from "../../domain/renewal-schedule";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { ClockPort } from "../ports/clock.port";
import {
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  type OutboxRepositoryPort,
} from "../ports/outbox-repository.port";
import type {
  DueRenewalRecord,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";

/** `activity_log.event_type` for a subscription this pass ended. */
export const CHURNED = "churned";

/**
 * `activity_log.event_type` for a churn whose Telegram removal was deliberately NOT
 * performed — today only because the community has been archived (spec §8).
 *
 * Recorded rather than passed over in silence, for the same reason
 * `RENEWAL_REMINDER_SKIPPED` is: "the member kept access they stopped paying for" is a
 * state somebody will eventually ask about, and the one case where it is intentional has
 * to be visible in the audit trail.
 */
export const CHURN_REVOKE_SKIPPED = "churn_revoke_skipped";

/**
 * Community statuses whose members are actually EVICTED when they stop paying.
 *
 * An ALLOWLIST, so a status nobody anticipated fails CLOSED — the member keeps access
 * and the skip is recorded — rather than ejecting the members of a community whose state
 * we do not understand.
 *
 * `paused` is in here: pausing stops NEW purchases (spec §9.1) and says nothing about a
 * member who has stopped paying, so the lifecycle continues normally. `archived` is not,
 * per spec §8 — an archived community's groups may already be gone, and removing people
 * from a community its creator has shut down achieves nothing anyone asked for.
 *
 * Deliberately NOT `REMINDABLE_COMMUNITY_STATUSES` itself, even though the two sets have
 * the same members today. That one answers "do we still dun this community's members";
 * this one answers "do we still take their access away". Sharing the constant would mean
 * a status added for one question silently changing the answer to the other — the same
 * reasoning that keeps `REMINDABLE_COMMUNITY_STATUSES` separate from `VISIBLE_STATUSES`.
 */
export const REVOCABLE_COMMUNITY_STATUSES: ReadonlySet<string> = new Set(["active", "paused"]);

/**
 * Churn candidates read per QUERY, not per pass — `execute` walks the whole backlog in
 * pages of this size. 500 keeps one result set small while making the page count
 * uninteresting for any realistic backlog, the same figure and reasoning as
 * `ProcessRenewals`.
 */
const DEFAULT_BATCH_SIZE = 500;

export interface ProcessChurnConfig {
  batchSize?: number;
}

export interface ProcessChurnResult {
  /** Past-grace subscriptions this pass looked at. */
  considered: number;
  /** `past_due` → `churned` transitions this pass made. */
  churned: number;
  /** Candidates another pass churned first, between this pass's read and its write. */
  alreadyChurned: number;
  /** Revocations queued — one per churned subscription whose community still evicts. */
  revocationsQueued: number;
  /** Subscriptions churned WITHOUT a revocation, with the reason in `activity_log`. */
  skippedRevocation: number;
}

/**
 * The churn pass: the thing that finally takes access away.
 *
 * WHAT IT GUARANTEES, and how:
 *
 *  1. ONE CHURN, ONE REVOKE, EVER. `markChurned` is predicated on
 *     `status = 'past_due'`, so the UPDATE that flips the status is also the thing that
 *     decides who may enqueue — never a preceding read. A second pass, or a concurrent
 *     one, is told `false` and enqueues nothing. This is the same shape as
 *     `recordIfNew`'s claim in `ProcessRenewals`, and for the same reason: the outbox
 *     row is the removal, so two rows are two removals.
 *  2. THE DEADLINE IS READ, NEVER RECOMPUTED. `grace_ends_at` was written when the
 *     subscription entered `past_due` and is compared as stored (Global Constraints), so
 *     no later config or timezone change can move the day a member loses access. The
 *     query does the comparison; `isPastGrace` re-does it here in the domain, which
 *     keeps the boundary — at the deadline the member still has access — in one place.
 *  3. IT REVOKES NOTHING ITSELF. The removal is an external Telegram call, so it goes
 *     through Phase 4's outbox and inherits its bounded retries: a Telegram outage
 *     delays one member's removal rather than aborting the pass and leaving everybody
 *     behind them in the group for another day. `RevokeChannelAccessForSystem` handles
 *     the row.
 *  4. TIME IS INJECTED. `clock.now()` is read once per `execute`, never at construction:
 *     this object lives for the lifetime of a worker process.
 *
 * The status change is committed BEFORE the revoke is queued, and the order matters in
 * only one direction: a crash between them leaves a `churned` member still in the group
 * with no queued removal, which the creator can fix by hand and which no test would call
 * correct — while the other order (queue, then churn) would let a second pass find the
 * row still `past_due` and queue a second removal. Losing a removal is recoverable;
 * double-revoking a member who re-paid in between is not.
 */
export class ProcessChurn {
  private readonly batchSize: number;

  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    private readonly clock: ClockPort,
    config: ProcessChurnConfig = {}
  ) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async execute(): Promise<ProcessChurnResult> {
    // ONCE per pass, so every row is judged against the same instant. Re-reading it per
    // row would let a long pass give two members with the same deadline different
    // answers.
    const now = this.clock.now();

    const result: ProcessChurnResult = {
      considered: 0,
      churned: 0,
      alreadyChurned: 0,
      revocationsQueued: 0,
      skippedRevocation: 0,
    };

    // PAGED, and it terminates for a reason `findDueForRenewal`'s cursor exists to
    // provide differently: a churned subscription LEAVES this result set, because the
    // pass writes the very status the query filters on. So each query sees a strictly
    // smaller backlog and no cursor is needed.
    //
    // The no-progress break is the guard for the one case where that is not true: if
    // every row in a page was already churned by a concurrent pass, nothing changed and
    // the next query would return the same page for ever. Then there is by definition
    // nothing for THIS pass to do.
    for (;;) {
      const page = await this.subscriptions.findPastGraceDeadline({
        now,
        limit: this.batchSize,
      });
      if (page.length === 0) break;
      result.considered += page.length;

      const before = result.churned;
      for (const row of page) {
        await this.handleCandidate(row, now, result);
      }
      if (result.churned === before) break;
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One churn candidate. Counts land on `result`; nothing here throws by design. */
  private async handleCandidate(
    row: DueRenewalRecord,
    now: Date,
    result: ProcessChurnResult
  ): Promise<void> {
    const { subscription, communityId, communityStatus } = row;
    if (subscription.graceEndsAt === null) {
      // Excluded by the query, so unreachable. Stated rather than assumed because the
      // column is nullable and a derived deadline is exactly what is forbidden here.
      return;
    }
    if (!isPastGrace(subscription.graceEndsAt, now)) {
      // The query already applied this, in SQL. Re-checked in the DOMAIN so the
      // boundary — a member at their deadline still has access — is decided by one
      // function rather than by two comparisons that could drift apart.
      return;
    }

    // THE CLAIM. Predicated on `past_due` inside the UPDATE, so this both makes the
    // transition and answers whether this pass is the one that made it. Everything
    // below is conditional on winning it.
    if (!(await this.subscriptions.markChurned(subscription.id))) {
      result.alreadyChurned += 1;
      return;
    }
    result.churned += 1;

    if (!REVOCABLE_COMMUNITY_STATUSES.has(communityStatus)) {
      // Churned, but NOT evicted (spec §8). The status change is what bounds this audit
      // entry to one: without it a daily pass would write the same skip row for the same
      // subscription for ever.
      console.warn(
        `[churn] subscription=${subscription.id} is churned but its access is NOT being ` +
          `revoked: the community is '${communityStatus}', which does not evict its ` +
          "members — recorded in activity_log"
      );
      await this.activityLog.record({
        memberId: subscription.memberId,
        communityId,
        eventType: CHURN_REVOKE_SKIPPED,
        metadata: {
          reason: "community_does_not_evict",
          communityStatus,
          subscriptionId: subscription.id,
        },
      });
      result.skippedRevocation += 1;
      return;
    }

    // Queued BEFORE the audit entry, the same order `ProcessRenewals` uses and for the
    // mirror-image reason: the removal is the creator's interest and the audit entry is
    // ours, so if only one of the two can happen it must be the removal. Ids only — the
    // worker logs around this payload.
    await this.outbox.enqueue({
      eventType: OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
      payload: { subscriptionId: subscription.id },
    });
    result.revocationsQueued += 1;

    await this.activityLog.record({
      memberId: subscription.memberId,
      communityId,
      eventType: CHURNED,
      metadata: {
        subscriptionId: subscription.id,
        reason: "grace_period_expired",
        // The deadline this member was actually measured against, which is the one thing
        // an audit of a disputed eviction needs and the one thing that cannot be
        // recomputed later.
        graceEndsAt: subscription.graceEndsAt.toISOString(),
      },
    });
  }
}
