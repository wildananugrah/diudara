import type { CommentRepository, PostRepository, UploadRepository } from "../domain/ports.ts";
import type { PostType } from "../domain/types.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { safeHttpUrl } from "../domain/links.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";

const VALID_TYPES: readonly PostType[] = ["diskusi", "pengumuman", "konten", "event", "anggota"];

export type CreatePostInput = {
  type: PostType; title: string; body?: string; tag?: string; topic?: string | null;
  syllabus?: string | null; eventDate?: string | null; eventTime?: string | null;
  eventLocation?: string | null; meetingUrl?: string | null;
  hasLiveRoom?: boolean; inviteTarget?: string | null;
  attachmentIds?: string[];
};

export class PostService {
  constructor(
    private readonly posts: PostRepository,
    private readonly comments: CommentRepository,
    private readonly uploads: UploadRepository,
    private readonly access: AccessPolicy,
  ) {}

  async create(communityId: string, userId: string, input: CreatePostInput) {
    if (!VALID_TYPES.includes(input.type)) throw new ValidationError(`Tipe post tidak valid: ${input.type}`);
    if (!input.title?.trim()) throw new ValidationError("Judul wajib diisi");

    // Authorisation BEFORE the write, and based on the requested type — this is
    // the server-side counterpart of PostEditorModal's availableTypes gate.
    await this.access.canCreatePostType(communityId, userId, input.type);
    await assertUploadsExist(this.uploads, input.attachmentIds);

    return this.posts.create({
      communityId,
      authorId: userId,
      type: input.type,
      tag: input.tag ?? defaultTagFor(input.type),
      topic: input.topic ?? null,
      title: input.title.trim(),
      body: input.body?.trim() ?? "",
      syllabus: input.syllabus ?? null,
      eventDate: input.eventDate ?? null,
      eventTime: input.eventTime ?? null,
      eventLocation: input.eventLocation ?? null,
      meetingUrl: requireMeetingUrl(input.type, input.meetingUrl),
      hasLiveRoom: input.hasLiveRoom ?? false,
      inviteTarget: input.inviteTarget ?? null,
      attachmentIds: input.attachmentIds,
    });
  }

  async get(postId: string, userId: string | null) {
    const post = await this.posts.findById(postId);
    if (!post) throw new NotFoundError("Post");
    await this.access.requireMember(post.communityId, userId);
    return post;
  }

  async update(postId: string, userId: string, patch: Partial<CreatePostInput>) {
    const post = await this.posts.findById(postId);
    if (!post) throw new NotFoundError("Post");
    await this.access.canManagePost(post, userId);

    const { attachmentIds: _unused, type: _typeIsImmutable, ...allowed } = patch;
    if (patch.meetingUrl !== undefined) {
      // Type is immutable on update, so the stored one governs the rule.
      allowed.meetingUrl = requireMeetingUrl(post.type, patch.meetingUrl);
    }
    return this.posts.update(postId, allowed);
  }

  async remove(postId: string, userId: string) {
    const post = await this.posts.findById(postId);
    if (!post) throw new NotFoundError("Post");
    await this.access.canManagePost(post, userId);
    await this.posts.delete(postId);
  }

  async listComments(postId: string, userId: string | null) {
    const post = await this.posts.findById(postId);
    if (!post) throw new NotFoundError("Post");
    await this.access.requireMember(post.communityId, userId);
    return this.comments.listForPost(postId);
  }

  async addComment(postId: string, userId: string, body: string) {
    if (!body?.trim()) throw new ValidationError("Komentar tidak boleh kosong");
    const post = await this.posts.findById(postId);
    if (!post) throw new NotFoundError("Post");
    await this.access.requireMember(post.communityId, userId);
    return this.comments.create({ postId, authorId: userId, body: body.trim() });
  }

  likeComment(commentId: string, userId: string) {
    return this.comments.toggleLike(commentId, userId);
  }
}

/**
 * attachmentIds come straight from the client. Without this check an unknown id
 * reaches the post_attachments FK and surfaces as a raw Postgres error behind a
 * 500; callers deserve a 422 naming the bad reference.
 */
export async function assertUploadsExist(uploads: UploadRepository, ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return;
  const found = new Set(await uploads.existingIds(ids));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError(`Lampiran tidak ditemukan: ${missing.join(", ")}`);
}

/**
 * A meeting link is rendered as an href on a page other members load, so only
 * http(s) is ever accepted — see domain/links.ts for why the scheme matters.
 */
export function requireMeetingUrl(type: PostType, raw: string | null | undefined): string | null {
  const link = raw?.trim();
  if (!link) return null;
  if (type !== "event") throw new ValidationError("Tautan meeting hanya untuk kegiatan");
  const url = safeHttpUrl(link);
  if (!url) throw new ValidationError("Tautan meeting tidak valid. Gunakan URL yang diawali https://");
  return url;
}

function defaultTagFor(type: PostType): string {
  const map: Record<PostType, string> = {
    diskusi: "Diskusi", pengumuman: "Pengumuman", konten: "Materi",
    event: "Kegiatan", anggota: "Anggota",
  };
  return map[type];
}
