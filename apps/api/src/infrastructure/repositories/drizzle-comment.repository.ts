import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, postComments } from "../../db/schema";
import type {
  CommentOwnership,
  CommentRepositoryPort,
  CommentRow,
} from "../../application/ports/comment-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

/**
 * The ONE projection every comment read path selects — the same discipline
 * `postColumns` enforces in `drizzle-post.repository.ts`. `deleted_at` and the
 * author's `email` are absent BY CONSTRUCTION, not stripped downstream, so no
 * single path can quietly choose to leak them. `author_id` IS selected: a
 * delete check is a question about ids, and the view mapper is what keeps it
 * off the wire, not its absence here.
 */
const commentColumns = {
  id: postComments.id,
  body: postComments.body,
  createdAt: postComments.createdAt,
  authorId: postComments.authorId,
  authorHandle: appUsers.handle,
  authorDisplayName: appUsers.displayName,
} as const;

export class DrizzleCommentRepository implements CommentRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(postId: string, authorId: string, body: string): Promise<CommentRow> {
    const [inserted] = await this.db
      .insert(postComments)
      .values({ postId, authorId, body })
      .returning({ id: postComments.id });
    const row = await this.readOne(inserted!.id);
    // The row was just inserted inside this call; a null here means the
    // projection's author join is broken, which is a bug rather than a
    // missing comment.
    if (row === null) throw new Error("comment disappeared immediately after insert");
    return row;
  }

  listForPost(postId: string, limit: number): Promise<CommentRow[]> {
    // `ORDER BY created_at ASC` — a thread reads top to bottom, the exact
    // opposite of the post feed's DESC, and the one place this repository's
    // ordering differs from `drizzle-post.repository.ts`. `asc()` (bare `ASC`,
    // which Postgres reads as `NULLS LAST`) matches
    // `post_comment_post_created_idx`'s own default with no explicit `NULLS`
    // clause needed — unlike the feed's DESC case, which had to spell out
    // `NULLS LAST` to line up with a `DESC NULLS LAST` index. That partial
    // index is `(post_id, created_at) WHERE deleted_at IS NULL`, so the
    // `isNull(deletedAt)` filter here is served straight from it rather than
    // rechecked per row. `limit` goes through the SHARED `clampLimit` so a
    // negative value returns zero rows instead of postgres.js silently
    // dropping the `LIMIT` clause and returning the whole thread.
    return this.db
      .select(commentColumns)
      .from(postComments)
      .innerJoin(appUsers, eq(postComments.authorId, appUsers.id))
      .where(and(eq(postComments.postId, postId), isNull(postComments.deletedAt)))
      .orderBy(asc(postComments.createdAt))
      .limit(clampLimit(limit));
  }

  async countForPosts(postIds: string[]): Promise<Map<string, number>> {
    // Guard the empty list BEFORE querying: `inArray(x, [])` generates invalid
    // SQL in some drivers and is a wasted round trip in all of them.
    if (postIds.length === 0) return new Map();
    const rows = await this.db
      .select({ postId: postComments.postId, count: sql<number>`count(*)::int` })
      .from(postComments)
      .where(and(inArray(postComments.postId, postIds), isNull(postComments.deletedAt)))
      .groupBy(postComments.postId);
    // `::int` above is not optional: Postgres `count(*)` is `bigint`, which
    // postgres.js hands back as a STRING — every count would arrive as a
    // string on the wire without the cast, and `Map<string, number>` would be
    // a lie.
    return new Map(rows.map((r) => [r.postId, r.count]));
  }

  async ownershipOf(id: string): Promise<CommentOwnership | null> {
    const [row] = await this.db
      .select({
        id: postComments.id,
        authorId: postComments.authorId,
        postId: postComments.postId,
        deletedAt: postComments.deletedAt,
      })
      .from(postComments)
      .where(eq(postComments.id, id));
    // An id that never existed is `null`; a soft-deleted comment still
    // resolves, with `isDeleted: true`, so the caller tells "already gone"
    // apart from "never was". Same contract as `DrizzlePostRepository.ownershipOf`.
    if (row === undefined) return null;
    return {
      id: row.id,
      authorId: row.authorId,
      postId: row.postId,
      isDeleted: row.deletedAt !== null,
    };
  }

  async softDelete(id: string): Promise<void> {
    // The `isNull(deletedAt)` guard IS the idempotency, not a caveat to it: a
    // repeat call matches zero rows (the row's `deleted_at` is already
    // non-null), so it is a no-op UPDATE that neither errors nor slides the
    // ORIGINAL `deleted_at` forward. Identical to `DrizzlePostRepository.softDelete`.
    await this.db
      .update(postComments)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(postComments.id, id), isNull(postComments.deletedAt)));
  }

  private async readOne(id: string): Promise<CommentRow | null> {
    const [row] = await this.db
      .select(commentColumns)
      .from(postComments)
      .innerJoin(appUsers, eq(postComments.authorId, appUsers.id))
      .where(eq(postComments.id, id));
    return row ?? null;
  }
}
