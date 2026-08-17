import { ConflictError, NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowListRow, FollowRepositoryPort } from "../ports/follow-repository.port";

/**
 * The exact Bahasa Indonesia 409 message for tapping "Follow"/"Unfollow" on
 * your own profile — design spec §7, "Follow yourself | 409, in Bahasa
 * Indonesia".
 */
const SELF_FOLLOW_MESSAGE = "tidak bisa mengikuti akun sendiri";

/**
 * `POST /users/:handle/follow` and `DELETE /users/:handle/follow` — ONE use
 * case for both directions, because the handle lookup, the self-follow
 * refusal and the 404 are identical either way (plan Task 2).
 *
 * **THE PRECONDITION THIS CLASS EXISTS TO ENFORCE.** `FollowRepositoryPort
 * .follow()` does NOT guard `followerId === followeeId`, nor does it confirm
 * `followeeId` resolves to a real user — see that port's own docstring in
 * full. Both violations raise a RAW Postgres error straight out of the call
 * (`23514` for a self-follow, `23503` for a nonexistent user), and a raw
 * constraint violation ABORTS the enclosing transaction — catching it
 * downstream would hand back a clean-looking error object over a dead
 * transaction (see `DrizzleJoinRequestRepository.createPending`'s docstring
 * for the full account of why that hazard exists at all). Tapping "Follow"
 * on your own profile is the single most likely way a real user reaches this
 * path, so it cannot be left to the database to reject.
 *
 * This use case resolves the handle and rejects a self-follow BEFORE ever
 * calling `follow()`/`unfollow()` — neither raw error is reachable through
 * this path. The database's CHECK and foreign key remain backstops for a bug
 * or a bulk import, never the mechanism a real click depends on.
 *
 * **Idempotent both ways, by design** (design spec §7): a double-tap must
 * not error. Returns the RESULTING state, not whether a row changed —
 * following someone you already follow, or unfollowing someone you never
 * followed, both answer `{ following: <same state> }` rather than erroring.
 * That is what makes the response usable straight off the client's optimistic
 * button state (Task 5).
 */
export class FollowUser {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly follows: FollowRepositoryPort
  ) {}

  async execute(input: {
    followerId: string;
    handle: string;
    action: "follow" | "unfollow";
  }): Promise<{ following: boolean }> {
    const handle = normalizeHandle(input.handle);
    const target = await this.users.findByHandle(handle);
    if (!target) {
      throw new NotFoundError("user not found");
    }

    // THE guard this class exists for — see the class docstring. Checked
    // before either branch below, so it refuses an unfollow-yourself the
    // same way it refuses a follow-yourself; there is no state a self-follow
    // could have reached for an unfollow to undo anyway.
    if (target.id === input.followerId) {
      throw new ConflictError(SELF_FOLLOW_MESSAGE);
    }

    if (input.action === "follow") {
      await this.follows.follow(input.followerId, target.id);
      return { following: true };
    }

    await this.follows.unfollow(input.followerId, target.id);
    return { following: false };
  }
}

/** Page size when a follower/following list request carries no `limit`. */
export const DEFAULT_FOLLOW_LIST_LIMIT = 50;

/**
 * `GET /users/:handle/followers` and `GET /users/:handle/following` —
 * public, unauthenticated, and sharing the SAME handle-lookup-then-404 shape
 * `FollowUser` uses above. Rows are already the public `FollowListRow`
 * projection (`handle`/`displayName`/`bio`) — `DrizzleFollowRepository`
 * selects exactly those three columns at the query, so there is nothing
 * wider here for a spread to leak.
 *
 * `limit` is resolved by the caller (the route), which owns the "defaults to
 * 50, capped at 100" contract the same way `routes/analytics.ts`'s
 * `parsePageQuery` owns its own page size — this class only forwards
 * whatever positive integer it is given. `FollowRepositoryPort.listFollowers`
 * /`listFollowing` still clamp a non-positive or non-finite value to zero
 * rows as their OWN backstop; that is not duplicated here.
 */
export class ListFollows {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly follows: FollowRepositoryPort
  ) {}

  async execute(input: {
    handle: string;
    direction: "followers" | "following";
    limit?: number;
  }): Promise<FollowListRow[]> {
    const handle = normalizeHandle(input.handle);
    const user = await this.users.findByHandle(handle);
    if (!user) {
      throw new NotFoundError("user not found");
    }

    const limit = input.limit ?? DEFAULT_FOLLOW_LIST_LIMIT;
    return input.direction === "followers"
      ? this.follows.listFollowers(user.id, limit)
      : this.follows.listFollowing(user.id, limit);
  }
}
