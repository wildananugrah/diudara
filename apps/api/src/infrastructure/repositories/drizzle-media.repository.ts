import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { postMedia } from "../../db/schema";
import type { MediaRepositoryPort, MediaRow } from "../../application/ports/media-repository.port";
import { clampLimit } from "./drizzle-follow.repository";

export class DrizzleMediaRepository implements MediaRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    ownerId: string;
    width: number;
    height: number;
    byteSize: number;
  }): Promise<MediaRow> {
    const [row] = await this.db
      .insert(postMedia)
      .values({
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
  async claim(postId: string, ids: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(postMedia).set({ postId: null }).where(eq(postMedia.postId, postId));
      for (let position = 0; position < ids.length; position++) {
        await tx
          .update(postMedia)
          .set({ postId, position })
          .where(eq(postMedia.id, ids[position]!));
      }
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

  async deleteById(id: string): Promise<void> {
    await this.db.delete(postMedia).where(eq(postMedia.id, id));
  }
}
