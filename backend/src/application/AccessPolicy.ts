import type { MembershipRepository } from "../domain/ports.ts";
import { ADMIN_ONLY_POST_TYPES, isCommunityAdmin, type Membership, type PostType } from "../domain/types.ts";
import { ForbiddenError } from "../domain/errors.ts";

/**
 * All community authorisation lives here, in one place, so a rule cannot be
 * enforced on one route and forgotten on another (SRP).
 *
 * The mockup decides admin-ness client-side with
 * `myCreatedCommunityIds.includes(id)` — a static array a user can trivially
 * change. Nothing in this class trusts anything the client sends.
 */
export class AccessPolicy {
  constructor(private readonly memberships: MembershipRepository) {}

  async membership(communityId: string, userId: string | null): Promise<Membership | null> {
    if (!userId) return null;
    return this.memberships.find(communityId, userId);
  }

  async requireMember(communityId: string, userId: string | null): Promise<Membership> {
    const m = await this.membership(communityId, userId);
    if (!m || m.status !== "active") throw new ForbiddenError("Kamu bukan anggota aktif komunitas ini");
    return m;
  }

  async requireAdmin(communityId: string, userId: string | null): Promise<Membership> {
    const m = await this.membership(communityId, userId);
    if (!isCommunityAdmin(m)) throw new ForbiddenError("Hanya admin komunitas yang bisa melakukan ini");
    return m!;
  }

  /**
   * Stricter than requireAdmin: some actions belong to the one person who owns
   * the community, not to everyone who can moderate it.
   */
  async requireOwner(communityId: string, userId: string | null): Promise<Membership> {
    const m = await this.membership(communityId, userId);
    if (!m || m.status !== "active" || m.role !== "owner") {
      throw new ForbiddenError("Hanya pemilik komunitas yang bisa melakukan ini");
    }
    return m;
  }

  async canCreatePostType(communityId: string, userId: string, type: PostType): Promise<void> {
    if (ADMIN_ONLY_POST_TYPES.includes(type)) {
      await this.requireAdmin(communityId, userId);
      return;
    }
    await this.requireMember(communityId, userId);
  }

  /**
   * Mirrors FeedPostCard's `canManage`, but as the authority rather than a hint:
   * admins manage anything; everyone else only their own diskusi/anggota posts.
   */
  async canManagePost(
    post: { communityId: string; authorId: string; type: PostType },
    userId: string,
  ): Promise<void> {
    const m = await this.membership(post.communityId, userId);
    if (isCommunityAdmin(m)) return;
    const ownsIt = post.authorId === userId && (post.type === "diskusi" || post.type === "anggota");
    if (!ownsIt) throw new ForbiddenError("Kamu tidak bisa mengubah post ini");
  }
}
