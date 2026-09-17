import type {
  CommunityRepository, DocumentRepository, MembershipRepository, PostRepository,
  QuizRepository, StatsRepository, SyllabusRepository, UploadRepository,
} from "../domain/ports.ts";
import { assertUploadsExist } from "./PostService.ts";
import type { PostType, QuizFormat, SyllabusItemType } from "../domain/types.ts";
import { isCommunityAdmin, LINKABLE_ITEM_TYPES, QUIZ_FORMATS, SYLLABUS_ITEM_TYPES } from "../domain/types.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { parseYouTubeId } from "../domain/youtube.ts";
import { safeHttpUrl } from "../domain/links.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";

export class CommunityService {
  constructor(
    private readonly communities: CommunityRepository,
    private readonly memberships: MembershipRepository,
    private readonly posts: PostRepository,
    private readonly syllabi: SyllabusRepository,
    private readonly quizzes: QuizRepository,
    private readonly documents: DocumentRepository,
    private readonly uploads: UploadRepository,
    private readonly stats: StatsRepository,
    private readonly access: AccessPolicy,
  ) {}

  discover(filter: { q?: string; category?: string; isLive?: boolean }) {
    return this.communities.list(filter);
  }

  categories() { return this.communities.listCategories(); }
  trendingTags() { return this.communities.listTrendingTags(); }

  /** Includes the caller's own role so the UI can render admin controls honestly. */
  async detail(communityId: string, userId: string | null) {
    const community = await this.communities.findById(communityId);
    if (!community) throw new NotFoundError("Komunitas");
    const membership = await this.access.membership(communityId, userId);
    return {
      ...community,
      isMember: membership?.status === "active",
      isAdmin: isCommunityAdmin(membership),
      role: membership?.role ?? null,
    };
  }

  /** Backs the sidebar's two dropdowns in a single request. */
  async mine(userId: string) {
    const memberships = await this.memberships.listForUser(userId);
    const all = await this.communities.list({});
    const byId = new Map(all.map((c) => [c.id, c]));

    const joined = memberships
      .filter((m) => m.status === "active")
      .map((m) => byId.get(m.communityId))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const created = memberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => byId.get(m.communityId))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    return { joined, created };
  }

  async feed(communityId: string, userId: string | null, filter: {
    tag?: string; topic?: string; q?: string; sort?: "terbaru" | "populer"; types?: PostType[];
  }) {
    await this.access.requireMember(communityId, userId);
    return this.posts.list({ communityId, ...filter });
  }

  async members(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    return this.memberships.listMembers(communityId);
  }

  async materi(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    return this.syllabi.listForCommunity(communityId);
  }

  // ---------------------------------------------------------- materi writes
  // Authoring materi is admin-only, matching ADMIN_ONLY_POST_TYPES' treatment of
  // `konten`. Every mutation resolves the owning community from the row itself,
  // so a caller cannot aim an admin token at someone else's silabus.

  async createMateri(communityId: string, userId: string, input: { title: string }) {
    await this.access.requireAdmin(communityId, userId);
    return this.syllabi.createGroup({ communityId, title: requireTitle(input.title) });
  }

  async updateMateri(syllabusId: string, userId: string, patch: { title?: string; sortOrder?: number }) {
    const group = await this.requireGroup(syllabusId, userId);
    const title = patch.title === undefined ? undefined : requireTitle(patch.title);
    return this.syllabi.updateGroup(group.id, { title, sortOrder: patch.sortOrder });
  }

  async deleteMateri(syllabusId: string, userId: string) {
    const group = await this.requireGroup(syllabusId, userId);
    await this.syllabi.deleteGroup(group.id);
  }

  async createMateriItem(
    syllabusId: string,
    userId: string,
    input: { title: string; type: string; duration?: string; uploadId?: string | null; sourceUrl?: string | null },
  ) {
    const group = await this.requireGroup(syllabusId, userId);
    const sourceUrl = requireSource(requireItemType(input.type), input.uploadId, input.sourceUrl);
    await assertUploadsExist(this.uploads, input.uploadId ? [input.uploadId] : undefined);
    return this.syllabi.createItem({
      syllabusId: group.id,
      title: requireTitle(input.title),
      type: requireItemType(input.type),
      duration: input.duration?.trim() ?? "",
      uploadId: input.uploadId ?? null,
      sourceUrl,
    });
  }

  async updateMateriItem(
    itemId: string,
    userId: string,
    patch: {
      title?: string; type?: string; duration?: string; sortOrder?: number;
      uploadId?: string | null; sourceUrl?: string | null;
    },
  ) {
    const item = await this.requireItem(itemId, userId);
    // The patch may not carry a type; the row's own type still governs the rule.
    const effectiveType = patch.type === undefined ? item.type : requireItemType(patch.type);
    const sourceUrl = requireSource(effectiveType, patch.uploadId, patch.sourceUrl);
    // null is meaningful here (detach the file); only a non-empty id needs checking.
    await assertUploadsExist(this.uploads, patch.uploadId ? [patch.uploadId] : undefined);
    return this.syllabi.updateItem(itemId, {
      title: patch.title === undefined ? undefined : requireTitle(patch.title),
      type: patch.type === undefined ? undefined : requireItemType(patch.type),
      duration: patch.duration?.trim(),
      sortOrder: patch.sortOrder,
      uploadId: patch.uploadId,
      sourceUrl: patch.sourceUrl === undefined ? undefined : sourceUrl,
    });
  }

  async deleteMateriItem(itemId: string, userId: string) {
    await this.requireItem(itemId, userId);
    await this.syllabi.deleteItem(itemId);
  }

  // ------------------------------------------------------------------ quiz
  // Reading is member-level (a member may view the quiz and reveal answers);
  // authoring is admin-level, same as the rest of materi.

  async quiz(itemId: string, userId: string | null) {
    const item = await this.syllabi.findItem(itemId);
    if (!item) throw new NotFoundError("Materi");
    await this.access.requireMember(item.communityId, userId);
    return this.quizzes.listForItem(itemId);
  }

  async createQuizQuestion(itemId: string, userId: string, input: QuestionInput) {
    await this.requireItem(itemId, userId);
    return this.quizzes.createQuestion({
      itemId,
      prompt: requirePrompt(input.prompt),
      format: requireFormat(input.format),
      explanation: input.explanation?.trim() || null,
      options: requireOptions(input.options, requireFormat(input.format)),
    });
  }

  async updateQuizQuestion(questionId: string, userId: string, patch: Partial<QuestionInput> & { sortOrder?: number }) {
    const question = await this.quizzes.findQuestion(questionId);
    if (!question) throw new NotFoundError("Soal");
    await this.access.requireAdmin(question.communityId, userId);

    const format = patch.format === undefined ? undefined : requireFormat(patch.format);
    return this.quizzes.updateQuestion(questionId, {
      prompt: patch.prompt === undefined ? undefined : requirePrompt(patch.prompt),
      format,
      explanation: patch.explanation === undefined ? undefined : (patch.explanation?.trim() || null),
      sortOrder: patch.sortOrder,
      // Options are replaced wholesale, so they are validated as a complete set.
      options: patch.options === undefined ? undefined : requireOptions(patch.options, format ?? "multiple_choice"),
    });
  }

  async deleteQuizQuestion(questionId: string, userId: string) {
    const question = await this.quizzes.findQuestion(questionId);
    if (!question) throw new NotFoundError("Soal");
    await this.access.requireAdmin(question.communityId, userId);
    await this.quizzes.deleteQuestion(questionId);
  }

  private async requireGroup(syllabusId: string, userId: string) {
    const group = await this.syllabi.findGroup(syllabusId);
    if (!group) throw new NotFoundError("Silabus");
    await this.access.requireAdmin(group.communityId, userId);
    return group;
  }

  private async requireItem(itemId: string, userId: string) {
    const item = await this.syllabi.findItem(itemId);
    if (!item) throw new NotFoundError("Materi");
    await this.access.requireAdmin(item.communityId, userId);
    return item;
  }

  async documents_(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    return this.documents.listForCommunity(communityId);
  }

  async topics(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    return this.posts.listTopics(communityId);
  }

  /**
   * Detaches a topic from every post in the community. Admin-only: it rewrites
   * other people's posts, even though it never deletes one.
   */
  async deleteTopic(communityId: string, userId: string, topic: string) {
    await this.access.requireAdmin(communityId, userId);
    const name = topic?.trim();
    if (!name) throw new ValidationError("Nama topik kosong");
    const cleared = await this.posts.clearTopic(communityId, name);
    if (cleared === 0) throw new NotFoundError("Topik");
    return { ok: true, cleared };
  }

  /**
   * Renames a topic across every post using it. Renaming onto a name that
   * already exists merges the two, which is the useful behaviour for fixing a
   * duplicate like "trigonometri" vs "Trigonometri".
   */
  async renameTopic(communityId: string, userId: string, from: string, to: string) {
    await this.access.requireAdmin(communityId, userId);
    const oldName = from?.trim();
    const newName = to?.trim();
    if (!oldName) throw new ValidationError("Nama topik kosong");
    if (!newName) throw new ValidationError("Nama topik baru wajib diisi");
    if (oldName === newName) throw new ValidationError("Nama topik tidak berubah");

    const renamed = await this.posts.renameTopic(communityId, oldName, newName);
    if (renamed === 0) throw new NotFoundError("Topik");
    return { ok: true, renamed, topic: newName };
  }

  /** Dashboard is owner/admin only — it exposes revenue. */
  async creatorStats(communityId: string, userId: string | null) {
    await this.access.requireAdmin(communityId, userId);
    return this.stats.forCommunity(communityId);
  }
}

export type QuestionInput = {
  prompt: string;
  format: string;
  explanation?: string | null;
  options: Array<{ text: string; isCorrect: boolean }>;
};

function requirePrompt(raw: string | undefined): string {
  const prompt = raw?.trim();
  if (!prompt) throw new ValidationError("Pertanyaan wajib diisi");
  return prompt;
}

function requireFormat(raw: string | undefined): QuizFormat {
  if (!QUIZ_FORMATS.includes(raw as QuizFormat)) {
    throw new ValidationError(`Format soal tidak valid: ${raw}. Pilih ${QUIZ_FORMATS.join(", ")}.`);
  }
  return raw as QuizFormat;
}

/**
 * A quiz with no correct answer, two correct answers, or a single option is not
 * a quiz — and since nothing grades it yet, a bad set would only be discovered
 * by a member reading it. Reject it at write time instead.
 */
function requireOptions(
  raw: Array<{ text: string; isCorrect: boolean }> | undefined,
  format: QuizFormat,
): Array<{ text: string; isCorrect: boolean }> {
  const options = (raw ?? [])
    .map((o) => ({ text: o.text?.trim() ?? "", isCorrect: o.isCorrect === true }))
    .filter((o) => o.text);

  if (options.length < 2) throw new ValidationError("Butuh minimal 2 pilihan jawaban");
  if (format === "true_false" && options.length !== 2) {
    throw new ValidationError("Soal benar/salah harus punya tepat 2 pilihan");
  }

  const correct = options.filter((o) => o.isCorrect).length;
  if (correct === 0) throw new ValidationError("Tandai satu jawaban yang benar");
  if (correct > 1) throw new ValidationError("Hanya boleh ada satu jawaban benar");

  return options;
}

/**
 * An item has one source: an uploaded file OR a YouTube link. Accepting both
 * would leave the player to guess which one the creator meant.
 *
 * Only YouTube is allowed — a link that cannot be parsed is rejected here rather
 * than stored and rendered as a broken frame later.
 */
function requireSource(
  type: string,
  uploadId: string | null | undefined,
  sourceUrl: string | null | undefined,
): string | null {
  const link = sourceUrl?.trim();
  if (!link) return null;
  if (!LINKABLE_ITEM_TYPES.includes(type as SyllabusItemType)) {
    throw new ValidationError(`Materi tipe "${type}" hanya bisa diisi file unggahan, bukan tautan.`);
  }
  if (uploadId) throw new ValidationError("Pilih salah satu: unggah file atau tautan, bukan keduanya");

  // A video is embedded in a player, so it has to be a source we can embed.
  if (type === "video") {
    if (!parseYouTubeId(link)) {
      throw new ValidationError("Tautan tidak dikenali. Tempel tautan video YouTube, mis. https://youtu.be/xxxxxxxxxxx");
    }
    return link;
  }

  // Audio may be a YouTube link (embedded) or a direct file URL (<audio src>).
  // An e-book is opened in a new tab, so any reachable document URL will do.
  if (parseYouTubeId(link)) return link;

  const url = safeHttpUrl(link);
  if (!url) {
    throw new ValidationError(
      type === "audio"
        ? "Tautan tidak dikenali. Tempel URL audio (mis. https://situs.com/rekaman.mp3) atau tautan YouTube."
        : "Tautan tidak dikenali. Tempel URL dokumen yang diawali https://",
    );
  }
  return url;
}

function requireTitle(raw: string | undefined): string {
  const title = raw?.trim();
  if (!title) throw new ValidationError("Judul wajib diisi");
  return title;
}

/**
 * The Materi tab switches its player chrome on this value, so an unknown type
 * would render a blank card rather than fail loudly. Reject it at the edge.
 */
function requireItemType(raw: string | undefined): SyllabusItemType {
  if (!SYLLABUS_ITEM_TYPES.includes(raw as SyllabusItemType)) {
    throw new ValidationError(`Tipe materi tidak valid: ${raw}. Pilih ${SYLLABUS_ITEM_TYPES.join(", ")}.`);
  }
  return raw as SyllabusItemType;
}
