import type { db as DbClient } from "../../db/client";
import { activityLogs } from "../../db/schema";
import type { ActivityLogRepositoryPort } from "../../application/ports/activity-log-repository.port";

export class DrizzleActivityLogRepository implements ActivityLogRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async record(input: {
    memberId: string | null;
    communityId: string;
    eventType: string;
    metadata?: unknown;
  }): Promise<void> {
    await this.db.insert(activityLogs).values({
      memberId: input.memberId,
      communityId: input.communityId,
      eventType: input.eventType,
      metadata: input.metadata ?? null,
    });
  }
}
