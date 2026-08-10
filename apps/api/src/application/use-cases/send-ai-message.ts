import type { CommunityDraft } from "@diudara/shared";
import { buildMessages } from "../../domain/ai-prompt";
import { AiUpstreamError, NotFoundError, RateLimitedError } from "../errors";
import { AiProviderError } from "../ports/ai-provider.port";
import type { AiMessage, AiProviderPort } from "../ports/ai-provider.port";
import type {
  AiConversationRecord,
  AiConversationRepositoryPort,
} from "../ports/ai-conversation-repository.port";
import type { AiUsageRepositoryPort } from "../ports/ai-usage-repository.port";
import type { ClockPort } from "../ports/clock.port";

/**
 * Total attempts against the provider for one turn: the first try, plus
 * EXACTLY one retry on malformed/failed output. Never three — an unbounded
 * retry doubles a bill while hiding a broken prompt (plan Task 5, design
 * spec §5.1/§10).
 */
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * One turn of the AI co-builder chat: consume a spend slot, load or start
 * the conversation, talk to the provider, and persist the exchange. Never
 * writes a community, tier or channel — the draft it returns is edited and
 * saved by the creator through the existing `POST /communities` and
 * `POST /communities/:id/tiers` (design spec §2).
 *
 * ORDER OF OPERATIONS, and why it is fixed in this exact sequence:
 *
 *  1. CONSUME A USAGE SLOT FIRST. Over the cap throws `RateLimitedError`
 *     (429) before the conversation is even looked up and before the
 *     provider is called at all — the provider call is the thing that costs
 *     money, so nothing after this point may run without a slot. This is
 *     true even when the request turns out to reference an unknown or
 *     another creator's conversation: the caller's own quota is what pays
 *     for the attempt, regardless of what the attempt turns out to be.
 *  2. LOAD OR CREATE THE CONVERSATION, creator-scoped. An unknown id or
 *     another creator's conversation throws `NotFoundError` (404, never
 *     403) — see `AiConversationRepositoryPort` for why the repository
 *     itself enforces this rather than trusting a pre-check here.
 *  3. APPEND THE USER MESSAGE. Persisted before the provider is ever called,
 *     so a provider failure below still leaves the creator's own words in
 *     the transcript — "the conversation is preserved so the creator can
 *     retry" (design spec §10) means retry by sending another message, not
 *     by losing this one.
 *  4. CALL THE PROVIDER, with the retry-once policy below.
 *  5. APPEND THE ASSISTANT REPLY and return the draft.
 */
export class SendAiMessage {
  constructor(
    private readonly conversations: AiConversationRepositoryPort,
    private readonly usage: AiUsageRepositoryPort,
    private readonly provider: AiProviderPort,
    private readonly clock: ClockPort,
    private readonly config: { dailyLimit: number }
  ) {}

  async execute(input: {
    creatorId: string;
    conversationId: string | null;
    content: string;
  }): Promise<{ conversationId: string; reply: string; draft: CommunityDraft | null }> {
    const usageDate = toUtcDateString(this.clock.now());

    const usageResult = await this.usage.consumeOne({
      creatorId: input.creatorId,
      usageDate,
      dailyLimit: this.config.dailyLimit,
    });
    if (!usageResult.allowed) {
      const resetAt = nextUtcMidnightIso(usageDate);
      throw new RateLimitedError(
        `Batas harian AI co-builder sudah tercapai. Coba lagi setelah ${resetAt}.`,
        resetAt
      );
    }

    const conversation = input.conversationId
      ? await this.requireOwnedConversation(input.conversationId, input.creatorId)
      : await this.conversations.createForCreator(input.creatorId);

    // History fetched BEFORE the append below, so buildMessages's `history`
    // parameter never includes the message it is about to add itself.
    const history = await this.conversations.listMessages(conversation.id, input.creatorId);

    await this.conversations.appendMessage({
      conversationId: conversation.id,
      creatorId: input.creatorId,
      role: "user",
      content: input.content,
    });

    // No cast: `PromptMessage` (domain/ai-prompt.ts) and `AiMessage`
    // (ai-provider.port.ts) are structurally identical by design — see
    // ai-prompt.ts's file docstring — so this assigns with no cast needed.
    const messages: AiMessage[] = buildMessages(history, input.content);
    const turn = await this.converseWithRetry(messages);

    await this.conversations.appendMessage({
      conversationId: conversation.id,
      creatorId: input.creatorId,
      role: "assistant",
      content: turn.reply,
    });

    return { conversationId: conversation.id, reply: turn.reply, draft: turn.draft };
  }

  private async requireOwnedConversation(
    conversationId: string,
    creatorId: string
  ): Promise<AiConversationRecord> {
    const conversation = await this.conversations.findForCreator(conversationId, creatorId);
    if (!conversation) {
      // Deliberately generic: no conversation id, no creator id, no message
      // content. A stranger probing an id learns nothing more than "no".
      throw new NotFoundError("conversation not found");
    }
    return conversation;
  }

  /**
   * Retries the provider call exactly once on ANY `AiProviderError` —
   * malformed output (prose, truncated/invalid JSON, a shape that fails
   * `communityDraftSchema`) and a timeout/5xx alike. `AiProviderError` is
   * deliberately flat (see its class doc in `ai-provider.port.ts`) and
   * carries no discriminator between "the model's output was broken" and
   * "the provider never answered", so this cannot and does not try to treat
   * them differently — both get exactly one retry, then a clear failure.
   * Two attempts total, never three.
   */
  private async converseWithRetry(messages: AiMessage[]) {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.provider.converse({ messages });
      } catch (err) {
        if (!(err instanceof AiProviderError)) {
          throw err;
        }
        if (attempt === MAX_PROVIDER_ATTEMPTS) {
          // Never surface `err.message` (or `err.cause`) verbatim: it is
          // written for a developer reading a log, not for a creator to act
          // on. A fixed, friendly message is what design spec §10 means by
          // "a clear failure".
          throw new AiUpstreamError(
            "AI co-builder tidak bisa merespons dengan benar setelah dicoba dua kali. " +
              "Coba kirim pesan lagi."
          );
        }
      }
    }
    // Unreachable: the loop above always either returns or throws.
    throw new AiUpstreamError("AI co-builder tidak bisa merespons.");
  }
}

/** The UTC calendar day of `date`, as `AiUsageRepositoryPort.consumeOne` expects it. */
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The ISO-8601 instant of the next UTC midnight after `usageDate` (a `YYYY-MM-DD` string). */
function nextUtcMidnightIso(usageDate: string): string {
  const start = new Date(`${usageDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}
