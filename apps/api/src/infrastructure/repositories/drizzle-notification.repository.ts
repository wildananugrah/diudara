import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, communities, notifications } from "../../db/schema";
import type {
  NotificationRepositoryPort,
  NotificationRow,
} from "../../application/ports/notification-repository.port";

export class DrizzleNotificationRepository implements NotificationRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    userId: string;
    kind: string;
    actorId: string;
    postId?: string;
    communityId?: string;
  }): Promise<void> {
    await this.db.insert(notifications).values({
      userId: input.userId,
      kind: input.kind,
      actorId: input.actorId,
      // Spread in only when present — the one rule every insert in this repo
      // follows, so an omitted value leaves the column at its NULL default.
      ...(input.postId === undefined ? {} : { postId: input.postId }),
      ...(input.communityId === undefined ? {} : { communityId: input.communityId }),
    });
  }

  /**
   * The actor is INNER-joined (a notification always has one); the community
   * is LEFT-joined, because three of the four kinds have none.
   */
  listFor(userId: string, limit: number): Promise<NotificationRow[]> {
    return this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        actorHandle: appUsers.handle,
        actorDisplayName: appUsers.displayName,
        postId: notifications.postId,
        // The SLUG, not the id: the client's link is `/komunitas/:slug`, and
        // sending an id would make it ask a second time for the name of the
        // thing it was just told about.
        communitySlug: communities.slug,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .innerJoin(appUsers, eq(appUsers.id, notifications.actorId))
      .leftJoin(communities, eq(communities.id, notifications.communityId))
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async unreadCountFor(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(notifications)
      // Rides `notification_user_unread_idx`, which is partial on
      // `read_at IS NULL` — read rows leave it, and they are the
      // overwhelming majority over time.
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return Number(row?.total ?? 0);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      // `read_at IS NULL` in the predicate, so a second call touches no row
      // rather than moving timestamps — idempotent, and it keeps the original
      // read time.
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  }
}
