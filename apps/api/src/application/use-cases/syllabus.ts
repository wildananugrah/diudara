import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  LessonRow,
  SyllabusRepositoryPort,
} from "../ports/syllabus-repository.port";

const MAX_TITLE_LENGTH = 160;

export interface LessonView {
  id: string;
  title: string;
  body: string;
  position: number;
  /**
   * `null` when the lesson has nothing attached, or when the document it
   * named has been deleted since. The two collapse on purpose: both mean
   * there is nothing to offer, and a lesson must never render a broken
   * attachment.
   */
  attachment: {
    documentId: string;
    name: string;
    byteSize: number;
    /** `true` when an active subscription is needed. The GATE is the document's, not this phase's. */
    membersOnly: boolean;
  } | null;
}

export interface SectionView {
  id: string;
  title: string;
  position: number;
  lessons: LessonView[];
  /**
   * The REAL count, computed. The reference shows "6 materi" per week; a
   * stored column would be a second source of truth that drifts the first
   * time a lesson is added by a path that forgets it.
   */
  lessonCount: number;
}

function toLessonView(row: LessonRow): LessonView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    position: row.position,
    attachment:
      row.documentId === null
        ? null
        : {
            documentId: row.documentId,
            name: row.documentName ?? "",
            byteSize: row.documentByteSize ?? 0,
            membersOnly: row.documentMembersOnly,
          },
  };
}

/**
 * `GET /communities/:slug/syllabus` — the whole tree in one response.
 *
 * A syllabus is one screen, so a request per section would be a request per
 * section. Bodies are included: a lesson body is a paragraph or two, and a
 * round trip per click for a few kilobytes is worse than sending them once.
 *
 * **Reading is OPEN**, like the feed, the calendar, the document list and the
 * tier offer — Phase 1's argument that a community must be evaluable before
 * joining. The paid material is the ATTACHED DOCUMENT, whose gate is Phase
 * 4a's and is not restated here.
 */
export class GetSyllabus {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly syllabus: SyllabusRepositoryPort
  ) {}

  async execute(input: { slug: string }): Promise<{ sections: SectionView[] }> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    const [sections, lessons] = await Promise.all([
      this.syllabus.listSections(community.id),
      // ONE query for every lesson of every section, grouped below — not one
      // query per section.
      this.syllabus.listLessons(community.id),
    ]);

    const bySection = new Map<string, LessonView[]>();
    for (const lesson of lessons) {
      const existing = bySection.get(lesson.sectionId);
      if (existing === undefined) bySection.set(lesson.sectionId, [toLessonView(lesson)]);
      else existing.push(toLessonView(lesson));
    }

    return {
      sections: sections.map((section) => {
        const own = bySection.get(section.id) ?? [];
        return {
          id: section.id,
          title: section.title,
          position: section.position,
          lessons: own,
          lessonCount: own.length,
        };
      }),
    };
  }
}

/**
 * Authoring — **an authorisation wrapper**, the shape `CreateCommunityPost`
 * and `ManageCommunityTiers` established. Owner-only, the branch
 * `pengumuman`, `kegiatan` and tier management already take.
 */
export class ManageSyllabus {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly syllabus: SyllabusRepositoryPort
  ) {}

  async createSection(input: {
    slug: string;
    ownerId: string;
    title: string;
    position: number;
  }) {
    const community = await this.requireOwner(input.slug, input.ownerId);
    return this.syllabus.createSection({
      communityId: community.id,
      title: requireTitle(input.title),
      position: input.position,
    });
  }

  async createLesson(input: {
    slug: string;
    ownerId: string;
    sectionId: string;
    title: string;
    body: string;
    position: number;
    documentId?: string;
  }): Promise<LessonView> {
    const community = await this.requireOwner(input.slug, input.ownerId);
    // The section must be THIS community's. Without it an owner could hang a
    // lesson off somebody else's syllabus, which no read path would ever show
    // them and every read path would show its real owner.
    const section = await this.syllabus.findSectionIn(community.id, input.sectionId);
    if (section === null) throw new NotFoundError("bagian tidak ditemukan");

    const body = input.body.trim();
    if (body.length === 0) throw new ValidationError("Isi materi tidak boleh kosong.");

    return toLessonView(
      await this.syllabus.createLesson({
        sectionId: section.id,
        title: requireTitle(input.title),
        body,
        position: input.position,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      })
    );
  }

  async deleteSection(input: { slug: string; ownerId: string; sectionId: string }) {
    const community = await this.requireOwner(input.slug, input.ownerId);
    const section = await this.syllabus.findSectionIn(community.id, input.sectionId);
    if (section === null) throw new NotFoundError("bagian tidak ditemukan");
    await this.syllabus.deleteSection(section.id);
    return { deleted: true as const };
  }

  async deleteLesson(input: { slug: string; ownerId: string; lessonId: string }) {
    const community = await this.requireOwner(input.slug, input.ownerId);
    const lesson = await this.syllabus.findLessonIn(community.id, input.lessonId);
    if (lesson === null) throw new NotFoundError("materi tidak ditemukan");
    await this.syllabus.deleteLesson(lesson.id);
    return { deleted: true as const };
  }

  /**
   * The slug resolves FIRST, so an unknown one is always a 404 and never a
   * 403 — a 403 on a slug that does not exist confirms to a probe which
   * slugs do.
   */
  private async requireOwner(slug: string, ownerId: string) {
    const community = await this.communities.findBySlug(slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");
    if (community.ownerId !== ownerId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh mengelola materi");
    }
    return community;
  }
}

function requireTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0) throw new ValidationError("Judul tidak boleh kosong.");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`Judul maksimal ${MAX_TITLE_LENGTH} karakter.`);
  }
  return title;
}
