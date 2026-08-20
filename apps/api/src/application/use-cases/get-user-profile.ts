import { NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowRepositoryPort } from "../ports/follow-repository.port";
import type { UserTierRepositoryPort } from "../ports/user-tier-repository.port";
import type { IsMemberOf } from "./is-member-of";
import { toMembershipView, type MembershipView } from "./tier-views";

/**
 * The fields common to every profile shape this use case returns, public or
 * own. Deliberately NOT what `PublicUserProfile` is built from by extension
 * downward — see that interface's own docstring for why `OwnUserProfile`
 * extends THIS instead of `PublicUserProfile`: `GET /users/me` is untouched
 * by Task 2, and inheriting `followerCount`/`followingCount`/`viewerFollows`
 * from `PublicUserProfile` would have silently widened its response and
 * broken its own `Object.keys` assertion.
 */
export interface UserProfileCore {
  handle: string;
  displayName: string;
  bio: string | null;
  createdAt: Date;
}

/**
 * `GET /users/by-handle/:handle`'s response shape. Anyone can fetch any
 * profile by handle, unauthenticated — so this is an EXPLICIT projection,
 * never a spread of `UserRecord`. `email` and `whatsappNumber` would be a far
 * worse leak here than the account-enumeration the rest of this phase
 * carefully avoids; `id` and `sessionEpoch` have no business being public at
 * all. Assert on `Object.keys(body).sort()` in route tests, not on this
 * type — TypeScript's structural typing accepts extra properties silently,
 * which is exactly how a previous phase's hash-exclusion mutation slipped
 * past both the suite and typecheck.
 *
 * Task 2 (profiles and following) widens this by exactly three fields —
 * `followerCount`, `followingCount`, `viewerFollows` — design spec §6: "the
 * public projection stays exactly what Phase 1 pinned ... plus the two
 * counts and, for a signed-in viewer, whether they already follow."
 *
 * Task 5 of memberships-5a widens it by one more: `membership`, the
 * creator's offer (spec §6: "A profile shows the offer and a 'Jadi anggota'
 * button"). See `tier-views.ts` for why that shape is closed to exactly
 * `id`/`name`/`priceAmount`/`billingCycle` per tier.
 */
export interface PublicUserProfile extends UserProfileCore {
  followerCount: number;
  followingCount: number;
  /**
   * `null` when the viewer is signed out — NEVER inferred client-side, and
   * NEVER collapsed to `false`. A signed-out visitor renders "Masuk untuk
   * mengikuti"; a signed-in non-follower renders "Ikuti". Those are
   * different states with different available actions, and collapsing them
   * would make an anonymous visitor look like a non-follower who could tap
   * Follow.
   */
  viewerFollows: boolean | null;
  /**
   * What this creator is selling, plus whether the CALLER already holds a
   * live membership to them (Task 10). `tiers` is always an array, even when
   * the owner has never published a tier or has no connected payout account
   * (both cases mean `listActiveByOwner` returns no rows) — see
   * `toMembershipView`'s own docstring for why the field itself must never
   * be omitted, and `MembershipView`'s for why `viewerIsMember` is `false`
   * rather than `null` for an anonymous caller.
   */
  membership: MembershipView;
}

/**
 * `GET /users/me`'s response shape — the public CORE fields PLUS email and
 * WhatsApp number, because it is the authenticated caller's OWN record.
 * Still an explicit projection, not a spread: it must never carry
 * `passwordHash` (impossible anyway, since `UserRecord` never has it) or
 * `sessionEpoch`. Extends `UserProfileCore`, not `PublicUserProfile` — see
 * that interface's own docstring for why.
 */
export interface OwnUserProfile extends UserProfileCore {
  email: string;
  whatsappNumber: string | null;
}

function toProfileCore(user: UserRecord): UserProfileCore {
  return {
    handle: user.handle,
    displayName: user.displayName,
    bio: user.bio,
    createdAt: user.createdAt,
  };
}

/** Exported so `UpdateUserProfile` projects its own result the same way. */
export function toOwnProfile(user: UserRecord): OwnUserProfile {
  return {
    ...toProfileCore(user),
    email: user.email,
    whatsappNumber: user.whatsappNumber,
  };
}

export class GetUserProfile {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly follows: FollowRepositoryPort,
    private readonly tiers: UserTierRepositoryPort,
    /**
     * Task 10. **The use-case itself, not a re-derivation of it.**
     *
     * `IsMemberOf` (Task 8) is the single definition of "is this viewer a
     * paying member", and Phase 6's paywall is founded on it. Asking a
     * subscription repository directly from here would put a SECOND
     * definition in the codebase — and the half that would go missing from
     * the copy is the `current_period_end > now` comparison, since 5a has no
     * renewal pass and a lapsed row sits at `status = 'active'` forever
     * (§9). Injected as the class rather than a hand-written interface so a
     * test cannot substitute a stub that answers differently from the real
     * thing.
     *
     * This is also the ONLY place in 5a that puts `IsMemberOf` on a request
     * path at all.
     */
    private readonly membership: IsMemberOf
  ) {}

  /**
   * `GET /users/by-handle/:handle` — public, no session required. Takes a
   * BARE handle; the `@` some clients still type is a web URL convention
   * only. `normalizeHandle` strips one leading `@` before the lookup, so a
   * mistake here is forgiving rather than a 404.
   *
   * `viewerId` is the CALLER's id if signed in, `null` if anonymous —
   * resolved by the route via `resolveViewerId`, which never throws even
   * when the token is missing or invalid, because this route never required
   * one. It decides `viewerFollows` alone; it never gates whether the
   * profile itself is returned.
   */
  async execute(rawHandle: string, viewerId: string | null): Promise<PublicUserProfile> {
    const handle = normalizeHandle(rawHandle);
    const user = await this.users.findByHandle(handle);
    if (!user) {
      throw new NotFoundError("user not found");
    }

    // One call for the profile's tiers, not one per tier — `listActiveByOwner`
    // is itself a single scoped query (its own port docstring and
    // `DrizzleUserTierRepository`); this just runs it alongside the two other
    // reads this profile already needed rather than after them.
    const [counts, viewerFollows, activeTiers, viewerIsMember] = await Promise.all([
      this.follows.countsFor(user.id),
      viewerId === null ? Promise.resolve(null) : this.follows.isFollowing(viewerId, user.id),
      this.tiers.listActiveByOwner(user.id),
      // ANONYMOUS SHORT-CIRCUITS, and answers `false` rather than `null`: there
      // is no viewer to hold a membership, so there is no question to ask the
      // database — this route is public and most of its traffic has no session
      // at all. See `MembershipView`'s docstring for why `false` and not
      // `null`, which is what its neighbour `viewerFollows` above answers.
      //
      // For a signed-in caller this is ONE further indexed read
      // (`user_subscription_one_active`), running alongside the three this
      // profile already made rather than after them — the same query Phase 6
      // will run per gated post.
      viewerId === null ? Promise.resolve(false) : this.membership.execute(viewerId, user.id),
    ]);

    return {
      ...toProfileCore(user),
      followerCount: counts.followers,
      followingCount: counts.following,
      viewerFollows,
      membership: toMembershipView(activeTiers, viewerIsMember),
    };
  }

  /**
   * `GET /users/me` — the authenticated caller's own record, read by id.
   * `requireUserAuth` has already re-read this same row once (to check
   * `sessionEpoch`) before this ever runs; this is a second read rather than
   * threading that one through, mirroring how the rest of this codebase
   * keeps route middleware and use-cases independently testable.
   */
  async executeOwn(userId: string): Promise<OwnUserProfile> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundError("user not found");
    }
    return toOwnProfile(user);
  }
}
