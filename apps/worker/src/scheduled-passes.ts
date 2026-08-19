/**
 * Phase 5's two CLOCK-driven passes, plus Task 10's orphan-media sweep, as loops this
 * process can run.
 *
 * Everything in `apps/worker` before this file was request-triggered at one remove:
 * a payment wrote an outbox row and the worker delivered it. These three are triggered
 * by nothing but the passage of time, which is why they need a schedule at all — and
 * why this module exists separately from `main.ts`: the composition root cannot be
 * imported by a test (it reaches `db/client.ts`), and "a throwing pass does not take
 * the process down" is exactly the property that must be pinned by one.
 *
 * It deliberately imports only the API's dependency-free `log-safety` helper at
 * runtime; the renewal/churn result shapes come in as TYPES, which erase.
 * `SweepOrphanMedia` is the one exception to "the pass lives in `apps/api`" — it has no
 * domain logic to speak of (no WIB days, no grace periods, just a cutoff and a
 * try/catch), so unlike `ProcessRenewals`/`ProcessChurn` it is defined and tested
 * entirely IN this file, against `MediaRepositoryPort`/`MediaStoragePort`-shaped
 * structural interfaces the caller supplies — never against a database.
 */
import { redactLinks, safeErrorSummary } from "../../api/src/application/log-safety";
import type { ProcessChurnResult } from "../../api/src/application/use-cases/process-churn";
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
 * value, which is why all three loops share it.
 *
 * `safeErrorSummary` walks the cause chain and drops a failed statement's bound
 * parameters — Phase 4 found drizzle's `params:` list, which is a member's phone
 * number, in this exact log, and this process's `onError` was still printing
 * `err.message` raw — and `redactLinks` removes anything URL-shaped, because a provider
 * error can interpolate an invite link into its own message and that is a bearer
 * credential. `pass` is one of our own literals, so it needs no sanitising.
 */
export function formatPassFailure(
  pass: "outbox" | "renewals" | "churn" | "media",
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
  deleteById(id: string): Promise<void>;
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
    const result: OrphanSweepResult = { considered: 0, deleted: 0, failed: 0 };

    // PAGED. A swept row leaves the result set (it is deleted), so this terminates the
    // same way `ProcessChurn`'s walk does — except a FAILED row does NOT leave the set,
    // which is exactly why the no-progress guard below exists: without it, a page where
    // every row fails would be re-fetched, identically, forever.
    for (;;) {
      const page = await this.media.listUnclaimedBefore(cutoff, this.batchSize);
      if (page.length === 0) break;
      result.considered += page.length;

      const deletedBefore = result.deleted;
      for (const row of page) {
        await this.sweepOne(row.id, result);
      }
      if (result.deleted === deletedBefore) break;
      if (page.length < this.batchSize) break;
    }

    return result;
  }

  /** One orphan row. Never throws — a per-row failure lands on `result.failed`, not on the pass. */
  private async sweepOne(id: string, result: OrphanSweepResult): Promise<void> {
    try {
      // OBJECTS BEFORE THE ROW — see the class docstring for why the reverse order
      // leaks bytes permanently and this one does not.
      await this.storage.remove(id);
      await this.media.deleteById(id);
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      this.logError(
        `[media] media=${id} was NOT swept and is left in place for the next pass — ` +
          `storage removal failed: ${redactLinks(safeErrorSummary(err))}`
      );
    }
  }
}

/** The orphan sweep's summary line, or `null` when there is nothing to say. Counts only, as above. */
export function formatOrphanSweepLine(result: OrphanSweepResult): string | null {
  if (result.considered === 0 && result.deleted === 0 && result.failed === 0) {
    return null;
  }
  return `[media] considered=${result.considered} deleted=${result.deleted} failed=${result.failed}`;
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

export interface ScheduledPassLoopsOptions {
  processRenewals: RenewalPass;
  processChurn: ChurnPass;
  processOrphanSweep: OrphanSweepPass;
  intervalMs: number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * The renewal, churn AND orphan-sweep passes as three `PollLoop`s — the SAME loop the
 * outbox uses, so they inherit both of its properties for free: passes of one type
 * never overlap (each pass pages through the whole backlog, and a second copy of
 * itself would be reading the same rows), and `stop()` wakes the loop immediately
 * instead of sleeping out an interval, which is what makes an hour-long interval
 * survivable under SIGTERM.
 *
 * THREE LOOPS, not one pass that does everything, for one reason: a renewal pass that
 * throws every time — a query the schema no longer matches, say — must not also stop
 * churn or the orphan sweep from running, and vice versa. Each loop's `onError` is its
 * own, so a failing pass costs its own retries and nothing else's. All three share an
 * interval because they share a cadence — none of them is latency-sensitive the way
 * the outbox's 5-second poll is — and they never share a failure.
 *
 * The orphan sweep's per-row failures never reach this level at all: `SweepOrphanMedia`
 * catches them itself (see its own docstring), so `onError` here only fires on
 * something the pass-level query itself could not survive, same as renewals/churn.
 *
 * No loop is started here. The caller runs them alongside the outbox loop and decides
 * when they stop.
 */
export function createScheduledPassLoops(options: ScheduledPassLoopsOptions): {
  renewalLoop: PollLoop;
  churnLoop: PollLoop;
  orphanSweepLoop: PollLoop;
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

  return { renewalLoop, churnLoop, orphanSweepLoop };
}
