import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, follows, posts } from "../../db/schema";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type {
  PostGating,
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../../application/ports/post-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

/**
 * The ONE projection every read path selects. `deleted_at` is absent by
 * construction rather than stripped later — Phase 1's review found the
 * no-email invariant defended on only two of five repository paths precisely
 * because each path chose its own columns. `author_id` and `visibility` ARE
 * selected (Phase 6): entitlement is a question about ids, not handles, and
 * `toPostView` in `post-views.ts` is what keeps them off the wire, not their
 * absence here.
 */
const postColumns = {
  id: posts.id,
  body: posts.body,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
  authorId: posts.authorId,
  visibility: posts.visibility,
  // Phase 2. `communityId` is `null` on every row the three personal read
  // paths return (they filter `community_id IS NULL`); `listByCommunity` is
  // the one path where it is set. `type` rides along so a community feed row
  // can render its `pengumuman` badge without a second lookup. Both are in
  // the SHARED projection rather than a `listByCommunity`-only one for the
  // reason this comment block already gives: one projection, decided once.
  communityId: posts.communityId,
  type: posts.type,
  authorHandle: appUsers.handle,
  authorDisplayName: appUsers.displayName,
} as const;

/**
 * `(created_at, id) < (cursor.timestamp, cursor.id)` in a form Postgres can use
 * the index for. Written as an explicit OR rather than a row comparison because
 * the index is `(created_at desc, id desc)` and a row-wise `<` on mixed
 * directions does not match it.
 */
function beforeCursor(cursor: KeysetCursor | null) {
  if (cursor === null) return undefined;
  return or(
    lt(posts.createdAt, cursor.timestamp),
    and(eq(posts.createdAt, cursor.timestamp), lt(posts.id, cursor.id))
  );
}

/**
 * `ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST` — deliberately
 * NOT drizzle's `desc()` query-builder helper. That helper emits a bare
 * `DESC`, which Postgres reads as `DESC NULLS FIRST`, while
 * `post_live_created_idx` and `post_author_created_idx` are both declared
 * `DESC NULLS LAST` (drizzle's `.desc()` on an INDEX column — `schema.ts` —
 * adds `NULLS LAST` automatically; the query-builder's `desc()` does not).
 * The mismatched pathkeys meant Postgres could not use either index to
 * satisfy this order at all: on 40k posts, `listGlobal` sequentially
 * scanned every live row and top-N heapsorted the result, with
 * `post_live_created_idx` at `idx_scan: 0` in `pg_stat_user_indexes` after
 * real queries — reproduced and pinned by "the indexes post reads go
 * through", below.
 *
 * `created_at` and `id` are both `NOT NULL`, so which NULLS placement wins
 * is semantically free either way; matching the index's own choice (rather
 * than changing the index to match a bare `desc()`) is what lets the
 * planner use it without a migration change.
 */
function newestFirstOrder() {
  return [sql`${posts.createdAt} desc nulls last`, sql`${posts.id} desc nulls last`] as const;
}

export class DrizzlePostRepository implements PostRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    authorId: string;
    body: string;
    visibility?: string;
    communityId?: string;
    type?: string;
  }): Promise<PostRow> {
    // Each optional column is spread in ONLY when the caller passed a value —
    // never as `key: undefined`. drizzle turns an explicit `undefined` into a
    // literal `NULL` in the INSERT, which throws against the `NOT NULL DEFAULT`
    // columns (`visibility`, `type`) instead of letting the column's own
    // default decide. `communityId` is genuinely nullable, but omitting it
    // when absent keeps the one rule for all three.
    const values = {
      authorId: input.authorId,
      body: input.body,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.communityId === undefined ? {} : { communityId: input.communityId }),
      ...(input.type === undefined ? {} : { type: input.type }),
    };
    const [inserted] = await this.db
      .insert(posts)
      .values(values)
      .returning({ id: posts.id });
    const row = await this.readOne(inserted!.id);
    // The row was just inserted inside this call; a null here means the
    // projection join is broken, which is a bug rather than a missing post.
    if (row === null) throw new Error("post disappeared immediately after insert");
    return row;
  }

  async ownershipOf(id: string): Promise<PostOwnership | null> {
    const [row] = await this.db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        deletedAt: posts.deletedAt,
        visibility: posts.visibility,
        communityId: posts.communityId,
      })
      .from(posts)
      .where(eq(posts.id, id));
    if (row === undefined) return null;
    return {
      id: row.id,
      authorId: row.authorId,
      isDeleted: row.deletedAt !== null,
      visibility: row.visibility,
      communityId: row.communityId,
    };
  }

  /**
   * `GET /users/posts/:id`. The SHARED projection, joined the same way the
   * list paths join it, with `deleted_at IS NULL` — a soft-deleted post is
   * unreachable here exactly as it is through `listGlobal` and friends. This
   * is NOT `readOne` below: `readOne` reads a row back right after this
   * process wrote it (create / updateBody, both already deleted-guarded) and
   * deliberately carries no delete filter of its own.
   */
  async getById(id: string): Promise<PostRow | null> {
    const [row] = await this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)));
    return row ?? null;
  }

  /**
   * Task 5 fix round 1. Same projection and same shape as `ownershipOf`,
   * `FOR UPDATE OF post` added — this is what makes it safe to read
   * `visibility` and the post's current media for a resulting-state check: a
   * second caller locking the SAME id blocks here until this transaction
   * ends. `of posts` names the table explicitly even though this query has
   * no join — naming the target is what keeps a later join added to this
   * method from silently widening the lock. (The pattern came from the
   * community subscription repository's `markPaid`, which retire-telegram
   * Task 5 deleted along with the rest of that repository at Task 6; the
   * reason for it is independent of that method.)
   */
  async lockForEdit(id: string): Promise<PostOwnership | null> {
    const [row] = await this.db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        deletedAt: posts.deletedAt,
        visibility: posts.visibility,
        communityId: posts.communityId,
      })
      .from(posts)
      .where(eq(posts.id, id))
      .for("update", { of: posts });
    if (row === undefined) return null;
    return {
      id: row.id,
      authorId: row.authorId,
      isDeleted: row.deletedAt !== null,
      visibility: row.visibility,
      communityId: row.communityId,
    };
  }

  /**
   * Two columns, by primary key — what BARRIER TWO reads before any bytes
   * leave `MediaStoragePort` (spec §6.2).
   *
   * NO `deleted_at` FILTER, and that is the whole difference from the read
   * paths above: a soft-deleted post is unreachable through every projection,
   * but its images are still reachable by id, and §6.3 settles that this route
   * keeps serving them exactly as it does today. Filtering here would answer
   * `null` for a deleted post, which the gate refuses — a behaviour change to
   * deletion semantics smuggled in through a WHERE clause.
   */
  async gatingOf(id: string): Promise<PostGating | null> {
    const [row] = await this.db
      .select({ authorId: posts.authorId, visibility: posts.visibility })
      .from(posts)
      .where(eq(posts.id, id));
    return row ?? null;
  }

  async updateBody(id: string, body: string, visibility?: string): Promise<PostRow | null> {
    const [updated] = await this.db
      .update(posts)
      // `visibility` omitted (not spread as `undefined`) means "do not touch
      // this column" — the same reasoning as `create` above, and the reason
      // an omitted `visibility` on PATCH leaves a post's gating exactly as
      // it was rather than resetting it to public.
      .set(
        visibility === undefined
          ? { body, editedAt: sql`now()` }
          : { body, editedAt: sql`now()`, visibility }
      )
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .returning({ id: posts.id });
    if (updated === undefined) return null;
    return this.readOne(updated.id);
  }

  async softDelete(id: string): Promise<void> {
    // The `isNull(posts.deletedAt)` guard IS present, and idempotency comes
    // from it, not despite it: a repeat call matches zero rows (the row's
    // deleted_at is already non-null), so it is a no-op UPDATE that neither
    // errors nor touches the row — the ORIGINAL deleted_at is left exactly as
    // it was, which is strictly better than a guardless UPDATE that would
    // slide the timestamp forward on every repeat call.
    await this.db
      .update(posts)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)));
  }

  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    // `community_id IS NULL` is the Phase 2 addition, and it is the WHOLE of
    // "Beranda shows personal posts only": a community post is reachable from
    // its own community page and nowhere else. The predicate is duplicated
    // into `post_live_created_idx`'s `WHERE` so the planner can serve this
    // scan straight from the partial index — the two must be kept in step.
    return this.page(and(isNull(posts.deletedAt), isNull(posts.communityId)), limit, before);
  }

  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    // Same `community_id IS NULL` as `listGlobal`, for the same reason: a
    // profile lists that person's PERSONAL posts. It matches
    // `post_author_created_idx`'s `WHERE` — that index was made partial in
    // Phase 2 specifically so this filter costs nothing.
    return this.page(
      and(eq(posts.authorId, authorId), isNull(posts.deletedAt), isNull(posts.communityId)),
      limit,
      before
    );
  }

  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    // The join through `follow` is what excludes the viewer's own posts:
    // `follow_no_self` means no row can pair someone with themselves.
    // `community_id IS NULL` — the third of the three personal read paths a
    // community post must never surface on (Phase 2). The post side of this
    // join is `post_author_created_idx`, whose `WHERE` now carries the same
    // condition.
    return this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .innerJoin(follows, eq(follows.followeeId, posts.authorId))
      .where(
        and(
          eq(follows.followerId, viewerId),
          isNull(posts.deletedAt),
          isNull(posts.communityId),
          beforeCursor(before)
        )
      )
      .orderBy(...newestFirstOrder())
      .limit(clampLimit(limit));
  }

  listByCommunity(
    communityId: string,
    limit: number,
    before: KeysetCursor | null
  ): Promise<PostRow[]> {
    // The mirror image of the three personal paths: `community_id = $1`
    // where they have `community_id IS NULL`. `deleted_at IS NULL` is the
    // only filter shared with them. `post_community_created_idx` (added in
    // Task 1) is the partial index this rides — `(community_id, created_at
    // desc, id desc) WHERE deleted_at IS NULL`.
    return this.page(
      and(eq(posts.communityId, communityId), isNull(posts.deletedAt)),
      limit,
      before
    );
  }

  private page(
    filter: ReturnType<typeof and>,
    limit: number,
    before: KeysetCursor | null
  ): Promise<PostRow[]> {
    return this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .where(and(filter, beforeCursor(before)))
      .orderBy(...newestFirstOrder())
      .limit(clampLimit(limit));
  }

  private async readOne(id: string): Promise<PostRow | null> {
    const [row] = await this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .where(eq(posts.id, id));
    return row ?? null;
  }
}
