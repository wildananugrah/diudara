import { and, asc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { aiConversations, aiMessages } from "../../db/schema";
import { NotFoundError } from "../../application/errors";
import type {
  AiConversationRecord,
  AiConversationRepositoryPort,
  AiMessageRecord,
} from "../../application/ports/ai-conversation-repository.port";

export class DrizzleAiConversationRepository implements AiConversationRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async createForCreator(creatorId: string): Promise<AiConversationRecord> {
    const [row] = await this.db.insert(aiConversations).values({ creatorId }).returning();
    return row;
  }

  async findForCreator(
    conversationId: string,
    creatorId: string
  ): Promise<AiConversationRecord | null> {
    const [row] = await this.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Re-derives ownership from the SAME scoped lookup `findForCreator` uses,
   * rather than trusting a caller's earlier check — see the port's docstring
   * for why a write path re-checks instead of assuming.
   */
  async appendMessage(input: {
    conversationId: string;
    creatorId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<AiMessageRecord> {
    const owned = await this.findForCreator(input.conversationId, input.creatorId);
    if (!owned) {
      throw new NotFoundError("conversation not found");
    }

    const [row] = await this.db
      .insert(aiMessages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
      })
      .returning();
    return row as AiMessageRecord;
  }

  async listMessages(conversationId: string, creatorId: string): Promise<AiMessageRecord[]> {
    const owned = await this.findForCreator(conversationId, creatorId);
    if (!owned) {
      throw new NotFoundError("conversation not found");
    }

    // `asc(id)` is a TIEBREAKER, not the primary key of correctness: `id` is
    // `defaultRandom()` (a v4 UUID), so it carries no relationship to
    // insertion order on its own. What it buys is DETERMINISM: without it,
    // two rows sharing the same `created_at` (impossible today — each
    // `appendMessage` call is its own implicit transaction, so `now()`
    // always advances between them — but not guaranteed for a future
    // batched write) would be returned in whatever order Postgres happens
    // to pick, which can differ across calls and could silently swap a
    // user/assistant pair. `asc(id)` makes that ordering fixed, even though
    // it does not make it CHRONOLOGICALLY correct.
    const rows = await this.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
    return rows as AiMessageRecord[];
  }
}
