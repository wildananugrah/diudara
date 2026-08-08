export interface ChannelRecord {
  id: string;
  communityId: string;
  platform: string;
  externalGroupId: string | null;
  inviteLink: string | null;
  botStatus: string;
}

export interface ChannelRepositoryPort {
  create(input: {
    communityId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord>;
  listByCommunity(communityId: string): Promise<ChannelRecord[]>;
}
