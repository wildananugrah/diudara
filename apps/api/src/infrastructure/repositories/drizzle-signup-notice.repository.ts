import { and, eq, gte, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { signupNotices } from "../../db/schema";
import type { SignupNoticeRepositoryPort } from "../../application/ports/signup-notice-repository.port";

export class DrizzleSignupNoticeRepository implements SignupNoticeRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /** Backed by `signup_notice_user_created_idx` (`userId`, `createdAt`) — see the port's own docstring. */
  async countForUserSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(signupNotices)
      .where(and(eq(signupNotices.userId, userId), gte(signupNotices.createdAt, since)));
    return row?.count ?? 0;
  }

  async record(userId: string): Promise<void> {
    await this.db.insert(signupNotices).values({ userId });
  }
}
