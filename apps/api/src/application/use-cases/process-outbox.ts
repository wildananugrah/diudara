import { redactLinks, safeErrorSummary, safeLabel } from "../log-safety";
import type { OutboxRepositoryPort } from "../ports/outbox-repository.port";

/**
 * What a handler receives is the row's `payload` verbatim — `unknown`, because it
 * came back out of a jsonb column and nothing has checked it yet. Each handler
 * validates its own shape and throws if it cannot, which the retry policy below
 * then bounds.
 */
export type OutboxHandler = (payload: unknown) => Promise<void>;

export interface ProcessOutboxConfig {
  /** Rows per pass. */
  batchSize?: number;
  /** Total attempts, INCLUDING the first, before a row is terminally failed. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt up to MAX_BACKOFF_MS. */
  baseBackoffMs?: number;
  /** How long a `processing` row may sit untouched before it is reclaimed. */
  staleProcessingMs?: number;
}

export interface ProcessOutboxResult {
  reclaimed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 10;

/**
 * Five attempts with the backoff below spans roughly a quarter of an hour, which
 * covers a provider blip without keeping a member waiting for an invite they paid
 * for. Past it the row is terminal, with `last_error` for an operator: a
 * permanently failing row must never retry forever (plan, Global Constraints).
 */
const DEFAULT_MAX_ATTEMPTS = 5;

const DEFAULT_BASE_BACKOFF_MS = 30_000;

/** No retry is ever more than 15 minutes away. */
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * A worker that dies mid-send leaves its row `processing`, and only a reclaim can
 * move it. Five minutes is comfortably longer than any single send (both adapters
 * time out at 15 seconds) and short enough that a paying member's invite is not
 * lost for the afternoon.
 */
const DEFAULT_STALE_PROCESSING_MS = 5 * 60_000;

/**
 * Claims outbox rows and dispatches them, outside any transaction.
 *
 * The retry policy is the whole point of the class, and each rule is pinned by a
 * test:
 *
 *   - `attempts` is counted at CLAIM time by the repository, so a worker that
 *     dies without reporting anything still spends an attempt.
 *   - A failure below the bound goes back to `pending` with an exponential
 *     backoff; at the bound it becomes `failed` and is never claimed again.
 *   - An unknown event type is a normal failure, not an instant kill: during a
 *     rolling deploy an older worker can see a row a newer API enqueued.
 *   - NOTHING that reaches a log line or `last_error` may contain an invite link
 *     — see `redactLinks`.
 */
export class ProcessOutbox {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly staleProcessingMs: number;

  constructor(
    private readonly outbox: OutboxRepositoryPort,
    private readonly handlers: ReadonlyMap<string, OutboxHandler>,
    config: ProcessOutboxConfig = {}
  ) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseBackoffMs = config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.staleProcessingMs = config.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
  }

  async execute(): Promise<ProcessOutboxResult> {
    // Before claiming, not after: a row stranded by a dead worker is invisible to
    // `claimBatch`, so nothing else would ever bring it back.
    const reclaimed = await this.outbox.reclaimStaleProcessing(
      new Date(Date.now() - this.staleProcessingMs)
    );
    if (reclaimed > 0) {
      console.warn(
        `[outbox] reclaimed ${reclaimed} row(s) left in 'processing' by a worker that never ` +
          "reported back; they are pending again"
      );
    }

    const rows = await this.outbox.claimBatch(this.batchSize);
    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const handler = this.handlers.get(row.eventType);
        if (!handler) {
          throw new Error(
            `no handler is registered for outbox event type "${safeLabel(row.eventType)}"`
          );
        }
        await handler(row.payload);
        await this.outbox.markSent(row.id);
        sent += 1;
      } catch (err) {
        // Summarised and redacted BEFORE it is stored or printed, once, here — so
        // no call site can forget. `safeErrorSummary` is what keeps a driver
        // error's bound parameters out of both, and `redactLinks` covers the
        // separate case of a provider that interpolated a link into its own
        // message.
        const reason = redactLinks(safeErrorSummary(err));

        if (row.attempts >= this.maxAttempts) {
          const message = `giving up after ${row.attempts} attempts: ${reason}`;
          await this.outbox.markPermanentlyFailed(row.id, message);
          console.error(
            `[outbox] row=${row.id} event=${safeLabel(row.eventType)} PERMANENTLY FAILED — ` +
              message
          );
          failed += 1;
          continue;
        }

        const nextAttemptAt = new Date(Date.now() + this.backoffMs(row.attempts));
        await this.outbox.markFailed(row.id, reason, nextAttemptAt);
        console.warn(
          `[outbox] row=${row.id} event=${safeLabel(row.eventType)} attempt ${row.attempts}/` +
            `${this.maxAttempts} failed, retrying after ${nextAttemptAt.toISOString()} — ${reason}`
        );
        retried += 1;
      }
    }

    return { reclaimed, claimed: rows.length, sent, retried, failed };
  }

  /** `base * 2^(attempts-1)`, capped. `attempts` is 1 on the first failure. */
  private backoffMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(this.baseBackoffMs * 2 ** exponent, MAX_BACKOFF_MS);
  }
}

// Every diagnostic here goes through `safeErrorSummary` in `log-safety.ts`, which
// is where the reasoning lives. What USED to be here was `err.message` verbatim,
// with a comment claiming it carried "no object dump" — it did not hold: drizzle
// puts the failed statement AND its bound parameters into the message itself, so a
// real query failure printed both into the worker's log and into
// `outbox.last_error`, and buried the actual reason on `.cause`.
