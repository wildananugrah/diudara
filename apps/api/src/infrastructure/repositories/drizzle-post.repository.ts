import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, follows, posts } from "../../db/schema";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../../application/ports/post-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

/**
 * The ONE projection every read path selects. `author_id` and `deleted_at` are
 * absent by construction rather than stripped later — Phase 1's review found the
 * no-email invariant defended on only two of five repository paths precisely
 * because each path chose its own columns.
 */
const postColumns = {
  id: posts.id,
  body: posts.body,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
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

export class DrizzlePostRepository implements PostRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(authorId: string, body: string): Promise<PostRow> {
    const [inserted] = await this.db
      .insert(posts)
      .values({ authorId, body })
      .returning({ id: posts.id });
    const row = await this.readOne(inserted!.id);
    // The row was just inserted inside this call; a null here means the
    // projection join is broken, which is a bug rather than a missing post.
    if (row === null) throw new Error("post disappeared immediately after insert");
    return row;
  }

  async ownershipOf(id: string): Promise<PostOwnership | null> {
    const [row] = await this.db
      .select({ id: posts.id, authorId: posts.authorId, deletedAt: posts.deletedAt })
      .from(posts)
      .where(eq(posts.id, id));
    if (row === undefined) return null;
    return { id: row.id, authorId: row.authorId, isDeleted: row.deletedAt !== null };
  }

  async updateBody(id: string, body: string): Promise<PostRow | null> {
    const [updated] = await this.db
      .update(posts)
      .set({ body, editedAt: sql`now()` })
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .returning({ id: posts.id });
    if (updated === undefined) return null;
    return this.readOne(updated.id);
  }

  async softDelete(id: string): Promise<void> {
    // No `isNull` guard: re-deleting is a no-op that must not error, and
    // re-stamping deleted_at on an already-deleted row changes nothing anyone
    // can observe. The guard would only make the second call a silent failure.
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
      .orderBy(desc(posts.createdAt), desc(posts.id))
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
      .orderBy(desc(posts.createdAt), desc(posts.id))
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
