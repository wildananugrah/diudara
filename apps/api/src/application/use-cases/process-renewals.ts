import {
  computeGraceEndsAt,
  dueStageFor,
  isDueOrOverdue,
  latestDueDateInReminderWindow,
  type ReminderStage,
} from "../../domain/renewal-schedule";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { ClockPort } from "../ports/clock.port";
import {
  OUTBOX_SEND_RENEWAL_REMINDER,
  type OutboxRepositoryPort,
} from "../ports/outbox-repository.port";
import type { RenewalReminderRepositoryPort } from "../ports/renewal-reminder-repository.port";
import type {
  DueRenewalRecord,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";

/** `activity_log.event_type` for a reminder this pass claimed and queued. */
export const RENEWAL_REMINDER_QUEUED = "renewal_reminder_queued";

/**
 * `activity_log.event_type` for a reminder this pass deliberately did NOT send.
 *
 * Recorded rather than passed over in silence: "the member was never told" is the
 * failure mode of this whole phase, so the one case where it is intentional has to be
 * visible in the audit trail (spec §8: an archived community gets no reminders and no
 * revocation).
 */
export const RENEWAL_REMINDER_SKIPPED = "renewal_reminder_skipped";

/**
 * Community statuses whose members still get renewal reminders.
 *
 * An ALLOWLIST, the same shape and for the same reason as `VISIBLE_STATUSES` in
 * get-public-community.ts: `community.status` is a free varchar, so a value nobody
 * anticipated must fail CLOSED — recorded and not messaged — rather than dun the
 * members of a community whose state we do not understand.
 *
 * `paused` IS in here, and that is the interesting half. Pausing stops NEW purchases
 * (spec §9.1); it does not abandon the members who already paid. Accepting only
 * `active` would let every existing member of a paused community lapse without a word,
 * and then churn — which is a worse outcome than the one pausing was for.
 *
 * It is deliberately NOT `VISIBLE_STATUSES` itself, even though the two sets have the
 * same members today. That set answers "may a stranger see this community's page";
 * this one answers "do we still bill its members". Sharing the constant would mean a
 * status added for one question silently changing the answer to the other.
 *
 * Exported so `SendRenewalReminder` re-checks the SAME set at the other end of the
 * outbox — a community can be archived while a row waits — rather than keeping a second
 * allowlist that could drift. Same reason `VISIBLE_STATUSES` is exported for
 * `StartCheckout`.
 */
export const REMINDABLE_COMMUNITY_STATUSES: ReadonlySet<string> = new Set(["active", "paused"]);

/**
 * Due subscriptions read per QUERY — not per pass. A pass walks the whole backlog in
 * pages of this size (see `execute`), because a reminded subscription does not leave
 * the result set and a hard per-pass cap would therefore starve everybody past it for
 * ever.
 *
 * 500 keeps one result set small enough to hold in memory while making the page count
 * uninteresting for any realistic backlog.
 */
const DEFAULT_BATCH_SIZE = 500;

export interface ProcessRenewalsConfig {
  /** Rows per query. The pass still covers every due subscription — see `execute`. */
  batchSize?: number;
}

export interface ProcessRenewalsResult {
  /** Due subscriptions this pass looked at. */
  considered: number;
  /** Reminders this pass claimed and queued — one per (subscription, stage), ever. */
  reminded: number;
  /** Due subscriptions whose stage had already been claimed, by an earlier pass or a concurrent one. */
  alreadyReminded: number;
  /** Due subscriptions deliberately not reminded, with the reason in `activity_log`. */
  skipped: number;
  /** `active` → `past_due` transitions this pass made. */
  transitionedToPastDue: number;
}

/**
 * The renewal reminder pass: the first thing in this codebase driven by a clock rather
 * than by a request.
 *
 * WHAT IT GUARANTEES, and how:
 *
 *  1. ONE MESSAGE PER STAGE, EVER. `recordIfNew` inserts into `renewal_reminder` with
 *     `ON CONFLICT DO NOTHING`, so the unique `(subscription_id, stage)` index decides
 *     who sends. Never a pre-check: two overlapping passes would both read "not yet"
 *     and both queue, and the member would get two WhatsApp messages about one overdue
 *     payment. The claim comes BEFORE the outbox row, so the failure direction is a
 *     reminder that is claimed and not sent (the next stage still fires) rather than one
 *     sent twice.
 *  2. A MISSED WINDOW IS CAUGHT UP, NOT REPLAYED. `dueStageFor` answers with the single
 *     most advanced applicable stage, so a pass that has been down for three days
 *     queues `overdue_3d` once and never `pre_3d` + `due` + `overdue_1d` in a burst.
 *     The catch-up is a property of the schedule; this class just does not loop over
 *     stages.
 *  3. THE GRACE DEADLINE IS WRITTEN ONCE. `markPastDue` is predicated on
 *     `status = 'active'`, so only the transition writes `grace_ends_at` and no later
 *     pass can move it. It is computed from the DUE DATE, not from `now`, so a pass
 *     that ran late does not silently extend everybody's grace either.
 *  4. TIME IS INJECTED. `clock.now()` is read once per `execute`, never at
 *     construction: this object lives for the lifetime of a worker process.
 *
 * It sends nothing itself. The outbox row is the send, handled by
 * `SendRenewalReminder` in the worker, which inherits Phase 4's bounded retries — a
 * Fonnte outage must delay one member's reminder, not abort the pass and leave everyone
 * behind them unreminded.
 */
export class ProcessRenewals {
  private readonly batchSize: number;

  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly reminders: RenewalReminderRepositoryPort,
    private readonly outbox: OutboxRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * The phase's defining dependency. A `Date.now()` inside this class would make
     * every test below unwritable and the Asia/Jakarta boundary unobservable.
     */
    private readonly clock: ClockPort,
    config: ProcessRenewalsConfig = {}
  ) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async execute(): Promise<ProcessRenewalsResult> {
    // ONCE per pass, so every row in this batch is judged against the same instant.
    // Re-reading the clock per row would let a long pass straddle WIB midnight and give
    // two members due on the same day different stages.
    const now = this.clock.now();
    const dueOnOrBefore = latestDueDateInReminderWindow(now);

    const result: ProcessRenewalsResult = {
      considered: 0,
      reminded: 0,
      alreadyReminded: 0,
      skipped: 0,
      transitionedToPastDue: 0,
    };

    // PAGED, not capped. A reminded subscription stays in this result set — the claim
    // lives in `renewal_reminder`, not in a status the query could filter on — so a
    // pass that simply took the first `batchSize` rows would return the same rows every
    // time and never reach anybody behind them. Measured with a limit of 1 and two due
    // members: the second was never reminded, and no pass would ever have reminded them.
    //
    // The cursor is strictly increasing in the same order the query sorts by, so the
    // walk terminates and no row is visited twice.
    let after: { nextBillingDate: string; id: string } | undefined;
    for (;;) {
      const page = await this.subscriptions.findDueForRenewal({
        dueOnOrBefore,
        limit: this.batchSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.length === 0) break;
      result.considered += page.length;

      for (const row of page) {
        await this.handleDueSubscription(row, now, result);
      }

      const last = page[page.length - 1];
      // Non-null for every row the query returns — `next_billing_date is not null` is in
      // its WHERE clause — so the fallback is unreachable and only there to keep the
      // cursor's type honest.
      after = {
        nextBillingDate: last.subscription.nextBillingDate ?? dueOnOrBefore,
        id: last.subscription.id,
      };
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One due subscription. Counts land on `result`; nothing here throws by design. */
  private async handleDueSubscription(
    row: DueRenewalRecord,
    now: Date,
    result: ProcessRenewalsResult
  ): Promise<void> {
    const { subscription, communityId, communityStatus } = row;
    if (subscription.nextBillingDate === null) {
      // Excluded by the query, so unreachable — but the column is nullable and the
      // conversion below would produce an Invalid Date rather than an error.
      return;
    }

    // `new Date("2026-03-10")` is UTC midnight, i.e. 07:00 WIB on the 10th, which is
    // safely inside the WIB day the column names. `dueStageFor` compares WIB calendar
    // days from there; applying an offset by hand instead is what lands on the wrong
    // day.
    const dueDate = new Date(subscription.nextBillingDate);
    const stage = dueStageFor(dueDate, now);
    if (stage === null) {
      // The query's cut-off is a WIB day and this is the same comparison, so this
      // means only that the row sits exactly on the far edge.
      return;
    }

    if (!REMINDABLE_COMMUNITY_STATUSES.has(communityStatus)) {
      // CLAIM THE STAGE ANYWAY, then record the skip. The claim is what bounds the
      // audit trail: without it a daily pass would write one `renewal_reminder_skipped`
      // row per subscription per day, for ever, for a community that was archived a
      // year ago. With it there is exactly one entry per stage, which is the same
      // "once per stage" rule the reminders themselves obey.
      //
      // The cost is that a community un-archived mid-stage does not get that stage's
      // reminder retroactively; the next stage fires normally. That is the right way
      // round: the alternative spams the log for ever to cover a case a creator can
      // resolve by waiting a day.
      if (await this.reminders.recordIfNew({ subscriptionId: subscription.id, stage })) {
        await this.recordSkip({
          memberId: subscription.memberId,
          communityId,
          communityStatus,
          subscriptionId: subscription.id,
          stage,
        });
        result.skipped += 1;
      } else {
        result.alreadyReminded += 1;
      }
      // NO transition and NO eviction clock for an archived community (spec §8).
      return;
    }

    // BEFORE the claim, deliberately. The transition is idempotent — the UPDATE is
    // predicated on `active`, so running it twice changes nothing — while the claim is
    // once-only. Doing it in this order means a process that dies between the two
    // leaves a member correctly `past_due` with an unspent reminder stage, rather
    // than a claimed stage on a member who is still `active` and will therefore never
    // churn.
    if (isDueOrOverdue(stage)) {
      // From the DUE DATE, never from `now`: a pass that has been down for three days
      // must not hand everybody three extra days of grace.
      if (await this.subscriptions.markPastDue(subscription.id, computeGraceEndsAt(dueDate))) {
        result.transitionedToPastDue += 1;
      }
    }

    if (!(await this.reminders.recordIfNew({ subscriptionId: subscription.id, stage }))) {
      // Somebody already claimed this stage — an earlier pass, or a concurrent one.
      // Nothing else may happen for this row.
      result.alreadyReminded += 1;
      return;
    }

    // The claim is spent, so this row is now THIS pass's responsibility to queue.
    // Enqueued before the audit entry: being reminded is the member's interest and
    // the audit entry is ours, so if only one of the two can happen it must be the
    // send. Ids and a stage only — the payload is read by a worker that logs, and
    // Phase 3 found payer PII in provider payloads.
    await this.outbox.enqueue({
      eventType: OUTBOX_SEND_RENEWAL_REMINDER,
      payload: { subscriptionId: subscription.id, stage },
    });
    await this.activityLog.record({
      memberId: subscription.memberId,
      communityId,
      eventType: RENEWAL_REMINDER_QUEUED,
      metadata: { stage, subscriptionId: subscription.id },
    });
    result.reminded += 1;
  }

  private async recordSkip(input: {
    memberId: string;
    communityId: string;
    communityStatus: string;
    subscriptionId: string;
    stage: ReminderStage;
  }): Promise<void> {
    console.warn(
      `[renewals] not reminding subscription=${input.subscriptionId}: its community is ` +
        `'${input.communityStatus}', which does not accept renewals — recorded in activity_log`
    );
    await this.activityLog.record({
      memberId: input.memberId,
      communityId: input.communityId,
      eventType: RENEWAL_REMINDER_SKIPPED,
      metadata: {
        reason: "community_not_accepting_renewals",
        communityStatus: input.communityStatus,
        stage: input.stage,
        subscriptionId: input.subscriptionId,
      },
    });
  }
}
