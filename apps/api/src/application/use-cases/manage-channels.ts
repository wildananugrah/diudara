import { NotFoundError } from "../errors";
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
    return this.channels.create({
      communityId: input.communityId,
      platform: input.platform,
      externalGroupId: input.externalGroupId,
    });
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
