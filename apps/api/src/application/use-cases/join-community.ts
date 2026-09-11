import { ConflictError, NotFoundError } from "../errors";
import { NOTIFICATION_KIND, type NotifyOf } from "./notify";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";

/**
 * The exact Bahasa Indonesia 409 for tapping "Keluar" on a community you own.
 */
const OWNER_LEAVE_MESSAGE = "pemilik tidak bisa keluar dari komunitasnya sendiri";

/**
 * `POST /communities/:slug/join` and `DELETE /communities/:slug/join` — ONE
 * use-case for both directions, because the slug lookup and the 404 are
 * identical either way, the same arrangement `FollowUser` uses.
 *
 * **The precondition this class exists to enforce.** An owner leaving their
 * own community would delete the row that makes the community non-empty, and
 * nothing in the schema forbids it: `community_member` has no CHECK tying the
 * owner's row to `community.owner_id`, so the delete would simply succeed and
 * leave a community whose owner is not a member of it. The refusal has to
 * live here, and `join-community.test.ts` asserts the port is never reached.
 *
 * **Idempotent both ways, by design**: a double-tap must not error. Returns
 * the RESULTING state rather than whether a row changed — joining a community
 * you are already in answers `{ member: true }` — which is what makes the
 * response usable straight off the client's optimistic button state.
 */
export class JoinCommunity {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly notify: NotifyOf
  ) {}

  async execute(input: {
    userId: string;
    slug: string;
    action: "join" | "leave";
  }): Promise<{ member: boolean }> {
    const community = await this.communities.findBySlug(input.slug);
    if (!community) {
      throw new NotFoundError("community not found");
    }

    if (input.action === "join") {
      await this.communities.join(community.id, input.userId);
      // AFTER the join, best-effort — see `NotifyOf`. The owner joining their
      // own community reports nothing, which that class decides.
      await this.notify.record({
        userId: community.ownerId,
        kind: NOTIFICATION_KIND.join,
        actorId: input.userId,
        communityId: community.id,
      });
      return { member: true };
    }

    // THE guard this class exists for — see the class docstring. Checked
    // before the delete, never after.
    if (community.ownerId === input.userId) {
      throw new ConflictError(OWNER_LEAVE_MESSAGE);
    }

    await this.communities.leave(community.id, input.userId);
    return { member: false };
  }
}
