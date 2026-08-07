import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { channels } from "../../db/schema";
import type {
  ChannelRecord,
  ChannelRepositoryPort,
} from "../../application/ports/channel-repository.port";

export class DrizzleChannelRepository implements ChannelRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    communityId: string;
    platform: string;
    externalGroupId: string;
  }): Promise<ChannelRecord> {
    const [row] = await this.db.insert(channels).values(input).returning();
    return row;
  }

  async listByCommunity(communityId: string): Promise<ChannelRecord[]> {
    return this.db.select().from(channels).where(eq(channels.communityId, communityId));
  }
}
