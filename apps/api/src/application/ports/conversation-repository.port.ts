/** One conversation as its owner's list sees it, with the OTHER person joined in. */
export interface ConversationRow {
  id: string;
  otherHandle: string;
  otherDisplayName: string;
  /** `null` on a conversation nobody has spoken in yet. */
  lastMessageBody: string | null;
  lastMessageAt: Date | null;
  /** Messages newer than this viewer's read mark that this viewer did not send. */
  unreadCount: number;
}

/** One message, with the sender's handle so the thread can tell sides apart. */
export interface DirectMessageRow {
  id: string;
  senderHandle: string;
  body: string;
  createdAt: Date;
}

export interface ConversationRepositoryPort {
  /**
   * Finds the conversation between these two, in EITHER direction, or creates
   * it.
   *
   * **The canonical ordering lives in the adapter, not in its callers.** A
   * caller that ordered the pair itself is a caller that can forget, and the
   * cost of forgetting is two conversations for one pair, each invisible to
   * the other side. The database's `conversation_ordered_pair` CHECK is the
   * backstop; this method is what stops anybody reaching it.
   *
   * Idempotent: opening a chat with somebody you already have a thread with
   * returns the existing one.
   */
  findOrCreateBetween(a: string, b: string): Promise<{ id: string }>;
  /**
   * The conversation between these two if it exists, in either direction,
   * WITHOUT creating one.
   *
   * Separate from `findOrCreateBetween` because the shared-community gate
   * must only apply to CREATING a thread: reopening one that already exists
   * has to work even after somebody has left the community they met in.
   */
  findBetween(a: string, b: string): Promise<{ id: string } | null>;
  /** Most recently active first. Both sides of every conversation this viewer is in. */
  listFor(viewerId: string): Promise<ConversationRow[]>;
  /**
   * `null` when the id does not exist OR when this viewer is not in it — both
   * are absence to a caller, and the route turns either into the same 404.
   * A 403 would confirm that a conversation with that id exists.
   */
  findParticipating(conversationId: string, viewerId: string): Promise<{ id: string } | null>;
  /** Oldest first — a conversation reads top to bottom, unlike the feed. */
  listMessages(conversationId: string, limit: number): Promise<DirectMessageRow[]>;
  send(conversationId: string, senderId: string, body: string): Promise<DirectMessageRow>;
  /** Moves THIS viewer's read mark to now. The other side's is untouched. */
  markRead(conversationId: string, viewerId: string): Promise<void>;
}
