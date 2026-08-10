/**
 * A conversation the AI co-builder holds with one creator, plus its messages.
 *
 * Conversations hold what a creator typed about their business — a
 * business-sensitive transcript, not a public artifact — so, like every read
 * since Phase 2, they are creator-scoped AT THE REPOSITORY. EVERY method here
 * takes `creatorId`; there is no unscoped variant, and a caller cannot reach
 * another creator's conversation by omitting it. `SendAiMessage` (the use
 * case) turns "not found" from `findForCreator` into a 404 — never 403 — so a
 * stranger probing an id learns nothing about whether it exists.
 *
 * Only `user`/`assistant` messages are ever persisted — `system` is the
 * framing `domain/ai-prompt.ts` prepends per call and is never written to
 * `ai_message` (see `AiMessage`'s docstring in `ai-provider.port.ts`).
 */

export interface AiConversationRecord {
  id: string;
  creatorId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface AiConversationRepositoryPort {
  /** Starts a brand new conversation for `creatorId`. Always succeeds. */
  createForCreator(creatorId: string): Promise<AiConversationRecord>;

  /**
   * Looks up `conversationId`, scoped to `creatorId`. `null` for an unknown
   * id AND for another creator's conversation — the two are indistinguishable
   * on purpose, which is what lets a caller turn either into the same 404.
   */
  findForCreator(conversationId: string, creatorId: string): Promise<AiConversationRecord | null>;

  /**
   * Persists one turn. `creatorId` is re-checked here too, not only by an
   * earlier `findForCreator` call — a caller that skips the check (a bug, not
   * a click) must still be unable to write into a conversation it does not
   * own. Throws `NotFoundError` if `conversationId` does not belong to
   * `creatorId`.
   */
  appendMessage(input: {
    conversationId: string;
    creatorId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<AiMessageRecord>;

  /**
   * The conversation's messages in creation order — the shape
   * `domain/ai-prompt.ts`'s `buildMessages` expects as history. Throws
   * `NotFoundError` if `conversationId` does not belong to `creatorId`, for
   * the same reason `appendMessage` re-checks rather than trusting an earlier
   * lookup.
   */
  listMessages(conversationId: string, creatorId: string): Promise<AiMessageRecord[]>;
}
