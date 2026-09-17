import type { DomainEvent } from "../../domain/events.ts";
import type { EventBus } from "../../domain/ports.ts";

type Handler = (event: DomainEvent) => Promise<void>;

/**
 * The whole bus: a list of handlers, called in order, inside the request that
 * emitted the event. No broker, no queue, no dependency — a "bus" here is a
 * seam, not a technology (design spec 2026-09-17).
 *
 * DELIVERY GUARANTEES: none. `emit` never rejects and never retries. A handler
 * that throws is logged and skipped, because the action that emitted the event
 * has already succeeded and must not be reported as failed on account of a
 * notification. The cost is that a notification can be silently missing.
 *
 * That trade is right for an in-app bell and wrong for anything a user is owed —
 * an email receipt belongs behind a job queue (pgboss over the Postgres already
 * running), and that is the day this class gets replaced rather than extended.
 *
 * Handlers are awaited rather than fired and forgotten: an unawaited promise that
 * rejects after the response is sent is an unhandled rejection with nobody left
 * to report it to. One indexed insert is worth the milliseconds.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers: Handler[] = [];

  subscribe(handler: Handler): void {
    this.handlers.push(handler);
  }

  /** For the container test that catches "nobody ever subscribed". */
  get subscriberCount(): number {
    return this.handlers.length;
  }

  async emit(event: DomainEvent): Promise<void> {
    for (const handle of this.handlers) {
      try {
        await handle(event);
      } catch (err) {
        console.error(`[events] subscriber failed for ${event.type}:`, err);
      }
    }
  }
}
