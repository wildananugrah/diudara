/**
 * Phase 5's two CLOCK-driven passes, plus Task 10's orphan-media sweep and Phase 5b's
 * expired-membership sweep (Task 3), membership-reminder pass (Task 4) and
 * pending-checkout cleanup (Task 5), as loops this process can run.
 *
 * Everything in `apps/worker` before this file was request-triggered at one remove:
 * a payment wrote an outbox row and the worker delivered it. These six are triggered
 * by nothing but the passage of time, which is why they need a schedule at all — and
 * why this module exists separately from `main.ts`: the composition root cannot be
 * imported by a test (it reaches `db/client.ts`), and "a throwing pass does not take
 * the process down" is exactly the property that must be pinned by one.
 *
 * It deliberately imports only the API's dependency-free `log-safety` helper at
 * runtime; the renewal/churn result shapes come in as TYPES, which erase.
 * `SweepOrphanMedia`, `SweepExpiredMemberships` and `SweepStalePendingCheckouts` are
 * the exceptions to "the pass lives in `apps/api`" — none has domain logic worth the
 * name (no WIB days, no grace periods, just a cutoff/predicate and a try/catch), so
 * unlike `ProcessRenewals`/`ProcessChurn`/`RemindExpiringMembership` each is defined
 * and tested entirely IN this file, against structural interfaces the caller
 * supplies — never against a database.
 */
import { redactLinks, safeErrorSummary } from "../../api/src/application/log-safety";
import type { ProcessChurnResult } from "../../api/src/application/use-cases/process-churn";
import type { RemindExpiringMembershipResult } from "../../api/src/application/use-cases/remind-expiring-membership";
import type { ProcessRenewalsResult } from "../../api/src/application/use-cases/process-renewals";
import { PollLoop, resolveIntervalMs } from "./poll-loop";

/**
 * How often the renewal and churn passes run when nothing configures it: one hour.
 *
 * WHY NOT 5 SECONDS, like the outbox. That interval is the delay a paying member sees
 * between their payment settling and their invite arriving, so it is sized for human
 * impatience. These passes decide whole **WIB calendar days**: `dueStageFor` answers
 * with a stage per day, and `renewal_reminder`'s unique `(subscription_id, stage)`
 * means the first pass of a WIB day claims that day's reminder and every later pass
 * that day is a no-op. Running them every 5 seconds would be ~17,000 queries a day to
 * do one day's worth of work.
 *
 * WHY NOT 24 HOURS, which is what "daily" would literally mean. `PollLoop` measures
 * its interval from the previous pass, not from a wall-clock time of day, so a 24-hour
 * interval pins the pass to whatever time of day the worker last restarted: a worker
 * that came up at 23:50 WIB would act on each WIB day's boundary 23 hours 50 minutes
 * late, for ever, and a redeploy would silently move everybody's reminder time. There
 * is no cron here and adding one would be the scheduler this task exists not to write.
 *
 * ONE HOUR makes the phase irrelevant. Whenever the worker happens to boot, a member
 * crosses into `past_due` — and a churned member loses access — within an hour of the
 * WIB midnight that decided it, and the cost is 24 passes a day against two queries,
 * against the outbox pass's 17,280. The **effect** is still daily, because the
 * schedule's unit is a day; only the latency changes.
 *
 * THOSE TWO QUERIES ARE INDEXED, and this comment used to say so before they were.
 * `subscription_status_next_billing_date_idx` and `subscription_status_grace_ends_at_idx`
 * (migration 0012) cover `findDueForRenewal` and `findPastGraceDeadline` respectively;
 * without them both passes seq-scanned and SORTED the whole `subscription` table every
 * hour, and the renewal pass's keyset pagination re-scanned it once per page. The claim
 * is now pinned by `schema-phase5.test.ts`, which reads `pg_indexes` and the query plans
 * rather than trusting a sentence in a docstring.
 *
 * Raise it (`WORKER_RENEWAL_INTERVAL_MS`) if the backlog ever makes a pass expensive;
 * lowering it below a minute buys nothing at all, because no second pass inside the
 * same WIB day can send a second reminder.
 */
export const DEFAULT_RENEWAL_INTERVAL_MS = 60 * 60_000;

/**
 * Reads `WORKER_RENEWAL_INTERVAL_MS`, failing CLOSED on anything that is not a usable
 * interval — same rules and same reason as `resolvePollIntervalMs`: `Number("abc")` is
 * `NaN`, `setTimeout` treats `NaN` as `0`, and the result is a worker hammering the
 * database rather than polling it.
 */
export function resolveRenewalIntervalMs(raw: string | undefined): number {
  return resolveIntervalMs(raw, {
    variableName: "WORKER_RENEWAL_INTERVAL_MS",
    defaultMs: DEFAULT_RENEWAL_INTERVAL_MS,
  });
}

/**
 * The renewal pass's summary line, or `null` when there is nothing to say.
 *
 * COUNTS ONLY, and not for tidiness: the rows this pass walks carry a member's
 * WhatsApp number, and the outbox rows it writes are read by a process that will
 * shortly hold an invite link. A subscription id would be defensible; a member id or a
 * phone number would not, so none of them are here — `ProcessRenewals` itself logs the
 * one id worth having, on the skip it records in `activity_log`.
 *
 * Silent on a pass that did nothing, so an hourly line saying "considered=0" does not
 * bury the one that says a reminder went out. `considered > 0` with `reminded = 0` is
 * NOT nothing — that is the shape of a pass finding rows and failing to act on them —
 * so it speaks.
 */
export function formatRenewalPassLine(result: ProcessRenewalsResult): string | null {
  if (
    result.considered === 0 &&
    result.reminded === 0 &&
    result.alreadyReminded === 0 &&
    result.skipped === 0 &&
    result.transitionedToPastDue === 0
  ) {
    return null;
  }
  return (
    `[renewals] considered=${result.considered} reminded=${result.reminded} ` +
    `already_reminded=${result.alreadyReminded} skipped=${result.skipped} ` +
    `past_due=${result.transitionedToPastDue}`
  );
}

/** The churn pass's summary line, or `null` when there is nothing to say. Counts only, as above. */
export function formatChurnPassLine(result: ProcessChurnResult): string | null {
  if (
    result.considered === 0 &&
    result.churned === 0 &&
    result.alreadyChurned === 0 &&
    result.revocationsQueued === 0 &&
    result.skippedRevocation === 0
  ) {
    return null;
  }
  return (
    `[churn] considered=${result.considered} churned=${result.churned} ` +
    `already_churned=${result.alreadyChurned} ` +
    `revocations_queued=${result.revocationsQueued} ` +
    `skipped_revocation=${result.skippedRevocation}`
  );
}

/**
 * One log-safe line for a pass that threw — the worker's ONLY way of logging a thrown
 * value, which is why every loop shares it.
 *
 * `safeErrorSummary` walks the cause chain and drops a failed statement's bound
 * parameters — Phase 4 found drizzle's `params:` list, which is a member's phone
 * number, in this exact log, and this process's `onError` was still printing
 * `err.message` raw — and `redactLinks` removes anything URL-shaped, because a provider
 * error can interpolate an invite link into its own message and that is a bearer
 * credential. `pass` is one of our own literals, so it needs no sanitising.
 */
export function formatPassFailure(
  pass:
    | "outbox"
    | "renewals"
    | "churn"
    | "media"
    | "memberships"
    | "membership-reminders"
    | "pending-checkouts",
  err: unknown
): string {
  return `[${pass}] pass failed: ${redactLinks(safeErrorSummary(err))}`;
}

/**
 * Task 10's orphan sweep — spec §8. `MediaRepositoryPort.listUnclaimedBefore` reads
 * unclaimed rows through a PARTIAL index (`post_media_unclaimed_idx`,
 * `WHERE post_id is null`), so a claimed row can never enter this pass no matter how
 * old it is — that half of the contract is enforced by the query, not by this file.
 *
 * The window is 24 HOURS, not the outbox's 5 seconds or the renewal/churn passes' one
 * hour: it is deliberately generous (spec §8 — someone may leave a composer open for
 * an hour) and it is measured from `created_at`, never from when an edit unclaimed the
 * row — an image removed by a `PATCH` today but uploaded days ago is swept on the very
 * next run, not after a fresh 24 hours, because nothing references it any more.
 */
export const ORPHAN_SWEEP_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Orphan rows read per QUERY, not per pass — same reasoning and same figure as
 * `ProcessRenewals`/`ProcessChurn`'s `DEFAULT_BATCH_SIZE`: it bounds one result set
 * while leaving any realistic backlog's page count uninteresting.
 */
const DEFAULT_ORPHAN_SWEEP_BATCH_SIZE = 500;

/** Just enough of `MediaRepositoryPort` for the sweep. Structural, like `RenewalPass`. */
export interface OrphanMediaRepository {
  listUnclaimedBefore(cutoff: Date, limit: number): Promise<{ id: string }[]>;
  /** Re-read immediately before the bytes go — see `sweepOne`. `null` when the row is already gone. */
  findById(id: string): Promise<{ postId: string | null } | null>;
  /** Deletes ONLY while still unclaimed, answering whether it did. See the port's own docstring. */
  deleteIfUnclaimed(id: string): Promise<boolean>;
}

/** Just enough of `MediaStoragePort` for the sweep. */
export interface OrphanMediaStorage {
  remove(id: string): Promise<void>;
}

export interface OrphanSweepResult {
  /** Unclaimed rows past the window this pass looked at. */
  considered: number;
  /** Rows whose objects AND row were both removed. */
  deleted: number;
  /**
   * Rows a POST claimed between the page listing and this row's turn, and which
   * the sweep therefore left completely alone. Never a failure: it is the guard
   * doing its job (final whole-branch review, Important 4), and an operator
   * seeing a steady trickle here is seeing composers being left open overnight,
   * not anything broken.
   */
  skipped: number;
  /** Rows whose object removal failed and were left in place, unclaimed, for the next pass to retry. */
  failed: number;
}

export interface SweepOrphanMediaOptions {
  windowMs?: number;
  batchSize?: number;
  /** Defaults to the real clock. Overridden in tests to place the window precisely. */
  now?: () => Date;
  /**
   * Where a single row's storage-removal failure is reported. Defaults to
   * `console.error`, matching every other per-item failure this worker logs
   * (e.g. `ProcessChurn`'s skipped-revocation warning) — injectable here only so a
   * test can capture the line without capturing the real console.
   */
  logError?: (line: string) => void;
}

/**
 * The orphan sweep: collects unclaimed media older than the window, deleting the
 * bucket objects and then the row.
 *
 * THE ORDER IS THE WHOLE CONTRACT. Objects are removed BEFORE the row, never the
 * reverse — deleting the row first and the objects second would, on a crash or a
 * storage failure in between, leave an object with NO row pointing at it: invisible to
 * `listUnclaimedBefore` (which only ever sees rows) and therefore unreachable by any
 * later sweep. Bytes leaked that way are gone forever. Objects-then-row fails the
 * other direction instead: a row that survives a failed object removal is still found,
 * by id, on the very next pass — the recoverable direction.
 *
 * ONE ROW'S FAILURE MUST NOT ABORT THE PASS. `MediaStoragePort.remove` throws an
 * `AggregateError` on a genuine failure (expired credentials, a 403, a network
 * partition — Task 2's review) rather than swallowing it, which is correct: a silent
 * delete failure would leave bytes in the bucket forever with nothing saying so. But a
 * naive loop over rows would die on the FIRST such failure and skip every orphan after
 * it — silently, and forever, since the next pass hits the very same row first. So
 * each row is swept in its own try/catch: a failure is counted, logged, and the row is
 * left unclaimed for the next pass to retry, and the loop moves on to the next row.
 */
export class SweepOrphanMedia {
  private readonly windowMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly logError: (line: string) => void;

  constructor(
    private readonly media: OrphanMediaRepository,
    private readonly storage: OrphanMediaStorage,
    options: SweepOrphanMediaOptions = {}
  ) {
    this.windowMs = options.windowMs ?? ORPHAN_SWEEP_WINDOW_MS;
    this.batchSize = options.batchSize ?? DEFAULT_ORPHAN_SWEEP_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
    this.logError = options.logError ?? ((line) => console.error(line));
  }

  async execute(): Promise<OrphanSweepResult> {
    const cutoff = new Date(this.now().getTime() - this.windowMs);
    const result: OrphanSweepResult = { considered: 0, deleted: 0, skipped: 0, failed: 0 };

    // PAGED. A swept row leaves the result set (it is deleted), so this terminates the
    // same way `ProcessChurn`'s walk does — except a FAILED row does NOT leave the set,
    // which is exactly why the no-progress guard below exists: without it, a page where
    // every row fails would be re-fetched, identically, forever.
    for (;;) {
      const page = await this.media.listUnclaimedBefore(cutoff, this.batchSize);
      if (page.length === 0) break;
      result.considered += page.length;

      // Progress is deleted OR skipped: a page of rows that were all claimed
      // since listing makes no deletions but does leave the result set (they
      // are no longer unclaimed), so counting only deletions here would break
      // out of a walk that was in fact progressing. Counting neither would
      // loop forever on the rows that fail — which is what this guard is for.
      const progressBefore = result.deleted + result.skipped;
      for (const row of page) {
        await this.sweepOne(row.id, result);
      }
      if (result.deleted + result.skipped === progressBefore) break;
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One orphan row. Never throws — a per-row failure lands on `result.failed`, not on the pass. */
  private async sweepOne(id: string, result: OrphanSweepResult): Promise<void> {
    try {
      // RE-READ BEFORE THE BYTES GO. `listUnclaimedBefore` produced this id at
      // the top of a page that may hold 500 rows and take a while to work
      // through; a post can claim any of them in the meantime (a composer left
      // open overnight, then used), and until the final whole-branch review the
      // sweep removed the bytes and the row anyway — the post silently ended up
      // with fewer photos than its author sent. This turns a window as long as
      // the pass into one as long as a single storage call.
      const row = await this.media.findById(id);
      if (row === null || row.postId !== null) {
        result.skipped += 1;
        return;
      }

      // OBJECTS BEFORE THE ROW — see the class docstring for why the reverse order
      // leaks bytes permanently and this one does not.
      await this.storage.remove(id);
      // CONDITIONAL, and the boolean is not decoration. The re-read above cannot
      // close the last instant between itself and this call; the `post_id IS
      // NULL` guard inside the DELETE can, and does. `false` here means a post
      // claimed the row while its bytes were being removed — the row is left
      // exactly as the post expects, and the loss (the bytes) is said out loud
      // rather than being counted as a clean deletion.
      if (await this.media.deleteIfUnclaimed(id)) {
        result.deleted += 1;
        return;
      }
      result.skipped += 1;
      this.logError(
        `[media] media=${id} was claimed by a post while its objects were being removed — ` +
          `the row was left in place and its bytes are GONE; the post now references media ` +
          `that will 404`
      );
    } catch (err) {
      result.failed += 1;
      this.logError(
        `[media] media=${id} was NOT swept and is left in place for the next pass — ` +
          `storage removal failed: ${redactLinks(safeErrorSummary(err))}`
      );
    }
  }
}

/**
 * Task 3's retirement sweep (spec — Phase 5b) — just enough of
 * `UserSubscriptionRepositoryPort` to run it. Structural, like `OrphanMediaRepository`:
 * `DrizzleUserSubscriptionRepository` satisfies this directly without being declared
 * against it, and a test can supply an in-memory double with no database at all.
 *
 * `listExpiredActive` and `retireExpired` are both Task 1's — see their own docstrings
 * on `UserSubscriptionRepositoryPort` for why `retireExpired` is a conditional UPDATE
 * (the arbiter) and never a read followed by a write.
 */
export interface ExpiredMembershipRepository {
  listExpiredActive(now: Date, limit: number): Promise<{ id: string; subscriberId: string; ownerId: string }[]>;
  retireExpired(subscriberId: string, ownerId: string, now: Date): Promise<boolean>;
}

export interface MembershipSweepResult {
  /** ACTIVE, lapsed rows this pass looked at. */
  considered: number;
  /** Rows this pass flipped `active` → `expired`. */
  retired: number;
  /**
   * Rows another caller retired between the list and this row's turn — a concurrent
   * sweep pass, or Task 2's lazy retirement on the purchase path. Never a failure:
   * `retireExpired`'s conditional UPDATE is the guard doing its job, the same shape as
   * `SweepOrphanMedia`'s "claimed since listed" skip.
   */
  skipped: number;
  /** Rows whose `retireExpired` call threw and were left ACTIVE for the next pass to retry. */
  failed: number;
}

export interface SweepExpiredMembershipsOptions {
  batchSize?: number;
  /** Defaults to the real clock. Overridden in tests to place the boundary precisely. */
  now?: () => Date;
  /**
   * Where a single row's `retireExpired` failure is reported. Defaults to
   * `console.error`, matching every other per-item failure this worker logs (e.g.
   * `SweepOrphanMedia`'s own `logError`) — injectable here only so a test can capture
   * the line without capturing the real console.
   */
  logError?: (line: string) => void;
}

/**
 * Memberships read per QUERY, not per pass — same reasoning and same figure as
 * `SweepOrphanMedia`'s `DEFAULT_ORPHAN_SWEEP_BATCH_SIZE`: it bounds one result set
 * while leaving any realistic backlog's page count uninteresting.
 */
const DEFAULT_MEMBERSHIP_SWEEP_BATCH_SIZE = 500;

/**
 * Task 3's retirement sweep: the hygiene half of Phase 5b's lifecycle. A member who
 * never returns must not sit `active` forever — that row holds
 * `user_subscription_one_active`'s slot for the (subscriber, owner) pair, and Task 2
 * already frees it the moment the member comes back to buy again. This pass is for the
 * member who does not come back: nothing else in the system will ever retire that row.
 *
 * ONE ROW'S FAILURE MUST NOT ABORT THE PASS — the exact property `SweepOrphanMedia`
 * exists to guarantee, and the reason this class is modelled on it rather than on
 * `ProcessChurn`/`ProcessRenewals` (which have no per-row try/catch at all, because
 * their own per-row work — an outbox enqueue, an activity-log write — is expected to
 * succeed once the status flip already has). `retireExpired` is a single UPDATE against
 * a live connection and CAN throw (the database briefly unreachable, a statement
 * timeout), and a naive loop over rows would die on the first such throw and skip every
 * lapsed membership after it — silently, and forever, since the next pass hits the very
 * same row first. So each row is retired in its own try/catch: a failure is counted,
 * logged, and the row is left ACTIVE for the next pass to retry, and the loop moves on.
 *
 * THE ARBITER IS `retireExpired` ITSELF, never a read here first. Task 1's own
 * conditional UPDATE (`status = 'active' AND current_period_end <= now`) is what makes
 * this loop's `skipped` count meaningful rather than a race window of its own: a `false`
 * return means the pair was retired by someone else between the list and this row's
 * turn, not that this pass read stale data and acted on it wrongly.
 */
export class SweepExpiredMemberships {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly logError: (line: string) => void;

  constructor(
    private readonly subscriptions: ExpiredMembershipRepository,
    options: SweepExpiredMembershipsOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_MEMBERSHIP_SWEEP_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
    this.logError = options.logError ?? ((line) => console.error(line));
  }

  async execute(): Promise<MembershipSweepResult> {
    // ONCE per pass, so every row is judged against the same instant — the same
    // reasoning `ProcessChurn.execute` gives for reading its clock once.
    const now = this.now();
    const result: MembershipSweepResult = { considered: 0, retired: 0, skipped: 0, failed: 0 };

    // PAGED. A retired OR skipped row leaves the result set — its status is no longer
    // `active` — so this terminates the same way `SweepOrphanMedia.execute` does,
    // including the same no-progress guard: without it, a page where every row FAILS
    // would be re-fetched, identically, forever.
    for (;;) {
      const page = await this.subscriptions.listExpiredActive(now, this.batchSize);
      if (page.length === 0) break;
      result.considered += page.length;

      const progressBefore = result.retired + result.skipped;
      for (const row of page) {
        await this.retireOne(row, now, result);
      }
      if (result.retired + result.skipped === progressBefore) break;
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One expired-active row. Never throws — a per-row failure lands on `result.failed`, not on the pass. */
  private async retireOne(
    row: { id: string; subscriberId: string; ownerId: string },
    now: Date,
    result: MembershipSweepResult
  ): Promise<void> {
    try {
      if (await this.subscriptions.retireExpired(row.subscriberId, row.ownerId, now)) {
        result.retired += 1;
        return;
      }
      // Raced away — see `MembershipSweepResult.skipped`'s own docstring.
      result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      this.logError(
        `[memberships] subscription=${row.id} was NOT retired and is left active for the ` +
          `next pass — retireExpired failed: ${redactLinks(safeErrorSummary(err))}`
      );
    }
  }
}

/** The membership sweep's summary line, or `null` when there is nothing to say. Counts only, as above. */
export function formatMembershipSweepLine(result: MembershipSweepResult): string | null {
  if (
    result.considered === 0 &&
    result.retired === 0 &&
    result.skipped === 0 &&
    result.failed === 0
  ) {
    return null;
  }
  return (
    `[memberships] considered=${result.considered} retired=${result.retired} ` +
    `skipped=${result.skipped} failed=${result.failed}`
  );
}

/**
 * Task 5 of Phase 5b (spec §7) — the pending-checkout cleanup: the gap 5a's final
 * review named as the phase's most likely real-world money loss, and one that needs
 * NO FAILURE AT ALL to reach. Nothing in 5a ever expires a `pending` subscription, so
 * an ordinary abandoned cart returned to later is handed back the same now-dead
 * invoice by `findPendingCheckout` — forever, since nothing clears the row. This pass
 * expires stale ones, which frees `user_subscription_one_pending`'s slot so the next
 * attempt mints a fresh invoice instead. It also closes two narrower gaps for free: a
 * crash between `claimPending` and the invoice reference being attached (5a's own
 * record), and the row `attachGatewayReference` failure leaves behind — both are just
 * pending rows that never got an invoice, indistinguishable by age from an ordinary
 * abandoned cart.
 *
 * `Repository` and `Result` are separate generic-free interfaces, structural like
 * `OrphanMediaRepository`: `DrizzleUserSubscriptionRepository` satisfies
 * `StalePendingCheckoutRepository` directly without being declared against it, and a
 * test can supply an in-memory double with no database at all.
 */
export interface StalePendingCheckoutRepository {
  listStalePending(cutoff: Date, limit: number): Promise<{ id: string }[]>;
  /**
   * Expires ONE stale pending row, answering whether it actually moved — see
   * `UserSubscriptionRepositoryPort.expireStalePending`'s own docstring for why
   * `status = 'pending'` alone is the whole arbiter.
   */
  expireStalePending(id: string): Promise<boolean>;
}

export interface StalePendingSweepResult {
  /** Stale pending rows this pass looked at. */
  considered: number;
  /** Rows this pass flipped `pending` → `expired`. */
  expired: number;
  /**
   * Rows that were no longer pending by the time this pass reached them — paid via
   * the webhook, cancelled, or already expired by a concurrent sweep — between being
   * listed and this row's turn. Never a failure: `expireStalePending`'s conditional
   * UPDATE is the guard doing its job, the same shape as `SweepExpiredMemberships`'s
   * own `skipped`.
   */
  skipped: number;
  /** Rows whose `expireStalePending` call threw and were left pending for the next pass to retry. */
  failed: number;
}

export interface SweepStalePendingCheckoutsOptions {
  windowMs?: number;
  batchSize?: number;
  /** Defaults to the real clock. Overridden in tests to place the window precisely. */
  now?: () => Date;
  /**
   * Where a single row's `expireStalePending` failure is reported. Defaults to
   * `console.error`, matching every other per-item failure this worker logs — see
   * `SweepExpiredMemberships`'s own `logError`.
   */
  logError?: (line: string) => void;
}

/**
 * Stale-pending rows read per QUERY, not per pass — same reasoning and same figure
 * as `DEFAULT_MEMBERSHIP_SWEEP_BATCH_SIZE`/`DEFAULT_ORPHAN_SWEEP_BATCH_SIZE`: it
 * bounds one result set while leaving any realistic backlog's page count
 * uninteresting.
 */
const DEFAULT_STALE_PENDING_SWEEP_BATCH_SIZE = 500;

/**
 * The pending-checkout cleanup window (Task 5, Phase 5b — spec §7): how long a
 * `pending` subscription is left alone before this pass expires it.
 *
 * BOUNDED ON BOTH SIDES, and both bounds are load-bearing in opposite directions.
 * TOO SHORT and a buyer sitting on Xendit's payment page — mid-checkout, having
 * pressed "Jadi anggota" and gone to pay — has their row expired out from under
 * them: `findActiveFor`/`findPendingCheckout` would then see nothing pending, a
 * second tap would mint a SECOND invoice for the same purchase, and a webhook that
 * later arrives for the first (now-expired) row's transaction would settle a
 * subscription this pass had already declared dead. TOO LONG and the gap this task
 * exists to close stays open: `findPendingCheckout` keeps handing back an invoice
 * Xendit has already killed, for as long as this window allows.
 *
 * TWO HOURS. `XenditPaymentAdapter.createInvoice` never sets `invoice_duration`
 * (see its own docstring's "UNVERIFIED AGAINST THE LIVE XENDIT API" warning), so
 * this relies on Xendit's documented default invoice lifetime of 24 hours — itself
 * unverified against a live account, like the rest of that adapter. Two hours
 * leaves a 12x margin against ever expiring a row whose invoice is still alive at
 * the provider, while comfortably covering "a person's checkout": a WhatsApp OTP, a
 * bank redirect, someone stepping away and coming back. The return visit this task
 * exists for — the spec's own example, "a day later" — is 12x past it.
 */
export const STALE_PENDING_CHECKOUT_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Task 5's stale-pending sweep: the other half of Phase 5b's pending-checkout
 * lifecycle, alongside Task 2's lazy claim-then-retire. Modelled on
 * `SweepExpiredMemberships` rather than on `ProcessRenewals`/`ProcessChurn`, for the
 * identical reason that class's own docstring gives: `expireStalePending` is a
 * single UPDATE against a live connection and CAN throw, and a naive loop over rows
 * would die on the first such throw and skip every stale row after it — silently,
 * and forever, since the next pass hits the very same row first. So each row is
 * expired in its own try/catch: a failure is counted, logged, and the row is left
 * pending for the next pass to retry, and the loop moves on.
 *
 * THE ARBITER IS `expireStalePending` ITSELF, never a read here first — same
 * reasoning as `SweepExpiredMemberships`'s own `retireExpired` call: a `false`
 * return means the row was no longer pending by this row's turn, not that this
 * pass read stale data and acted on it wrongly.
 */
export class SweepStalePendingCheckouts {
  private readonly windowMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly logError: (line: string) => void;

  constructor(
    private readonly subscriptions: StalePendingCheckoutRepository,
    options: SweepStalePendingCheckoutsOptions = {}
  ) {
    this.windowMs = options.windowMs ?? STALE_PENDING_CHECKOUT_WINDOW_MS;
    this.batchSize = options.batchSize ?? DEFAULT_STALE_PENDING_SWEEP_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
    this.logError = options.logError ?? ((line) => console.error(line));
  }

  async execute(): Promise<StalePendingSweepResult> {
    // ONCE per pass, so every row is judged against the same instant and the same
    // cutoff — same reasoning `SweepOrphanMedia.execute` and `SweepExpiredMemberships`
    // both give for reading the clock exactly once.
    const cutoff = new Date(this.now().getTime() - this.windowMs);
    const result: StalePendingSweepResult = { considered: 0, expired: 0, skipped: 0, failed: 0 };

    // PAGED, with the same no-progress guard `SweepExpiredMemberships`/`SweepOrphanMedia`
    // both carry: an expired OR skipped row leaves the result set (it is no longer
    // `pending`), so without the guard a page where every row FAILS would be
    // re-fetched, identically, forever.
    for (;;) {
      const page = await this.subscriptions.listStalePending(cutoff, this.batchSize);
      if (page.length === 0) break;
      result.considered += page.length;

      const progressBefore = result.expired + result.skipped;
      for (const row of page) {
        await this.expireOne(row.id, result);
      }
      if (result.expired + result.skipped === progressBefore) break;
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One stale-pending row. Never throws — a per-row failure lands on `result.failed`, not on the pass. */
  private async expireOne(id: string, result: StalePendingSweepResult): Promise<void> {
    try {
      if (await this.subscriptions.expireStalePending(id)) {
        result.expired += 1;
        return;
      }
      // No longer pending — see `StalePendingSweepResult.skipped`'s own docstring.
      result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      this.logError(
        `[pending-checkouts] subscription=${id} was NOT expired and is left pending for ` +
          `the next pass — expireStalePending failed: ${redactLinks(safeErrorSummary(err))}`
      );
    }
  }
}

/** The stale-pending sweep's summary line, or `null` when there is nothing to say. Counts only, as above. */
export function formatStalePendingSweepLine(result: StalePendingSweepResult): string | null {
  if (
    result.considered === 0 &&
    result.expired === 0 &&
    result.skipped === 0 &&
    result.failed === 0
  ) {
    return null;
  }
  return (
    `[pending-checkouts] considered=${result.considered} expired=${result.expired} ` +
    `skipped=${result.skipped} failed=${result.failed}`
  );
}

/**
 * The reminder pass's summary line, or `null` when there is nothing to say. Counts
 * only, as above — the rows this pass walks carry a member's EMAIL and WhatsApp
 * number, and neither may ever appear in a log line.
 *
 * `skipped` is here and is the count that matters most: it is the number of members
 * this pass deliberately did not tell, because no channel could reach them. A pass
 * with `considered>0` and `reminded=0` is a pass that reached nobody, and it is
 * exactly what "the member was never told" looks like from outside — so this line
 * speaks whenever the pass did anything at all, and stays silent only on a genuinely
 * empty window.
 */
export function formatMembershipReminderLine(
  result: RemindExpiringMembershipResult
): string | null {
  if (
    result.considered === 0 &&
    result.reminded === 0 &&
    result.alreadyReminded === 0 &&
    result.skipped === 0 &&
    result.failed === 0
  ) {
    return null;
  }
  return (
    `[membership-reminders] considered=${result.considered} reminded=${result.reminded} ` +
    `already_reminded=${result.alreadyReminded} skipped=${result.skipped} ` +
    `failed=${result.failed}`
  );
}

/** The orphan sweep's summary line, or `null` when there is nothing to say. Counts only, as above. */
export function formatOrphanSweepLine(result: OrphanSweepResult): string | null {
  if (
    result.considered === 0 &&
    result.deleted === 0 &&
    result.skipped === 0 &&
    result.failed === 0
  ) {
    return null;
  }
  return (
    `[media] considered=${result.considered} deleted=${result.deleted} ` +
    `skipped=${result.skipped} failed=${result.failed}`
  );
}

/**
 * Just enough of `ProcessRenewals` / `ProcessChurn` to be scheduled. Structural, so a
 * test can supply a pass that throws on demand without a database.
 */
export interface RenewalPass {
  execute(): Promise<ProcessRenewalsResult>;
}
export interface ChurnPass {
  execute(): Promise<ProcessChurnResult>;
}
/** Same shape, for `SweepOrphanMedia` — or any test double with a matching `execute()`. */
export interface OrphanSweepPass {
  execute(): Promise<OrphanSweepResult>;
}
/** Same shape, for `SweepExpiredMemberships` — or any test double with a matching `execute()`. */
export interface MembershipSweepPass {
  execute(): Promise<MembershipSweepResult>;
}
/** Same shape, for `RemindExpiringMembership` — or any test double with a matching `execute()`. */
export interface MembershipReminderPass {
  execute(): Promise<RemindExpiringMembershipResult>;
}
/** Same shape, for `SweepStalePendingCheckouts` — or any test double with a matching `execute()`. */
export interface StalePendingSweepPass {
  execute(): Promise<StalePendingSweepResult>;
}

export interface ScheduledPassLoopsOptions {
  processRenewals: RenewalPass;
  processChurn: ChurnPass;
  processOrphanSweep: OrphanSweepPass;
  processMembershipSweep: MembershipSweepPass;
  processMembershipReminder: MembershipReminderPass;
  processStalePendingSweep: StalePendingSweepPass;
  intervalMs: number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * The renewal, churn, orphan-sweep, membership-retirement, membership-reminder AND
 * stale-pending-checkout passes as six `PollLoop`s — the SAME loop the outbox uses,
 * so they inherit both of its properties for free: passes of one type never overlap
 * (each pass pages through the whole backlog, and a second copy of itself would be
 * reading the same rows), and `stop()` wakes the loop immediately instead of
 * sleeping out an interval, which is what makes an hour-long interval survivable
 * under SIGTERM.
 *
 * SIX LOOPS, not one pass that does everything, for one reason: a renewal pass that
 * throws every time — a query the schema no longer matches, say — must not also stop
 * churn, the orphan sweep, the membership sweep, the reminders, or the pending-checkout
 * cleanup from running, and vice versa. That last pairing is the one that matters most
 * in Phase 5b: the sweep frees a lapsed member to buy again and the reminder is what
 * tells them to, so a shared failure would silently disable renewal in both directions
 * at once. Each loop's `onError` is its own, so a failing pass costs its own retries
 * and nothing else's. All six share an interval because they share a cadence — none
 * of them is latency-sensitive the way the outbox's 5-second poll is, INCLUDING the
 * pending-checkout cleanup: its own window (`STALE_PENDING_CHECKOUT_WINDOW_MS`, two
 * hours) is what actually protects a live checkout, not this cadence — and they never
 * share a failure. The membership sweep is Task 3's hygiene pass (spec — Phase 5b): a
 * member who never returns must not sit `active` forever, but nothing about noticing
 * that is urgent, so it shares the renewal/churn/media cadence rather than inventing a
 * fifth interval knob nobody would ever have reason to set differently — see
 * `apps/worker/src/main.ts`'s own docstring for the same reasoning about the media
 * sweep, and Task 5's pending-checkout cleanup shares it for the identical reason.
 *
 * Per-row failures never reach this level at all: `SweepOrphanMedia`,
 * `SweepExpiredMemberships`, `RemindExpiringMembership` and `SweepStalePendingCheckouts`
 * each catch them internally (see their own docstrings), so `onError` here only fires
 * on something the pass-level query itself could not survive, same as renewals/churn.
 *
 * No loop is started here. The caller runs them alongside the outbox loop and decides
 * when they stop.
 */
export function createScheduledPassLoops(options: ScheduledPassLoopsOptions): {
  renewalLoop: PollLoop;
  churnLoop: PollLoop;
  orphanSweepLoop: PollLoop;
  membershipSweepLoop: PollLoop;
  membershipReminderLoop: PollLoop;
  stalePendingSweepLoop: PollLoop;
} {
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));

  const renewalLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatRenewalPassLine(await options.processRenewals.execute());
      if (line !== null) log(line);
    },
    // A failed PASS is not a failed subscription: whatever this pass did not claim is
    // still in the database, unclaimed, and the next pass is its retry. Never
    // rethrown — an unhandled rejection here would take the whole process down,
    // including the outbox loop that delivers what payments have already bought.
    onError: (err) => logError(formatPassFailure("renewals", err)),
  });

  const churnLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatChurnPassLine(await options.processChurn.execute());
      if (line !== null) log(line);
    },
    onError: (err) => logError(formatPassFailure("churn", err)),
  });

  const orphanSweepLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatOrphanSweepLine(await options.processOrphanSweep.execute());
      if (line !== null) log(line);
    },
    onError: (err) => logError(formatPassFailure("media", err)),
  });

  const membershipSweepLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatMembershipSweepLine(await options.processMembershipSweep.execute());
      if (line !== null) log(line);
    },
    onError: (err) => logError(formatPassFailure("memberships", err)),
  });

  const membershipReminderLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatMembershipReminderLine(
        await options.processMembershipReminder.execute()
      );
      if (line !== null) log(line);
    },
    onError: (err) => logError(formatPassFailure("membership-reminders", err)),
  });

  const stalePendingSweepLoop = new PollLoop({
    intervalMs: options.intervalMs,
    poll: async () => {
      const line = formatStalePendingSweepLine(await options.processStalePendingSweep.execute());
      if (line !== null) log(line);
    },
    onError: (err) => logError(formatPassFailure("pending-checkouts", err)),
  });

  return {
    renewalLoop,
    churnLoop,
    orphanSweepLoop,
    membershipSweepLoop,
    membershipReminderLoop,
    stalePendingSweepLoop,
  };
}
