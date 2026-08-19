import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { postMedia } from "../../db/schema";
import type { MediaRepositoryPort, MediaRow } from "../../application/ports/media-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

export class DrizzleMediaRepository implements MediaRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    id?: string;
    ownerId: string;
    width: number;
    height: number;
    byteSize: number;
  }): Promise<MediaRow> {
    const [row] = await this.db
      .insert(postMedia)
      .values({
        // Omitted entirely rather than passed as `undefined` — the column's
        // own `defaultRandom()` only fires when the key is absent from
        // `.values()`, not merely `undefined`-valued.
        ...(input.id !== undefined ? { id: input.id } : {}),
        ownerId: input.ownerId,
        width: input.width,
        height: input.height,
        byteSize: input.byteSize,
      })
      .returning();
    return row!;
  }

  async findById(id: string): Promise<MediaRow | null> {
    const [row] = await this.db.select().from(postMedia).where(eq(postMedia.id, id)).limit(1);
    return row ?? null;
  }

  async findManyByIds(ids: string[]): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(postMedia).where(inArray(postMedia.id, ids));
  }

  /**
   * Two statements, ONE transaction, and the order between them is the whole
   * contract: first null out `post_id` for every row currently on this post,
   * THEN set `post_id`/`position` for each id in `ids`. Doing the release
   * before the claim means an id that is staying is simply re-claimed a
   * moment later, and — because both statements run inside one transaction —
   * no row is ever visible to another connection attached to two posts at
   * once, nor visible as unclaimed when it is really just being reordered.
   */
  async claim(postId: string, ids: string[]): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.update(postMedia).set({ postId: null }).where(eq(postMedia.postId, postId));
      let claimed = 0;
      for (let position = 0; position < ids.length; position++) {
        // `.returning({ id })` rather than a driver-specific rowcount: the
        // length of what comes back IS the number of rows the statement
        // touched, and it is the same shape on every executor this port is
        // handed (a pool, a transaction, a test double).
        const updated = await tx
          .update(postMedia)
          .set({ postId, position })
          .where(eq(postMedia.id, ids[position]!))
          .returning({ id: postMedia.id });
        claimed += updated.length;
      }
      return claimed;
    });
  }

  /** In `position` order — the order the client sent at claim time. */
  async listForPost(postId: string): Promise<MediaRow[]> {
    return this.db
      .select()
      .from(postMedia)
      .where(eq(postMedia.postId, postId))
      .orderBy(postMedia.position);
  }

  async listForPosts(postIds: string[]): Promise<MediaRow[]> {
    if (postIds.length === 0) return [];
    return this.db
      .select()
      .from(postMedia)
      .where(inArray(postMedia.postId, postIds))
      .orderBy(postMedia.position);
  }

  /** Oldest first, so the sweep drains the longest-orphaned rows first. */
  async listUnclaimedBefore(cutoff: Date, limit: number): Promise<MediaRow[]> {
    return this.db
      .select()
      .from(postMedia)
      .where(and(isNull(postMedia.postId), lt(postMedia.createdAt, cutoff)))
      .orderBy(postMedia.createdAt)
      .limit(clampLimit(limit));
  }

  /**
   * `WHERE id = ? AND post_id IS NULL` — the guard the port describes, enforced
   * in the DELETE itself rather than by a read-then-delete, which would be the
   * very TOCTOU race this exists to close.
   */
  async deleteIfUnclaimed(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(postMedia)
      .where(and(eq(postMedia.id, id), isNull(postMedia.postId)))
      .returning({ id: postMedia.id });
    return deleted.length > 0;
  }
}
