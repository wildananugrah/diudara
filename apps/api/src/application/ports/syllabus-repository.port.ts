/** One lesson, with its attachment resolved — or absent, if there is none or it is gone. */
export interface LessonRow {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  position: number;
  /**
   * `null` when the lesson has no attachment OR when the document it names
   * has been soft-deleted since. Both are "there is nothing to offer here",
   * and the read path collapses them so a lesson never renders a broken
   * attachment.
   */
  documentId: string | null;
  documentName: string | null;
  documentByteSize: number | null;
  /** Whether the attached document needs an active subscription. `false` when there is none. */
  documentMembersOnly: boolean;
}

export interface SectionRow {
  id: string;
  title: string;
  position: number;
}

export interface SyllabusRepositoryPort {
  listSections(communityId: string): Promise<SectionRow[]>;
  /**
   * Every lesson of every section of this community, ordered.
   *
   * ONE query for the whole syllabus rather than one per section: a syllabus
   * is a single screen, and a request per section would be a request per
   * section. The caller groups by `sectionId`.
   */
  listLessons(communityId: string): Promise<LessonRow[]>;
  createSection(input: {
    communityId: string;
    title: string;
    position: number;
  }): Promise<SectionRow>;
  createLesson(input: {
    sectionId: string;
    title: string;
    body: string;
    position: number;
    documentId?: string;
  }): Promise<LessonRow>;
  /** `null` when the id does not exist or belongs to another community. */
  findSectionIn(communityId: string, sectionId: string): Promise<{ id: string } | null>;
  /** `null` when the id does not exist or its section belongs to another community. */
  findLessonIn(communityId: string, lessonId: string): Promise<{ id: string } | null>;
  /**
   * Deletes a section AND its lessons, in one transaction.
   *
   * Refusing while lessons remain would make an owner delete a dozen things
   * to remove one, and a lesson left under no section is unreachable by every
   * read path — deleted in effect, but still occupying a row nothing will
   * ever show.
   */
  deleteSection(sectionId: string): Promise<void>;
  deleteLesson(lessonId: string): Promise<void>;
}
