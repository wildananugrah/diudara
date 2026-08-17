export interface FollowCounts {
  followers: number;
  following: number;
}

export interface FollowListRow {
  handle: string;
  displayName: string;
  bio: string | null;
}

export interface FollowRepositoryPort {
  /**
   * Idempotent: returns `false` when the row already existed, `true` when it was
   * created. Uses ON CONFLICT DO NOTHING rather than catching 23505 — a raw unique
   * violation ABORTS the enclosing Postgres transaction, so a catch yields a clean
   * error object and a dead transaction. See `drizzle-join-request.repository.ts`'s
   * `createPending` docstring, which explains the hazard in full.
   *
   * PRECONDITION THE CALLER MUST ENFORCE, NOT THIS METHOD: `followerId !==
   * followeeId`, and both ids resolve to real users. This method does NOT guard
   * either — it assumes the caller has already rejected a self-follow (e.g. at
   * the use-case or HTTP-validation layer, before this is ever reached) and
   * already knows both users exist. `follow_no_self` and the `followerId`/
   * `followeeId` foreign keys are BACKSTOPS for a bug or a bulk import, not the
   * guard: a violation of either raises the RAW driver error (`23514` for a
   * self-follow, `23503` for a nonexistent user) straight out of this call.
   *
   * That matters for exactly the same reason `createPending`'s docstring gives
   * for not catching `23505` here: a caller that composes `follow()` into a
   * larger transaction and then catches one of these two errors to "handle it
   * gracefully" would find the transaction already aborted, and every
   * statement after the catch would fail with "current transaction is
   * aborted" — the identical hazard, just triggered by a different SQLSTATE.
   * Reject the self-follow and confirm both users exist BEFORE calling this,
   * outside any transaction this call will join.
   */
  follow(followerId: string, followeeId: string): Promise<boolean>;
  /** Idempotent: `false` when there was nothing to remove. */
  unfollow(followerId: string, followeeId: string): Promise<boolean>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  countsFor(userId: string): Promise<FollowCounts>;
  /**
   * `limit` must be a positive integer. A non-positive or non-finite value
   * (a negative number, zero, `NaN`) yields ZERO rows rather than an
   * unbounded query — the implementation clamps rather than passing it
   * through, because Drizzle silently DROPS the `LIMIT` clause entirely for
   * a negative value, and this value arrives off an HTTP query param a
   * caller can set to anything.
   */
  listFollowers(userId: string, limit: number): Promise<FollowListRow[]>;
  /** See `listFollowers`'s `limit` contract — identical here. */
  listFollowing(userId: string, limit: number): Promise<FollowListRow[]>;
}
