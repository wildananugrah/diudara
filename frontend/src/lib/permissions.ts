import type { ApiPost } from "./api";

/**
 * Mirrors AccessPolicy.canManagePost on the server, which is the real authority.
 * This only decides whether a control is worth rendering — the API refuses the
 * request either way, so a stale copy here can never grant access.
 *
 * Admins manage anything in their community. Everyone else manages only their
 * own diskusi/anggota posts; pengumuman, event and konten are admin-authored,
 * so their authors are already covered by the first rule.
 */
export function canManagePost(
  post: Pick<ApiPost, "type" | "authorId">,
  isAdmin: boolean,
  userId: string | undefined,
): boolean {
  if (isAdmin) return true;
  const ownsIt = Boolean(userId) && post.authorId === userId;
  return ownsIt && (post.type === "diskusi" || post.type === "anggota");
}
