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
   */
  follow(followerId: string, followeeId: string): Promise<boolean>;
  /** Idempotent: `false` when there was nothing to remove. */
  unfollow(followerId: string, followeeId: string): Promise<boolean>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  countsFor(userId: string): Promise<FollowCounts>;
  listFollowers(userId: string, limit: number): Promise<FollowListRow[]>;
  listFollowing(userId: string, limit: number): Promise<FollowListRow[]>;
}
