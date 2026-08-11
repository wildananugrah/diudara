import type { ActivityLogRepositoryPort } from "./activity-log-repository.port";
import type { EventRepositoryPort } from "./event-repository.port";
import type { OutboxRepositoryPort } from "./outbox-repository.port";
import type { SubscriptionRepositoryPort } from "./subscription-repository.port";

/** The repositories that must succeed or fail together when a lifecycle hook fires. */
export interface StreamLifecycleRepositories {
  events: EventRepositoryPort;
  subscriptions: SubscriptionRepositoryPort;
  activityLog: ActivityLogRepositoryPort;
  /**
   * The intent to notify. It belongs in HERE, and not in a write that follows the
   * transition afterwards, for the identical reason `PaymentActivationRepositories.outbox`
   * does — see that port's docstring. `markLive`'s status predicate makes an event's
   * transition to `live` a thing that can happen AT MOST ONCE (a second `online` finds
   * the predicate already false and changes nothing), so the moment that UPDATE commits
   * on its own, the one opportunity to queue `notify_stream_live` for this go-live is
   * spent forever — no later `online` will ever re-open it, because the transition is
   * exactly the thing a repeat is designed not to repeat. A crash, a dropped connection,
   * or a thrown error between the UPDATE and the enqueue would otherwise leave the event
   * permanently `live` with no notify row and nothing anywhere able to create one.
   *
   * The SEND is emphatically not in here (plan, Global Constraints): it is an external
   * HTTP call, and a provider outage inside this transaction would roll back a
   * transition that has already, correctly, happened. The worker sends, outside any
   * transaction, from the rows this writes.
   */
  outbox: OutboxRepositoryPort;
}

/**
 * Runs a MediaMTX lifecycle hook's writes — the status transition, its audit entry, and
 * one `notify_stream_live` row per member entitled to hear about it — as ONE atomic unit.
 *
 * Mirrors `PaymentActivationUnitOfWorkPort` exactly, and exists for the same class of
 * reason: `markLive`/`markEnded`'s atomic status predicate makes the TRANSITION itself
 * idempotent (a second `online` changes nothing), but that guarantee is worthless if the
 * WRITES THAT FOLLOW IT can be lost. Once `status='live'` commits on a bare `UPDATE`, no
 * later hook — online or offline — will ever cause it to happen again, so anything that
 * was supposed to happen alongside it (the audit row, the notify rows) has exactly one
 * chance, at the same instant.
 *
 * The work function receives repositories already bound to the transaction, so no port
 * method grows a "pass the handle in" parameter and no repository has to know whether it
 * is inside one.
 *
 * Anything thrown out of `work` must roll the whole unit back and propagate — MediaMTX's
 * webhook route lets it become a 500, unlike the "always 200 once the secret checks out"
 * rule that applies to a hook the handler decided NOT to act on (see
 * `HandleStreamLifecycle`'s own docstring for why those are different failure modes).
 */
export interface StreamLifecycleUnitOfWorkPort {
  run<T>(work: (repositories: StreamLifecycleRepositories) => Promise<T>): Promise<T>;
}
