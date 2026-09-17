import type { MembershipRepository, SubscriptionRepository, UserRepository } from "../domain/ports.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";

/**
 * Moderation of who belongs to a community. Separate from CommunityService,
 * which reads community content — this writes to people's access and billing.
 */
export class MembershipService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly users: UserRepository,
    private readonly access: AccessPolicy,
  ) {}

  /**
   * Ends a member's access. Owner-only, and never destructive:
   *
   * - The membership is marked churned rather than deleted, so the Creator
   *   Dashboard still counts it in churn rate and shows it in the activity log.
   * - Any subscription is cancelled alongside it, so someone who has lost access
   *   does not keep showing up as a paying subscriber.
   */
  async removeMember(communityId: string, actorId: string, targetUserId: string) {
    await this.access.requireOwner(communityId, actorId);

    if (targetUserId === actorId) {
      // The owner is the only one who can reach this, so self-removal would
      // leave the community with nobody able to administer it.
      throw new ValidationError("Kamu tidak bisa mengeluarkan dirimu sendiri dari komunitas");
    }

    const target = await this.memberships.find(communityId, targetUserId);
    if (!target) {
      // 404 on the membership, not the user: the person exists, they are just
      // not in this community.
      if (!(await this.users.findById(targetUserId))) throw new NotFoundError("Pengguna");
      throw new NotFoundError("Anggota komunitas");
    }

    if (target.role === "owner") {
      throw new ForbiddenError("Pemilik komunitas tidak bisa dikeluarkan");
    }
    if (target.status === "churned") {
      throw new ValidationError("Anggota ini sudah keluar dari komunitas");
    }

    await this.memberships.markChurned(communityId, targetUserId);
    await this.subscriptions.cancelForMember(communityId, targetUserId);
    return { ok: true };
  }
}
