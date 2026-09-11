import type {
  NotificationRepositoryPort,
  NotificationRow,
} from "../ports/notification-repository.port";

/** One screen of the bell. Not paged — the bell is a glance, not an archive. */
const DEFAULT_NOTIFICATION_LIMIT = 20;

/**
 * One notification as the wire sees it. Nested HERE, the one place this
 * projection is assembled, exactly as `toPostView` and `toEventView` are.
 *
 * **No href.** `kind` plus the two ids is everything the client needs to build
 * a link, and a URL in a response is a URL that outlives the route it names.
 */
export interface NotificationView {
  id: string;
  kind: string;
  actor: { handle: string; displayName: string };
  postId: string | null;
  communitySlug: string | null;
  read: boolean;
  /** ISO-8601. */
  createdAt: string;
}

export interface NotificationsPage {
  notifications: NotificationView[];
  /**
   * In the SAME response as the list. The bell needs both, and two round
   * trips for one badge is two chances to show a count that disagrees with
   * the list beneath it.
   */
  unreadCount: number;
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    actor: { handle: row.actorHandle, displayName: row.actorDisplayName },
    postId: row.postId,
    communitySlug: row.communitySlug,
    // A BOOLEAN on the wire, not the timestamp. When something was read is
    // nobody's business but the reader's, and the client only ever asks
    // whether.
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `GET /users/me/notifications`. */
export class ListNotifications {
  constructor(private readonly notifications: NotificationRepositoryPort) {}

  async execute(input: { userId: string; limit?: number }): Promise<NotificationsPage> {
    const [rows, unreadCount] = await Promise.all([
      this.notifications.listFor(input.userId, input.limit ?? DEFAULT_NOTIFICATION_LIMIT),
      this.notifications.unreadCountFor(input.userId),
    ]);
    return { notifications: rows.map(toView), unreadCount };
  }
}

/**
 * `POST /users/me/notifications/read`.
 *
 * Marks EVERYTHING read. Opening the bell is the act of reading them, and
 * per-row state would be UI nobody asked for over a feature whose job is to
 * stop nagging.
 */
export class MarkNotificationsRead {
  constructor(private readonly notifications: NotificationRepositoryPort) {}

  async execute(input: { userId: string }): Promise<{ read: true }> {
    await this.notifications.markAllRead(input.userId);
    return { read: true };
  }
}
