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
        // Redacted BEFORE it is stored or printed, once, here — so no call site
        // can forget.
        const reason = redactLinks(describeError(err));

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

/**
 * Removes anything URL-shaped from a diagnostic.
 *
 * An invite link is a bearer credential and belongs only in the WhatsApp message
 * to the member who bought it (plan, Global Constraints) — never in
 * `outbox.last_error`, which an operator reads out of the database, and never in
 * a log line, which ends up in a log aggregator. Phase 2 leaked argon2id hashes
 * exactly this way.
 *
 * URLs in general, not just `t.me` links: the Telegram bot token is part of every
 * Bot API request PATH, so a URL from that adapter is a second credential. The
 * text around the URL is kept, so the error stays diagnosable.
 */
export function redactLinks(message: string): string {
  return message.replace(/\b(?:https?|tg|wa):\/\/\S+/gi, "[link redacted]");
}

/**
 * The message of whatever was thrown, with no stack and no object dump: a driver
 * error carries the failed statement's bound parameters, and an adapter error can
 * carry a response body.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return `non-Error thrown: ${typeof err}`;
}

/**
 * Renders a value safe to put in a log line. Same rule, and the same reason, as
 * `safeLabel` in handle-payment-webhook.ts: a newline inside an event type would
 * forge a second log line, and these lines are what an operator reads when
 * invites are not arriving.
 */
function safeLabel(value: string): string {
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "?");
}
