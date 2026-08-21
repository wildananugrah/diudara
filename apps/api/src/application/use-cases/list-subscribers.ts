import type { ClockPort } from "../ports/clock.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";

/**
 * One subscriber on the wire — the same three fields
 * `UserSubscriptionRepositoryPort.SubscriberRow` carries, with `since`
 * ISO-stamped: JSON has no date type, and nothing on the client side needs
 * to parse it back into one (mirrors `ListCommunityMembers`'s own
 * `joinedAt` — a `Date` in the port, a `string` on the wire).
 */
export interface SubscriberListEntry {
  handle: string;
  displayName: string;
  since: string;
}

/**
 * Task 6 of Phase 5b (spec §8) — `GET /users/me/subscribers`, a creator's own
 * list of who currently subscribes to them.
 *
 * **OWNER-ONLY BY CONSTRUCTION, not by a check this class performs.**
 * `execute` takes exactly one id, and `routes/users.ts` passes it exactly
 * one value: `c.get("userId")`, the CALLER's own session. There is no handle
 * parameter anywhere on this route — unlike `GET /:handle/followers`, there
 * is no path by which a signed-in user can name someone else's id here. A
 * subscriber list is not public information (spec §8), and the absence of a
 * second argument is what makes that true rather than merely intended.
 *
 * **The projection is CLOSED.** See `SubscriberRow`'s own docstring on the
 * port for the full reasoning; this class only re-states it in the shape
 * that reaches the wire, and maps NOTHING beyond `handle`/`displayName`/
 * `since` — adding a field here without adding it to the repository
 * projection first is impossible, and adding it to both is the only way
 * this class could ever widen.
 *
 * **"Currently subscribed" mirrors `IsMemberOf`.** See
 * `UserSubscriptionRepositoryPort.listActiveSubscribers`'s own docstring for
 * why the two definitions are mirrored rather than shared, and why
 * `isMemberOf` itself is never touched by this task.
 */
export class ListSubscribers {
  constructor(
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(ownerId: string): Promise<{ subscribers: SubscriberListEntry[] }> {
    const rows = await this.subscriptions.listActiveSubscribers(ownerId, this.clock.now());
    return {
      subscribers: rows.map((row) => ({
        handle: row.handle,
        displayName: row.displayName,
        since: row.since.toISOString(),
      })),
    };
  }
}
