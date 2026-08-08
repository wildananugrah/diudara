import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityPatch,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class UpdateCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
    patch: CommunityPatch;
  }): Promise<CommunityRecord> {
    const existing = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!existing) {
      throw new NotFoundError("community not found");
    }

    // Re-saving the community's own slug is fine; taking another's is not.
    if (input.patch.slug && input.patch.slug !== existing.slug) {
      if (await this.communities.slugExists(input.patch.slug)) {
        throw new ConflictError("slug is already taken");
      }
    }

    const updated = await this.communities.update(
      input.communityId,
      input.creatorId,
      input.patch
    );
    if (!updated) {
      throw new NotFoundError("community not found");
    }
    return updated;
  }
}
