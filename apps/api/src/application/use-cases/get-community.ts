import { NotFoundError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

/**
 * `GET /communities/:id` — a single community, scoped to the calling creator.
 *
 * Phase 6's five dashboard screens (metrics, activity, members, tiers, channels)
 * each had no way to fetch ONE community, so every one of them refetched the
 * whole list (`GET /communities`) just to find the row it already had the id
 * for. This closes that gap.
 *
 * The ownership check lives entirely in `findByIdForCreator` — see
 * `CommunityRepositoryPort`'s docstring for why there is no unscoped
 * `findById` to accidentally call instead. A stranger's id and a nonexistent
 * id are indistinguishable here, which is the point: both 404, never 403, so
 * a non-owner learns nothing about whether the resource exists.
 */
export class GetCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<CommunityRecord> {
    const community = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!community) {
      throw new NotFoundError("community not found");
    }
    return community;
  }
}
