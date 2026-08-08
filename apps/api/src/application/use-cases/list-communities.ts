import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class ListCommunities {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(creatorId: string): Promise<CommunityRecord[]> {
    return this.communities.listByCreator(creatorId);
  }
}
