import { and, asc, desc, eq, ilike, inArray, or, sql, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { comments, postAttachments, posts, uploads, users } from "../db/schema.ts";
import type { FeedFilter, PostRepository, PostWithMeta } from "../../domain/ports.ts";
import type { Post } from "../../domain/types.ts";
import { NotFoundError } from "../../domain/errors.ts";

export class DrizzlePostRepository implements PostRepository {
  constructor(private readonly db: Db) {}

  private selection() {
    const replies = sql<number>`(
      SELECT COUNT(*)::int FROM ${comments} WHERE ${comments.postId} = ${posts.id}
    )`.as("replies");
    return { post: posts, authorName: users.name, replies };
  }

  /** Attachments fetched in one extra query for the whole page, not per row (no N+1). */
  private async attachmentsFor(postIds: string[]) {
    if (postIds.length === 0) return new Map<string, PostWithMeta["attachments"]>();
    const rows = await this.db.select({
      postId: postAttachments.postId,
      id: uploads.id, name: uploads.filename, kind: uploads.kind,
    })
      .from(postAttachments)
      .innerJoin(uploads, eq(uploads.id, postAttachments.uploadId))
      .where(inArray(postAttachments.postId, postIds));

    const map = new Map<string, PostWithMeta["attachments"]>();
    for (const r of rows) {
      const list = map.get(r.postId) ?? [];
      list.push({ id: r.id, name: r.name, kind: r.kind, url: `/api/uploads/${r.id}` });
      map.set(r.postId, list);
    }
    return map;
  }

  private async hydrate(
    rows: Array<{ post: typeof posts.$inferSelect; authorName: string; replies: number }>,
  ): Promise<PostWithMeta[]> {
    const attachments = await this.attachmentsFor(rows.map((r) => r.post.id));
    return rows.map((r) => ({
      ...r.post,
      authorName: r.authorName,
      replies: r.replies,
      attachments: attachments.get(r.post.id) ?? [],
    }));
  }

  async list(filter: FeedFilter): Promise<PostWithMeta[]> {
    const conditions = [eq(posts.communityId, filter.communityId)];
    if (filter.types?.length) conditions.push(inArray(posts.type, filter.types));
    if (filter.tag && filter.tag !== "Semua") conditions.push(eq(posts.tag, filter.tag));
    if (filter.topic) conditions.push(eq(posts.topic, filter.topic));
    if (filter.q) {
      conditions.push(or(ilike(posts.title, `%${filter.q}%`), ilike(posts.body, `%${filter.q}%`))!);
    }

    const s = this.selection();
    const rows = await this.db.select(s).from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(and(...conditions))
      // "populer" sorts by reply count, which is the only engagement signal the
      // mock actually carries; "terbaru" is the default everywhere in the UI.
      .orderBy(filter.sort === "populer" ? desc(s.replies) : desc(posts.createdAt));

    return this.hydrate(rows);
  }

  async findById(id: string): Promise<PostWithMeta | null> {
    const rows = await this.db.select(this.selection()).from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(eq(posts.id, id)).limit(1);
    if (rows.length === 0) return null;
    return (await this.hydrate(rows))[0]!;
  }

  async create(input: Omit<Post, "id" | "createdAt" | "updatedAt"> & { attachmentIds?: string[] }): Promise<PostWithMeta> {
    const { attachmentIds, ...values } = input;
    const [row] = await this.db.insert(posts).values(values).returning();
    if (attachmentIds?.length) {
      await this.db.insert(postAttachments)
        .values(attachmentIds.map((uploadId) => ({ postId: row!.id, uploadId })))
        .onConflictDoNothing();
    }
    const created = await this.findById(row!.id);
    if (!created) throw new NotFoundError("Post");
    return created;
  }

  async update(id: string, patch: Partial<Post>): Promise<PostWithMeta> {
    await this.db.update(posts).set({ ...patch, updatedAt: new Date() }).where(eq(posts.id, id));
    const updated = await this.findById(id);
    if (!updated) throw new NotFoundError("Post");
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(posts).where(eq(posts.id, id));
  }

  async clearTopic(communityId: string, topic: string): Promise<number> {
    const rows = await this.db.update(posts)
      .set({ topic: null })
      .where(and(eq(posts.communityId, communityId), eq(posts.topic, topic)))
      .returning({ id: posts.id });
    return rows.length;
  }

  async renameTopic(communityId: string, from: string, to: string): Promise<number> {
    const rows = await this.db.update(posts)
      .set({ topic: to })
      .where(and(eq(posts.communityId, communityId), eq(posts.topic, from)))
      .returning({ id: posts.id });
    return rows.length;
  }

  async listTopics(communityId: string) {
    const rows = await this.db.select({
      name: posts.topic,
      count: sql<number>`COUNT(*)::int`,
    }).from(posts)
      .where(and(eq(posts.communityId, communityId), isNotNull(posts.topic)))
      .groupBy(posts.topic)
      .orderBy(asc(posts.topic));
    return rows
      .filter((r): r is { name: string; count: number } => Boolean(r.name))
      .map((r) => ({ name: r.name, count: r.count }));
  }
}
