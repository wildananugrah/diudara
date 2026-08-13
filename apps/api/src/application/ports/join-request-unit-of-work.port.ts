import type { ActivityLogRepositoryPort } from "./activity-log-repository.port";
import type { JoinRequestRepositoryPort } from "./join-request-repository.port";
import type { OutboxRepositoryPort } from "./outbox-repository.port";

/** The repositories a join request's creation and its notification must share. */
export interface JoinRequestRepositories {
  joinRequests: JoinRequestRepositoryPort;
  /**
   * The intent to notify the owner. It belongs in HERE, not a second transaction
   * afterwards, for the same reason `PaymentActivationRepositories.outbox` does:
   * a request with no queued notification has no recovery path — the row
   * already exists, so nothing would ever re-trigger the enqueue, and the owner
   * would never learn a member is waiting.
   */
  outbox: OutboxRepositoryPort;
  /**
   * Not written by `RequestToJoin` itself (the request is not yet a decision —
   * there is nothing to audit until the owner approves or rejects it), but
   * bound to the same transaction as `joinRequests` and `outbox` for Task 4's
   * approve/reject flow, which reuses this port and DOES write an entry the
   * instant a request is decided.
   */
  activityLog: ActivityLogRepositoryPort;
}

/**
 * Runs the writes a join request triggers — create the row, queue the owner's
 * notification — as ONE atomic unit, modelled on `PaymentActivationUnitOfWorkPort`.
 *
 * This exists because of the same failure that port exists to prevent, arriving
 * by a different route. `joinRequests.createPending` and `outbox.enqueue` for
 * `OUTBOX_NOTIFY_JOIN_REQUEST` must commit together or not at all: a request row
 * that exists with no notification queued strands the owner's only route to
 * learning about it (the dashboard list is the fallback for an undeliverable
 * WhatsApp, not the primary channel — see that constant's docstring), and a
 * notification queued for a request that was refused by the unique index (i.e.
 * `createPending` returned `null`) would tell an owner about a request that was
 * never created and that they can never find.
 *
 * The work function receives repositories already bound to the transaction, so
 * no port method grows a "pass the handle in" parameter and no repository has
 * to know whether it is inside a transaction.
 *
 * Anything thrown out of `work` must roll the whole unit back and propagate.
 */
export interface JoinRequestUnitOfWorkPort {
  run<T>(work: (repositories: JoinRequestRepositories) => Promise<T>): Promise<T>;
}
