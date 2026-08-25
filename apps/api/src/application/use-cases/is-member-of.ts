import type { ClockPort } from "../ports/clock.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";

/**
 * Where a viewer stands with one creator — the THREE answers 5a can actually
 * give, rather than the two a boolean can hold.
 *
 *  - `member` — a subscription that is `active` AND still inside its paid
 *    period. The only value that grants access.
 *  - `lapsed` — a subscription row exists and BLOCKS a fresh purchase
 *    (`findActiveFor` is status-only), but it is no longer granting anything.
 *  - `none` — nothing here at all; the offer is genuinely buyable.
 *
 * **`lapsed` is not a nicety, it is the state §9 guarantees every paying
 * member reaches.** 5a has no renewal pass, so one billing cycle after ANY
 * purchase the row sits at `status = 'active'` with a `current_period_end` in
 * the past — forever. Two use-cases then answer "is this person a member"
 * differently, by design: `IsMemberOf` says no (period-aware) and
 * `StartUserSubscription`'s refusal says yes (status-only, and it must stay
 * status-only — a lapsed row let past that guard collides with
 * `user_subscription_one_active` at activation time, which converts a broken
 * button into *charged and not activated*).
 *
 * Before this type existed the divergence was invisible to both of them: the
 * profile offered the tier and the buy button answered 409 "you are already an
 * active member", which is false, and the web then advised a reload that
 * re-rendered the same button. Naming the third state is what lets each side
 * say something true.
 */
export type MembershipStanding = "member" | "lapsed" | "none";

/**
 * THE single definition of the three states, over the one row
 * `findActiveFor` returns. A pure function on purpose: `IsMemberOf` reads it
 * for the profile, and `StartUserSubscription` reads it for the refusal it is
 * about to word — from the row it has ALREADY fetched, so neither one costs a
 * second query and neither one re-derives the comparison. A second copy of
 * `current_period_end > now` is exactly what would drift.
 *
 * A `null` `currentPeriodEnd` on an `active` row is no longer one single
 * fact — `kind` is what tells apart the two different reasons it can occur
 * (spec §3):
 *
 *  - `kind = 'free'` — a free membership, granted by the owner approving a
 *    request (see the free-memberships design). It has no period BY DESIGN:
 *    nothing ever writes one, and nothing ever will, so `null` here is the
 *    normal, permanent shape of "never expires until cancelled or revoked".
 *  - `kind = 'paid'` — still unreachable today, for the reason this
 *    docstring gave before `kind` existed: `activate(id, periodEnd)` is the
 *    only writer of `active` status for a paid row and it always sets a
 *    period. If a paid row's period were ever `null` it would be a BUG, and
 *    it must keep reading as **lapsed** — granting nothing while still
 *    blocking a purchase — because calling it `member` would grant
 *    permanent access to gated content on the strength of that bug. That is
 *    the whole reason `kind` exists rather than overloading `null` to mean
 *    "free forever": a future bug leaving a paid row `null` must not
 *    silently look identical to an intentional free membership.
 *
 * So `kind` is checked FIRST, before the null test, and decides the answer
 * on its own for a free row without ever looking at `currentPeriodEnd`.
 */
export function membershipStanding(
  active: UserSubscriptionRow | null,
  now: Date
): MembershipStanding {
  if (!active) return "none";
  // A free membership has no period by design (spec §3). Checked BEFORE the null
  // test below, which is the guard that keeps a PAID row's null reading as lapsed.
  if (active.kind === "free") return "member";
  if (active.currentPeriodEnd === null) return "lapsed";
  return active.currentPeriodEnd.getTime() > now.getTime() ? "member" : "lapsed";
}

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
 * `describe` exists so a caller can tell that lapsed row apart from no row at
 * all without asking the database twice — see `MembershipStanding`. `execute`
 * is the boolean Phase 6 wants and is defined in terms of it, so the two can
 * never disagree.
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
    return (await this.describe(viewerId, ownerId)) === "member";
  }

  /** The same single indexed read, reported as all three states. */
  async describe(viewerId: string, ownerId: string): Promise<MembershipStanding> {
    // Nobody is a "member" of themselves — mirrors the database's own
    // `user_subscription_no_self` check constraint, which makes such a row
    // impossible to create in the first place.
    if (viewerId === ownerId) {
      return "none";
    }

    const active = await this.subscriptions.findActiveFor(viewerId, ownerId);
    return membershipStanding(active, this.clock.now());
  }
}
