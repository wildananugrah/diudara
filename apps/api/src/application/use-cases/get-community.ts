import { NotFoundError } from "../errors";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import { toCommunityDetail, type CommunityDetail } from "./community-detail";

/**
 * `GET /communities/:slug` — public, unauthenticated, and answering the same
 * shape `CreateCommunity` returns so the client renders one component either
 * way.
 *
 * `viewerId` is the caller's id if signed in and `null` if anonymous,
 * resolved by the route the way the public profile routes resolve theirs. It
 * decides `viewerIsMember` and `viewerIsOwner` alone and never gates whether
 * the community is returned.
 *
 * **A signed-out viewer gets `null`, not `false`** — see `CommunityDetail`'s
 * own docstring for why the two must stay distinct. It also means no
 * membership query runs for an anonymous read; there is no id to ask about.
 */
export class GetCommunity {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly communities: CommunityRepositoryPort
  ) {}

  async execute(input: { slug: string; viewerId: string | null }): Promise<CommunityDetail> {
    const community = await this.communities.findBySlug(input.slug);
    if (!community) {
      throw new NotFoundError("community not found");
    }

    const [memberCount, owner, liveByOwner, prices] = await Promise.all([
      this.communities.memberCountFor(community.id),
      this.users.findById(community.ownerId),
      this.communities.liveByOwner([community.ownerId]),
      this.communities.cheapestActivePrices([community.id]),
    ]);
    if (!owner) {
      // The foreign key makes this unreachable short of a manual delete;
      // answering 404 rather than throwing a TypeError keeps a broken row
      // from becoming a 500 on a public page.
      throw new NotFoundError("community not found");
    }

    const viewerIsMember =
      input.viewerId === null ? null : await this.communities.isMember(community.id, input.viewerId);

    return toCommunityDetail({
      community,
      memberCount,
      live: liveByOwner.get(community.ownerId) ?? null,
      price: prices.get(community.id) ?? null,
      ownerHandle: owner.handle,
      ownerDisplayName: owner.displayName,
      viewerIsMember,
      viewerIsOwner: input.viewerId !== null && input.viewerId === community.ownerId,
    });
  }
}
