import { and, asc, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { communityDocuments, courseLessons, courseSections } from "../../db/schema";
import type {
  LessonRow,
  SectionRow,
  SyllabusRepositoryPort,
} from "../../application/ports/syllabus-repository.port";

/**
 * The ONE projection both lesson read paths select, with the attachment
 * LEFT-joined and filtered to live documents.
 *
 * The `deleted_at IS NULL` predicate sits in the JOIN's ON, not the WHERE. In
 * the WHERE it would drop the LESSON whose document was deleted, rather than
 * the attachment — losing somebody's written lesson because a PDF was tidied
 * away.
 */
const lessonColumns = {
  id: courseLessons.id,
  sectionId: courseLessons.sectionId,
  title: courseLessons.title,
  body: courseLessons.body,
  position: courseLessons.position,
  documentId: communityDocuments.id,
  documentName: communityDocuments.name,
  documentByteSize: communityDocuments.byteSize,
  documentMembersOnly: communityDocuments.membersOnly,
} as const;

function toLessonRow(row: {
  documentMembersOnly: boolean | null;
  [key: string]: unknown;
}): LessonRow {
  return {
    ...(row as unknown as LessonRow),
    // `false` rather than null when there is no attachment: "this lesson has
    // nothing locked" is the honest answer, and a nullable boolean would make
    // every reader write `=== true`.
    documentMembersOnly: row.documentMembersOnly ?? false,
  };
}

export class DrizzleSyllabusRepository implements SyllabusRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  listSections(communityId: string): Promise<SectionRow[]> {
    return this.db
      .select({
        id: courseSections.id,
        title: courseSections.title,
        position: courseSections.position,
      })
      .from(courseSections)
      .where(eq(courseSections.communityId, communityId))
      // TOTAL ordering: `position` first, then `created_at`, then `id`. Two
      // sections at the same position is a state the schema permits, and
      // without the tiebreakers the syllabus reorders itself between page
      // loads — which reads as data loss to whoever is looking at it.
      .orderBy(asc(courseSections.position), asc(courseSections.createdAt), asc(courseSections.id));
  }

  async listLessons(communityId: string): Promise<LessonRow[]> {
    const rows = await this.db
      .select(lessonColumns)
      .from(courseLessons)
      .innerJoin(courseSections, eq(courseSections.id, courseLessons.sectionId))
      .leftJoin(
        communityDocuments,
        and(
          eq(communityDocuments.id, courseLessons.documentId),
          isNull(communityDocuments.deletedAt)
        )
      )
      .where(eq(courseSections.communityId, communityId))
      .orderBy(asc(courseLessons.position), asc(courseLessons.createdAt), asc(courseLessons.id));
    return rows.map(toLessonRow);
  }

  async createSection(input: {
    communityId: string;
    title: string;
    position: number;
  }): Promise<SectionRow> {
    const [row] = await this.db
      .insert(courseSections)
      .values(input)
      .returning({
        id: courseSections.id,
        title: courseSections.title,
        position: courseSections.position,
      });
    return row!;
  }

  async createLesson(input: {
    sectionId: string;
    title: string;
    body: string;
    position: number;
    documentId?: string;
  }): Promise<LessonRow> {
    const [inserted] = await this.db
      .insert(courseLessons)
      .values({
        sectionId: input.sectionId,
        title: input.title,
        body: input.body,
        position: input.position,
        // Spread in only when present — the one rule every insert here
        // follows, so an omitted value keeps the column's NULL default.
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      })
      .returning({ id: courseLessons.id });

    const [row] = await this.db
      .select(lessonColumns)
      .from(courseLessons)
      .leftJoin(
        communityDocuments,
        and(
          eq(communityDocuments.id, courseLessons.documentId),
          isNull(communityDocuments.deletedAt)
        )
      )
      .where(eq(courseLessons.id, inserted!.id));
    if (row === undefined) throw new Error("lesson disappeared immediately after insert");
    return toLessonRow(row);
  }

  async findSectionIn(communityId: string, sectionId: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: courseSections.id })
      .from(courseSections)
      // The community is part of the LOOKUP, not a check after it — a caller
      // cannot forget it, and another community's section is absent rather
      // than refused.
      .where(and(eq(courseSections.id, sectionId), eq(courseSections.communityId, communityId)));
    return row ?? null;
  }

  async findLessonIn(communityId: string, lessonId: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: courseLessons.id })
      .from(courseLessons)
      .innerJoin(courseSections, eq(courseSections.id, courseLessons.sectionId))
      .where(and(eq(courseLessons.id, lessonId), eq(courseSections.communityId, communityId)));
    return row ?? null;
  }

  /**
   * Both statements in ONE transaction: a section deleted with its lessons
   * left behind would leave rows no read path can reach, and the reverse
   * order would violate the foreign key.
   */
  async deleteSection(sectionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(courseLessons).where(eq(courseLessons.sectionId, sectionId));
      await tx.delete(courseSections).where(eq(courseSections.id, sectionId));
    });
  }

  async deleteLesson(lessonId: string): Promise<void> {
    await this.db.delete(courseLessons).where(eq(courseLessons.id, lessonId));
  }
}
