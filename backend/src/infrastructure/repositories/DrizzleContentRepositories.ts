import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  commentLikes, comments, documentDownloads, documents, quizOptions, quizQuestions,
  syllabi, syllabusItems, tiers, uploads, users,
} from "../db/schema.ts";
import type {
  CommentRepository, DocumentRepository, QuizQuestion, QuizRepository, SyllabusItem,
  SyllabusRepository, Tier, TierRepository, UploadRepository,
} from "../../domain/ports.ts";
import type { QuizFormat, UploadKind } from "../../domain/types.ts";
import { NotFoundError } from "../../domain/errors.ts";
import { embedUrlFor, parseYouTubeId } from "../../domain/youtube.ts";

type ItemRow = {
  id: string; title: string; type: string; duration: string; sourceUrl: string | null;
  uploadId: string | null; uploadName: string | null; uploadKind: UploadKind | null;
};

/**
 * Collapses the LEFT JOIN's nullable upload columns into one `file`, and derives
 * `embedUrl` so no client has to parse a YouTube URL itself.
 */
function toItem(row: ItemRow): SyllabusItem {
  // Only a video or audio lesson renders in an embedded player. An e-book
  // pointing at YouTube still opens as a plain link rather than a video frame.
  const embeddable = row.type === "video" || row.type === "audio";
  const videoId = embeddable ? parseYouTubeId(row.sourceUrl) : null;
  return {
    id: row.id, title: row.title, type: row.type, duration: row.duration,
    file: row.uploadId && row.uploadName && row.uploadKind
      ? { id: row.uploadId, name: row.uploadName, kind: row.uploadKind, url: `/api/uploads/${row.uploadId}` }
      : null,
    sourceUrl: row.sourceUrl,
    embedUrl: videoId ? embedUrlFor(videoId) : null,
  };
}

export class DrizzleCommentRepository implements CommentRepository {
  constructor(private readonly db: Db) {}

  private likesExpr() {
    return sql<number>`(
      SELECT COUNT(*)::int FROM ${commentLikes} WHERE ${commentLikes.commentId} = ${comments.id}
    )`.as("likes");
  }

  async listForPost(postId: string) {
    return this.db.select({
      id: comments.id, authorName: users.name, body: comments.body,
      createdAt: comments.createdAt, likes: this.likesExpr(),
    })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.postId, postId))
      .orderBy(asc(comments.createdAt));
  }

  async create(input: { postId: string; authorId: string; body: string }) {
    const [row] = await this.db.insert(comments).values(input).returning();
    const author = await this.db.select({ name: users.name }).from(users)
      .where(eq(users.id, input.authorId)).limit(1);
    return {
      id: row!.id, authorName: author[0]?.name ?? "Anon",
      body: row!.body, createdAt: row!.createdAt, likes: 0,
    };
  }

  async toggleLike(commentId: string, userId: string) {
    const existing = await this.db.select().from(commentLikes)
      .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, userId))).limit(1);

    if (existing.length > 0) {
      await this.db.delete(commentLikes)
        .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, userId)));
    } else {
      await this.db.insert(commentLikes).values({ commentId, userId }).onConflictDoNothing();
    }

    const [row] = await this.db.select({ n: sql<number>`COUNT(*)::int` }).from(commentLikes)
      .where(eq(commentLikes.commentId, commentId));
    return { likes: row?.n ?? 0, liked: existing.length === 0 };
  }
}

export class DrizzleSyllabusRepository implements SyllabusRepository {
  constructor(private readonly db: Db) {}

  /**
   * Items with their file joined. LEFT, not inner: an item whose upload is
   * missing (or never set) must still appear in the outline.
   */
  private itemsIn(syllabusIds: string[]) {
    return this.db.select({
      id: syllabusItems.id, syllabusId: syllabusItems.syllabusId, title: syllabusItems.title,
      type: syllabusItems.type, duration: syllabusItems.duration,
      sourceUrl: syllabusItems.sourceUrl,
      uploadId: uploads.id, uploadName: uploads.filename, uploadKind: uploads.kind,
    })
      .from(syllabusItems)
      .leftJoin(uploads, eq(uploads.id, syllabusItems.uploadId))
      .where(inArray(syllabusItems.syllabusId, syllabusIds))
      .orderBy(asc(syllabusItems.sortOrder));
  }

  async listForCommunity(communityId: string) {
    const groups = await this.db.select().from(syllabi)
      .where(eq(syllabi.communityId, communityId)).orderBy(asc(syllabi.sortOrder));
    if (groups.length === 0) return [];

    const items = await this.itemsIn(groups.map((g) => g.id));

    return groups.map((g) => ({
      id: g.id,
      title: g.title,
      items: items.filter((i) => i.syllabusId === g.id).map(toItem),
    }));
  }

  /**
   * New rows land at the end of their list. Reordering is a separate `sortOrder`
   * patch, so creating never has to renumber siblings.
   */
  private async nextOrder(scope: "group" | "item", parentId: string): Promise<number> {
    const [row] = scope === "group"
      ? await this.db.select({ n: sql<number>`COALESCE(MAX(${syllabi.sortOrder}), -1) + 1` })
          .from(syllabi).where(eq(syllabi.communityId, parentId))
      : await this.db.select({ n: sql<number>`COALESCE(MAX(${syllabusItems.sortOrder}), -1) + 1` })
          .from(syllabusItems).where(eq(syllabusItems.syllabusId, parentId));
    return row?.n ?? 0;
  }

  async findGroup(id: string) {
    const [row] = await this.db.select({
      id: syllabi.id, communityId: syllabi.communityId, title: syllabi.title,
    }).from(syllabi).where(eq(syllabi.id, id)).limit(1);
    return row ?? null;
  }

  async createGroup(input: { communityId: string; title: string }) {
    const [row] = await this.db.insert(syllabi).values({
      // syllabi.id has no $defaultFn — the seed writes slugs like "week-1".
      id: crypto.randomUUID(),
      communityId: input.communityId,
      title: input.title,
      sortOrder: await this.nextOrder("group", input.communityId),
    }).returning();
    return { id: row!.id, title: row!.title, items: [] };
  }

  async updateGroup(id: string, patch: { title?: string; sortOrder?: number }) {
    const [row] = await this.db.update(syllabi).set(patch)
      .where(eq(syllabi.id, id)).returning();
    if (!row) throw new NotFoundError("Silabus");
    const items = await this.itemsIn([id]);
    return { id: row.id, title: row.title, items: items.map(toItem) };
  }

  async deleteGroup(id: string) {
    // syllabus_items.syllabus_id is ON DELETE CASCADE, so items go with it.
    await this.db.delete(syllabi).where(eq(syllabi.id, id));
  }

  async findItem(id: string) {
    const [row] = await this.db.select({
      id: syllabusItems.id, syllabusId: syllabusItems.syllabusId,
      communityId: syllabi.communityId, type: syllabusItems.type,
    })
      .from(syllabusItems)
      .innerJoin(syllabi, eq(syllabi.id, syllabusItems.syllabusId))
      .where(eq(syllabusItems.id, id)).limit(1);
    return row ?? null;
  }

  /** Re-reads through itemsIn so the response carries the joined file. */
  private async itemById(id: string): Promise<SyllabusItem> {
    const [row] = await this.db.select({
      id: syllabusItems.id, title: syllabusItems.title, type: syllabusItems.type,
      duration: syllabusItems.duration, sourceUrl: syllabusItems.sourceUrl,
      uploadId: uploads.id, uploadName: uploads.filename, uploadKind: uploads.kind,
    })
      .from(syllabusItems)
      .leftJoin(uploads, eq(uploads.id, syllabusItems.uploadId))
      .where(eq(syllabusItems.id, id)).limit(1);
    if (!row) throw new NotFoundError("Materi");
    return toItem(row);
  }

  async createItem(input: {
    syllabusId: string; title: string; type: string; duration: string;
    uploadId?: string | null; sourceUrl?: string | null;
  }) {
    const [row] = await this.db.insert(syllabusItems).values({
      ...input, uploadId: input.uploadId ?? null, sourceUrl: input.sourceUrl ?? null,
      sortOrder: await this.nextOrder("item", input.syllabusId),
    }).returning();
    return this.itemById(row!.id);
  }

  async updateItem(id: string, patch: {
    title?: string; type?: string; duration?: string; sortOrder?: number;
    uploadId?: string | null; sourceUrl?: string | null;
  }) {
    const [row] = await this.db.update(syllabusItems).set(patch)
      .where(eq(syllabusItems.id, id)).returning();
    if (!row) throw new NotFoundError("Materi");
    return this.itemById(row.id);
  }

  async deleteItem(id: string) {
    await this.db.delete(syllabusItems).where(eq(syllabusItems.id, id));
  }
}

export class DrizzleQuizRepository implements QuizRepository {
  constructor(private readonly db: Db) {}

  /** Two queries, not one per question: the N+1 shows up fast on a 20-question quiz. */
  private async withOptions(questionRows: Array<typeof quizQuestions.$inferSelect>): Promise<QuizQuestion[]> {
    if (questionRows.length === 0) return [];
    const opts = await this.db.select().from(quizOptions)
      .where(inArray(quizOptions.questionId, questionRows.map((q) => q.id)))
      .orderBy(asc(quizOptions.sortOrder));

    return questionRows.map((q) => ({
      id: q.id, prompt: q.prompt, format: q.format, explanation: q.explanation,
      options: opts.filter((o) => o.questionId === q.id)
        .map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
    }));
  }

  async listForItem(itemId: string) {
    const rows = await this.db.select().from(quizQuestions)
      .where(eq(quizQuestions.itemId, itemId)).orderBy(asc(quizQuestions.sortOrder));
    return this.withOptions(rows);
  }

  async findQuestion(id: string) {
    const [row] = await this.db.select({
      id: quizQuestions.id, itemId: quizQuestions.itemId, communityId: syllabi.communityId,
    })
      .from(quizQuestions)
      .innerJoin(syllabusItems, eq(syllabusItems.id, quizQuestions.itemId))
      .innerJoin(syllabi, eq(syllabi.id, syllabusItems.syllabusId))
      .where(eq(quizQuestions.id, id)).limit(1);
    return row ?? null;
  }

  private async replaceOptions(questionId: string, options: Array<{ text: string; isCorrect: boolean }>) {
    await this.db.delete(quizOptions).where(eq(quizOptions.questionId, questionId));
    if (options.length === 0) return;
    await this.db.insert(quizOptions).values(
      options.map((o, i) => ({ questionId, text: o.text, isCorrect: o.isCorrect, sortOrder: i })),
    );
  }

  private async questionById(id: string): Promise<QuizQuestion> {
    const [row] = await this.db.select().from(quizQuestions).where(eq(quizQuestions.id, id)).limit(1);
    if (!row) throw new NotFoundError("Soal");
    const [built] = await this.withOptions([row]);
    return built!;
  }

  async createQuestion(input: {
    itemId: string; prompt: string; format: QuizFormat; explanation: string | null;
    options: Array<{ text: string; isCorrect: boolean }>;
  }) {
    const [row] = await this.db.select({ n: sql<number>`COALESCE(MAX(${quizQuestions.sortOrder}), -1) + 1` })
      .from(quizQuestions).where(eq(quizQuestions.itemId, input.itemId));

    const [created] = await this.db.insert(quizQuestions).values({
      itemId: input.itemId, prompt: input.prompt, format: input.format,
      explanation: input.explanation, sortOrder: row?.n ?? 0,
    }).returning();

    await this.replaceOptions(created!.id, input.options);
    return this.questionById(created!.id);
  }

  async updateQuestion(id: string, patch: {
    prompt?: string; format?: QuizFormat; explanation?: string | null; sortOrder?: number;
    options?: Array<{ text: string; isCorrect: boolean }>;
  }) {
    const { options, ...columns } = patch;
    if (Object.values(columns).some((v) => v !== undefined)) {
      const [row] = await this.db.update(quizQuestions).set(columns)
        .where(eq(quizQuestions.id, id)).returning();
      if (!row) throw new NotFoundError("Soal");
    }
    if (options) await this.replaceOptions(id, options);
    return this.questionById(id);
  }

  async deleteQuestion(id: string) {
    // quiz_options.question_id is ON DELETE CASCADE.
    await this.db.delete(quizQuestions).where(eq(quizQuestions.id, id));
  }
}

export class DrizzleDocumentRepository implements DocumentRepository {
  constructor(private readonly db: Db) {}

  async listForCommunity(communityId: string) {
    return this.db.select({
      id: documents.id, name: documents.name, type: documents.type,
      sizeBytes: documents.sizeBytes, createdAt: documents.createdAt,
    }).from(documents)
      .where(eq(documents.communityId, communityId))
      .orderBy(desc(documents.createdAt));
  }

  async findById(id: string) {
    const [row] = await this.db.select({
      id: documents.id, communityId: documents.communityId, name: documents.name,
      storageKey: uploads.storageKey, mime: uploads.mime,
    })
      .from(documents)
      .innerJoin(uploads, eq(uploads.id, documents.uploadId))
      .where(eq(documents.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: {
    communityId: string; uploadId: string; name: string; type: string; sizeBytes: number;
  }) {
    const [row] = await this.db.insert(documents).values(input).returning();
    return {
      id: row!.id, name: row!.name, type: row!.type,
      sizeBytes: row!.sizeBytes, createdAt: row!.createdAt,
    };
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(documents).where(eq(documents.id, id));
  }

  async recordDownload(documentId: string, userId: string): Promise<void> {
    await this.db.insert(documentDownloads).values({ documentId, userId });
  }

  async topDownloaded(communityId: string, limit: number) {
    const downloads = sql<number>`COUNT(${documentDownloads.id})::int`.as("downloads");
    return this.db.select({ name: documents.name, type: documents.type, downloads })
      .from(documents)
      .leftJoin(documentDownloads, eq(documentDownloads.documentId, documents.id))
      .where(eq(documents.communityId, communityId))
      .groupBy(documents.id, documents.name, documents.type)
      .orderBy(desc(downloads))
      .limit(limit);
  }
}

export class DrizzleTierRepository implements TierRepository {
  constructor(private readonly db: Db) {}

  private static map(r: typeof tiers.$inferSelect): Tier {
    return {
      id: r.id, communityId: r.communityId, name: r.name, priceCents: r.priceCents,
      billingPeriod: r.billingPeriod, benefits: r.benefits, highlight: r.highlight,
    };
  }

  async listForCommunity(communityId: string): Promise<Tier[]> {
    const rows = await this.db.select().from(tiers)
      .where(eq(tiers.communityId, communityId)).orderBy(asc(tiers.sortOrder));
    return rows.map(DrizzleTierRepository.map);
  }

  async findById(id: string): Promise<Tier | null> {
    const [row] = await this.db.select().from(tiers).where(eq(tiers.id, id)).limit(1);
    return row ? DrizzleTierRepository.map(row) : null;
  }

  async createMany(
    communityId: string,
    input: Array<{ name: string; priceCents: number; billingPeriod: string; benefits: string[]; highlight: boolean }>,
  ): Promise<Tier[]> {
    if (!input.length) return [];
    const rows = await this.db.insert(tiers)
      .values(input.map((t, i) => ({ ...t, communityId, sortOrder: i })))
      .returning();
    return rows.map(DrizzleTierRepository.map);
  }
}

export class DrizzleUploadRepository implements UploadRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    uploaderId: string; filename: string; mime: string;
    sizeBytes: number; storageKey: string; kind: UploadKind;
  }) {
    const [row] = await this.db.insert(uploads).values(input).returning();
    return { id: row!.id, name: row!.filename, kind: row!.kind, url: `/api/uploads/${row!.id}` };
  }

  async findById(id: string) {
    const [row] = await this.db.select({
      id: uploads.id, storageKey: uploads.storageKey, mime: uploads.mime,
      filename: uploads.filename, sizeBytes: uploads.sizeBytes, kind: uploads.kind,
    }).from(uploads).where(eq(uploads.id, id)).limit(1);
    return row ?? null;
  }

  async existingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select({ id: uploads.id }).from(uploads).where(inArray(uploads.id, ids));
    return rows.map((r) => r.id);
  }
}

export function assertFound<T>(value: T | null, what: string): T {
  if (value === null) throw new NotFoundError(what);
  return value;
}
