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

  async create(authorId: string, body: string, visibility?: string): Promise<PostRow> {
    const [inserted] = await this.db
      .insert(posts)
      // `visibility` omitted entirely (not `visibility: undefined`) when the
      // caller did not pass one, so the column's own `default('public')`
      // decides — a spread with an explicit `undefined` value would instead
      // ask drizzle to insert NULL into a `NOT NULL` column and throw.
      .values(visibility === undefined ? { authorId, body } : { authorId, body, visibility })
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
      })
      .from(posts)
      .where(eq(posts.id, id));
    if (row === undefined) return null;
    return {
      id: row.id,
      authorId: row.authorId,
      isDeleted: row.deletedAt !== null,
      visibility: row.visibility,
    };
  }

  /**
   * Task 5 fix round 1. Same projection and same shape as `ownershipOf`,
   * `FOR UPDATE OF post` added — this is what makes it safe to read
   * `visibility` and the post's current media for a resulting-state check: a
   * second caller locking the SAME id blocks here until this transaction
   * ends. `of posts` names the table explicitly even though this query has
   * no join, matching `DrizzleSubscriptionRepository.markPaid`'s own
   * `for("update", { of: subscriptions })` — naming the target is what keeps
   * a later join added to this method from silently widening the lock.
   */
  async lockForEdit(id: string): Promise<PostOwnership | null> {
    const [row] = await this.db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        deletedAt: posts.deletedAt,
        visibility: posts.visibility,
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
    return this.page(isNull(posts.deletedAt), limit, before);
  }

  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    return this.page(and(eq(posts.authorId, authorId), isNull(posts.deletedAt)), limit, before);
  }

  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]> {
    // The join through `follow` is what excludes the viewer's own posts:
    // `follow_no_self` means no row can pair someone with themselves.
    return this.db
      .select(postColumns)
      .from(posts)
      .innerJoin(appUsers, eq(posts.authorId, appUsers.id))
      .innerJoin(follows, eq(follows.followeeId, posts.authorId))
      .where(and(eq(follows.followerId, viewerId), isNull(posts.deletedAt), beforeCursor(before)))
      .orderBy(...newestFirstOrder())
      .limit(clampLimit(limit));
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
