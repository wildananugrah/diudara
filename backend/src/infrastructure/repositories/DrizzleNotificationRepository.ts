import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { notifications } from "../db/schema.ts";
import type { DomainEventType } from "../../domain/events.ts";
import type { Notification, NotificationRepository } from "../../domain/ports.ts";

const toNotification = (r: typeof notifications.$inferSelect): Notification => ({
  id: r.id,
  type: r.type as DomainEventType,
  actorId: r.actorId,
  communityId: r.communityId,
  entityId: r.entityId,
  data: r.data,
  createdAt: r.createdAt,
  readAt: r.readAt,
});

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string; type: DomainEventType; actorId?: string | null;
    communityId?: string | null; entityId?: string | null; data: Record<string, unknown>;
  }): Promise<Notification> {
    const [row] = await this.db.insert(notifications).values(input).returning();
    return toNotification(row!);
  }

  async listForUser(userId: string, filter: { unreadOnly?: boolean; limit: number }) {
    const where = filter.unreadOnly
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId);

    const rows = await this.db.select().from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(filter.limit);
    return rows.map(toNotification);
  }

  async countUnread(userId: string): Promise<number> {
    // Covered by the partial index on (user_id) WHERE read_at IS NULL — this is
    // polled every 30s by every open tab, so it must stay an index-only count.
    const rows = await this.db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return rows.length;
  }

  async markRead(id: string, userId: string): Promise<boolean> {
    // Ownership is part of the WHERE, not a check afterwards: another user's id
    // updates nothing and returns false, which the service reports as a 404.
    const rows = await this.db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    if (rows.length > 0) return true;
    // Already-read is success, not a miss: clicking a read item again is normal.
    const [existing] = await this.db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId))).limit(1);
    return Boolean(existing);
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await this.db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }
}
