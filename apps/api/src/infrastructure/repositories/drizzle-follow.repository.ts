import { and, count, desc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, follows } from "../../db/schema";
import type {
  FollowCounts,
  FollowListRow,
  FollowRepositoryPort,
} from "../../application/ports/follow-repository.port";

/**
 * Public row shape for `listFollowers`/`listFollowing`: handle, display name
 * and bio ONLY. Never `id` — nothing downstream needs a user id here, and a
 * list of them is exactly the kind of thing that leaks into a URL later.
 * Listing columns explicitly, the same discipline `DrizzleUserRepository`
 * uses for `passwordHash`, means the excluded columns are never fetched from
 * the database in the first place, not merely stripped afterwards.
 */
const publicListColumns = {
  handle: appUsers.handle,
  displayName: appUsers.displayName,
  bio: appUsers.bio,
} as const;

export class DrizzleFollowRepository implements FollowRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * `ON CONFLICT ... DO NOTHING`, deliberately NOT a bare INSERT wrapped in a
   * try/catch for `23505`. A unique violation ABORTS THE ENCLOSING
   * TRANSACTION in Postgres — every statement after it fails with "current
   * transaction is aborted" until a ROLLBACK — so catching the error here
   * would only be clean when this call happens to be the LAST statement of
   * its transaction. See `DrizzleJoinRequestRepository.createPending`'s
   * docstring, which explains the hazard (and this exact fix) in full.
   *
   * `target` is given explicitly, matching `follow_follower_followee_unique`
   * exactly, so a future unique constraint added to this table cannot start
   * silently swallowing an unrelated conflict here.
   */
  async follow(followerId: string, followeeId: string): Promise<boolean> {
    const [row] = await this.db
      .insert(follows)
      .values({ followerId, followeeId })
      .onConflictDoNothing({
        target: [follows.followerId, follows.followeeId],
      })
      .returning({ id: follows.id });
    return row !== undefined;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    const rows = await this.db
      .delete(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
      .returning({ id: follows.id });
    return rows.length > 0;
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: follows.id })
      .from(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
      .limit(1);
    return row !== undefined;
  }

  async countsFor(userId: string): Promise<FollowCounts> {
    const [[followerRow], [followingRow]] = await Promise.all([
      this.db.select({ value: count() }).from(follows).where(eq(follows.followeeId, userId)),
      this.db.select({ value: count() }).from(follows).where(eq(follows.followerId, userId)),
    ]);
    return {
      followers: followerRow?.value ?? 0,
      following: followingRow?.value ?? 0,
    };
  }

  /** Who follows `userId`, newest first. */
  async listFollowers(userId: string, limit: number): Promise<FollowListRow[]> {
    return this.db
      .select(publicListColumns)
      .from(follows)
      .innerJoin(appUsers, eq(follows.followerId, appUsers.id))
      .where(eq(follows.followeeId, userId))
      .orderBy(desc(follows.createdAt))
      .limit(limit);
  }

  /** Who `userId` follows, newest first. */
  async listFollowing(userId: string, limit: number): Promise<FollowListRow[]> {
    return this.db
      .select(publicListColumns)
      .from(follows)
      .innerJoin(appUsers, eq(follows.followeeId, appUsers.id))
      .where(eq(follows.followerId, userId))
      .orderBy(desc(follows.createdAt))
      .limit(limit);
  }
}
