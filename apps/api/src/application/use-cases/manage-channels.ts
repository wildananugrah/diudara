import { ConflictError, NotFoundError, UniqueRule, UniqueViolationError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  ChannelRecord,
  ChannelRepositoryPort,
} from "../ports/channel-repository.port";

async function assertOwnsCommunity(
  communities: CommunityRepositoryPort,
  communityId: string,
  creatorId: string
): Promise<void> {
  const community = await communities.findByIdForCreator(communityId, creatorId);
  if (!community) {
    throw new NotFoundError("community not found");
  }
}

export class ConnectChannel {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly channels: ChannelRepositoryPort
  ) {}

  /**
   * Records the channel only. Bot connection and invite-link generation
   * arrive in Phase 4 — botStatus stays "disconnected" until then.
   */
  async execute(input: {
    communityId: string;
    creatorId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);

    try {
      return await this.channels.create({
        communityId: input.communityId,
        platform: input.platform,
        externalGroupId: input.externalGroupId,
      });
    } catch (err) {
      // (platform, external_group_id) is globally unique: a group belongs to at
      // most one community. Phase 4 resolves an inbound group id back to a
      // single community for gating, so a second claim is a conflict, not a
      // second row. The message deliberately does not say WHICH community holds
      // it — that would confirm another creator's setup to a stranger.
      if (err instanceof UniqueViolationError && err.rule === UniqueRule.channelPlatformGroup) {
        throw new ConflictError("this group is already connected to a community");
      }
      throw err;
    }
  }
}

export class ListChannels {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly channels: ChannelRepositoryPort
  ) {}

  async execute(input: {
    communityId: string;
    creatorId: string;
  }): Promise<ChannelRecord[]> {
    await assertOwnsCommunity(this.communities, input.communityId, input.creatorId);
    return this.channels.listByCommunity(input.communityId);
  }
}
