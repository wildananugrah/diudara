/** One notification as the wire's mapper sees it, with the actor's public fields joined. */
export interface NotificationRow {
  id: string;
  kind: string;
  actorHandle: string;
  actorDisplayName: string;
  postId: string | null;
  /** The community's SLUG, not its id — the client builds a `/komunitas/:slug` link from it. */
  communitySlug: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationRepositoryPort {
  /**
   * Writes one notification.
   *
   * **Its caller must treat a rejection as survivable.** This runs AFTER the
   * action it reports has already committed, and a failure here is logged
   * rather than thrown — a bug in notifications must never fail commenting.
   * See `NotifyOf`, which is the one place that rule is implemented.
   */
  create(input: {
    userId: string;
    kind: string;
    actorId: string;
    postId?: string;
    communityId?: string;
  }): Promise<void>;
  /** Newest first, capped. Includes read ones — the list is a history, not an inbox. */
  listFor(userId: string, limit: number): Promise<NotificationRow[]>;
  /** How many are unread. The query that runs every sixty seconds per signed-in tab. */
  unreadCountFor(userId: string): Promise<number>;
  /**
   * Marks EVERY unread notification read. Not per-row: opening the bell is
   * the act of reading them, and per-row state would be UI nobody asked for
   * over a feature whose job is to stop nagging.
   */
  markAllRead(userId: string): Promise<void>;
}
