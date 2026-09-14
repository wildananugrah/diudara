import type { CommunityRepositoryPort, MyCommunityRow } from "../ports/community-repository.port";

/**
 * `GET /communities/mine` — the sidebar's "Komunitas" submenu. Auth-only:
 * there is no viewer-less version of "communities I've joined". A viewer in
 * none gets an empty list, not an error — the sidebar renders that as its
 * own empty note rather than treating it as a failed read.
 */
export class ListMyCommunities {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: { viewerId: string }): Promise<{ communities: MyCommunityRow[] }> {
    return { communities: await this.communities.listJoinedByMember(input.viewerId) };
  }
}
