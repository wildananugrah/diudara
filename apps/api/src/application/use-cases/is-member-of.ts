import type { ClockPort } from "../ports/clock.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";

/**
 * Task 8 of Phase 5a — the one question Phase 6's paywall asks on every
 * gated post: is `viewerId` a paying member of `ownerId`. Spec §8.
 *
 * TRUE only when there is a subscription with `status = 'active'` AND
 * `current_period_end > now()`. Both halves matter, and the second is the
 * one that is easy to drop by accident.
 *
 * §9's honest limitation: 5a has no renewal pass, so nothing ever moves a
 * subscription out of `active` when its period ends — a row can sit at
 * `status = 'active'` with a `current_period_end` long in the past. Checking
 * status alone would read that row as a member FOREVER. The
 * `current_period_end` comparison below is what keeps that honest until 5b
 * ships renewals; it is not a defensive extra, it is the point of this
 * class.
 *
 * The lookup itself is `DrizzleUserSubscriptionRepository.findActiveFor`,
 * ONE query against `user_subscription_one_active` — the partial unique
 * index on `(subscriber_id, owner_id) WHERE status = 'active'` (Task 2) —
 * rather than a join through the tier. See that index's own docstring on
 * `ownerId` in `db/schema.ts` for why: Phase 6 calls this per post on a
 * feed, and a sequential scan here is a performance defect that only shows
 * up under load, on the most valuable pages.
 *
 * `clock` is injected, never `Date.now()` read inline — the same rule every
 * other time-sensitive use-case in this codebase follows (see
 * `ClockPort`'s own docstring): a use-case that reads the wall clock itself
 * cannot be tested at the boundary that decides its answer, and the
 * boundary — the instant `current_period_end` passes — is exactly what
 * this class exists to get right.
 */
export class IsMemberOf {
  constructor(
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(viewerId: string, ownerId: string): Promise<boolean> {
    // Nobody is a "member" of themselves — mirrors the database's own
    // `user_subscription_no_self` check constraint, which makes such a row
    // impossible to create in the first place.
    if (viewerId === ownerId) {
      return false;
    }

    const active = await this.subscriptions.findActiveFor(viewerId, ownerId);
    if (!active || active.currentPeriodEnd === null) {
      return false;
    }

    return active.currentPeriodEnd.getTime() > this.clock.now().getTime();
  }
}
