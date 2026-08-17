import { NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowRepositoryPort } from "../ports/follow-repository.port";

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
    private readonly follows: FollowRepositoryPort
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

    const [counts, viewerFollows] = await Promise.all([
      this.follows.countsFor(user.id),
      viewerId === null ? Promise.resolve(null) : this.follows.isFollowing(viewerId, user.id),
    ]);

    return {
      ...toProfileCore(user),
      followerCount: counts.followers,
      followingCount: counts.following,
      viewerFollows,
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
