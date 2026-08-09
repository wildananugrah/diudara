import { and, eq, lt, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { outbox } from "../../db/schema";
import type {
  ClaimedOutboxRow,
  OutboxRepositoryPort,
} from "../../application/ports/outbox-repository.port";

/** `outbox.last_error` is varchar(500). */
const MAX_ERROR_LENGTH = 500;

export class DrizzleOutboxRepository implements OutboxRepositoryPort {
  /**
   * `DatabaseExecutor`, so the SAME class works against the pool (the worker) and
   * against an open transaction handle (the payment activation unit of work).
   * Nothing in here can tell which it has, which is what lets `enqueue` join the
   * activation transaction without any signature growing a "pass the handle in"
   * parameter.
   */
  constructor(private readonly db: DatabaseExecutor) {}

  async enqueue(input: { eventType: string; payload: unknown }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(outbox)
      .values({ eventType: input.eventType, payload: input.payload })
      .returning({ id: outbox.id });
    return { id: row.id };
  }

  /**
   * Claims up to `limit` due rows in ONE statement.
   *
   * The shape is load-bearing. A `SELECT` followed by an `UPDATE` would hand the
   * same row to two workers whenever their reads interleave, and each
   * `grant_access` row is one invite link — a double claim means two links for one
   * paying member. Here `FOR UPDATE SKIP LOCKED` locks the candidate rows and
   * makes a concurrent claimer skip them rather than block, and the surrounding
   * `UPDATE ... RETURNING` moves them out of `pending` before anyone sees them, so
   * the database — not a pre-check — arbitrates.
   *
   * WHY A MATERIALIZED CTE, and not `WHERE id IN (SELECT ... LIMIT n FOR UPDATE
   * SKIP LOCKED)`: the sublink form was written first and INTERMITTENTLY claimed
   * MORE rows than its limit — measured, in a full-suite run, as 3 rows returned
   * for `claimBatch(2)`. A sublink's `LIMIT` is only evaluated once if the planner
   * says so, and an `UPDATE` re-checks its qualification (re-executing the
   * sublink) for any row a concurrent transaction has touched. `AS MATERIALIZED`
   * removes the planner's discretion: the CTE runs exactly once, so the batch
   * bound holds whatever the plan and whoever else is writing. It is also the
   * canonical Postgres queue-claim shape.
   *
   * A batch bound that only usually holds would put the WORKER over its own
   * concurrency limit and, worse, would make the claim's guarantees plan-dependent
   * — exactly the kind of thing that passes 20 test runs and fails in production.
   *
   * `id` is in the ORDER BY so the ordering is total: rows enqueued in the same
   * millisecond otherwise tie, and which of them a bounded batch takes would be
   * arbitrary from one call to the next.
   *
   * `attempts` is incremented at CLAIM time, not at failure time: a worker that
   * dies mid-send never gets to report anything, and a counter that only advanced
   * on a clean failure would let such a row be retried forever.
   *
   * PINNED DETERMINISTICALLY, and not by the racing test. Two tests in
   * drizzle-outbox.repository.test.ts guard this shape without depending on the
   * scheduler: one asserts the SQL that reaches the driver (one statement, `as
   * materialized`, `for update skip locked`, no bare SELECT of the table), the
   * other forces the interleaving by holding a claimed row's lock in an open
   * transaction and requiring the next claim to step over it rather than block.
   * Measured against a select-then-update rewrite: both fail 6/6 runs, while the
   * racing test PASSED 3/3 — which is exactly why the racing test is a smoke
   * check and these two are the guard.
   */
  async claimBatch(limit: number): Promise<ClaimedOutboxRow[]> {
    const claimed = await this.db.execute<{
      id: string;
      event_type: string;
      payload: unknown;
      attempts: number;
    }>(sql`
      with due as materialized (
        select ${outbox.id}
          from ${outbox}
         where ${outbox.status} = 'pending'
           and ${outbox.nextAttemptAt} <= now()
         order by ${outbox.nextAttemptAt}, ${outbox.id}
         limit ${limit}
           for update skip locked
      )
      update ${outbox}
         set status = 'processing',
             attempts = ${outbox.attempts} + 1,
             updated_at = now()
       where ${outbox.id} in (select id from due)
      returning ${outbox.id}, ${outbox.eventType}, ${outbox.payload}, ${outbox.attempts}
    `);

    return Array.from(claimed).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async markSent(id: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(outbox.id, id));
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .update(outbox)
      .set({
        // Back to `pending`, which is what makes it due again at nextAttemptAt.
        status: "pending",
        nextAttemptAt,
        lastError: truncate(error),
        updatedAt: new Date(),
      })
      .where(eq(outbox.id, id));
  }

  async markPermanentlyFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ status: "failed", lastError: truncate(error), updatedAt: new Date() })
      .where(eq(outbox.id, id));
  }

  /**
   * The counterpart to claiming at all: see the port docstring for why a row can
   * be stranded in `processing` with nothing to move it.
   *
   * `updated_at` is the staleness clock, and `claimBatch` sets it to `now()` on
   * every claim, so "processing and not touched for N minutes" means "the worker
   * that took this is gone". One conditional UPDATE, so two workers reclaiming at
   * the same moment cannot both take a row: the second re-checks
   * `status = 'processing'` and finds nothing.
   *
   * `attempts` is deliberately untouched (port docstring), and `next_attempt_at`
   * is left alone too — it was already due when the row was claimed, so the row
   * becomes claimable the instant it is `pending` again.
   */
  async reclaimStaleProcessing(stuckBefore: Date): Promise<number> {
    const reclaimed = await this.db
      .update(outbox)
      .set({ status: "pending", lastError: RECLAIM_NOTE, updatedAt: new Date() })
      .where(and(eq(outbox.status, "processing"), lt(outbox.updatedAt, stuckBefore)))
      .returning({ id: outbox.id });
    return reclaimed.length;
  }
}

/**
 * Written to `last_error` by a reclaim. It replaces whatever diagnostic was
 * there because the row's CURRENT state is what an operator needs: a row back in
 * `pending` after its worker vanished is a different situation from one that
 * failed cleanly, and a crash leaves no error message of its own.
 */
const RECLAIM_NOTE =
  "reclaimed: this row was left in 'processing' by a worker that never reported back " +
  "(crash, OOM or a lost box), and has been returned to 'pending' for another attempt";

/**
 * Provider errors and stack-carrying messages routinely exceed 500 characters.
 * Letting the driver reject the UPDATE would lose the retry bookkeeping for a row
 * that has ALREADY failed once — the worst possible moment to add a second
 * failure — so the diagnostic is trimmed instead.
 */
function truncate(error: string): string {
  return error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) : error;
}
