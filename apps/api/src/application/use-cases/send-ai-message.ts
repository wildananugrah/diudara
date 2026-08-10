import type { CommunityDraft } from "@diudara/shared";
import { buildMessages, type HistoryMessage } from "../../domain/ai-prompt";
import { AiUpstreamError, NotFoundError, RateLimitedError, ServiceUnavailableError } from "../errors";
import { AiProviderError } from "../ports/ai-provider.port";
import type { AiMessage, AiProviderPort } from "../ports/ai-provider.port";
import type {
  AiConversationRecord,
  AiConversationRepositoryPort,
} from "../ports/ai-conversation-repository.port";
import type { AiUsageRepositoryPort } from "../ports/ai-usage-repository.port";
import type { ClockPort } from "../ports/clock.port";

/**
 * Total attempts against the provider for one turn: the first try, plus AT
 * MOST one retry, and ONLY when the failure was classified `"malformed"` —
 * see `converseWithRetry`. Never three — an unbounded retry doubles a bill
 * while hiding a broken prompt (plan Task 5, design spec §5.1/§10).
 */
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * The character budget `boundHistory` keeps the PRIOR transcript within
 * before it is sent to the provider on every turn. 24000 is a judgement
 * call, not a mirrored value — generous enough for a long real onboarding
 * conversation, small enough to keep a capped day's spend roughly LINEAR in
 * turn count rather than quadratic (see `boundHistory`'s docstring for the
 * arithmetic this exists to fix).
 */
const HISTORY_CHARACTER_BUDGET = 24_000;

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
 *  4. CALL THE PROVIDER, with the retry policy below.
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
        `Batas harian AI co-builder sudah tercapai. Coba lagi setelah ${formatResetTimeWib(resetAt)}.`,
        resetAt
      );
    }

    // `!== null`, not truthy: `conversationId: ""` must be treated as an id
    // to look up (and 404 on) rather than silently read as "no id given,
    // start a new conversation". Unreachable through the HTTP route today —
    // `sendMessageSchema` 400s on a non-UUID string before this ever runs —
    // but the use case's own contract should not depend on that.
    const conversation =
      input.conversationId !== null
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
    const messages: AiMessage[] = buildMessages(boundHistory(history), input.content);
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
   * Retries the provider call AT MOST once, and ONLY when the failure is
   * classified `AiProviderError.kind === "malformed"` — the provider
   * answered, but with garbage a fresh completion against the same prompt
   * may not repeat.
   *
   * A `kind === "unavailable"` failure (network error, timeout, non-2xx) is
   * NEVER retried: `OpenRouterAiAdapter` already burns up to
   * `REQUEST_TIMEOUT_MS` (60s) waiting once, and retrying would double that
   * to ~120s — past what a reverse proxy in front of this API holds a
   * connection open for (nginx 60s, Cloudflare 100s), so the creator would
   * get a dead socket instead of this clear error, having already spent a
   * usage slot for nothing. It is also the wrong response to an upstream
   * already signalling 429/503 with no backoff.
   *
   * The two failure classes surface as different statuses so the dashboard
   * can eventually tell them apart: `ServiceUnavailableError` (503, "the
   * provider is down, try again shortly") for `"unavailable"`, versus
   * `AiUpstreamError` (502, "the model produced garbage twice") once a
   * `"malformed"` retry is exhausted.
   */
  private async converseWithRetry(messages: AiMessage[]) {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.provider.converse({ messages });
      } catch (err) {
        if (!(err instanceof AiProviderError)) {
          throw err;
        }

        if (err.kind === "unavailable") {
          throw new ServiceUnavailableError(
            "AI co-builder sedang tidak bisa dihubungi. Coba lagi dalam beberapa saat."
          );
        }

        // kind === "malformed": worth one retry.
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

/**
 * Bounds the PRIOR transcript sent to the provider on every turn.
 *
 * Without this, `listMessages` returns the WHOLE conversation and
 * `buildMessages` sends every prior turn back every time — turn 50 carries
 * all 49 messages before it, so spend inside one capped day grows with the
 * SQUARE of turn count: a `dailyLimit` of 50 is nearer 50×49/2 ≈ 1225 "units"
 * of provider spend than 50 (finding from review). This keeps it linear: the
 * most recent messages within `HISTORY_CHARACTER_BUDGET` characters, walked
 * from the newest backwards so the messages kept are always the most
 * RECENT ones, not the oldest.
 *
 * The conversation's FIRST user message is always retained regardless of
 * age or budget — it carries the niche/business the creator opened with,
 * and losing it under a long conversation is what would visibly degrade a
 * draft proposed many turns later (the model would be answering from a
 * recency window with no memory of what it was originally asked to build).
 * It is not counted against the budget: it is bounded elsewhere already
 * (`MAX_MESSAGE_LENGTH` in routes/ai.ts caps any single message at 4000
 * characters), so keeping it unconditionally cannot itself blow the budget.
 */
export function boundHistory(history: HistoryMessage[]): HistoryMessage[] {
  if (history.length === 0) {
    return history;
  }

  const first = history.find((message) => message.role === "user");

  const recent: HistoryMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === first) {
      continue; // handled separately, retained unconditionally below
    }
    const cost = message.content.length;
    if (used + cost > HISTORY_CHARACTER_BUDGET) {
      break;
    }
    recent.unshift(message);
    used += cost;
  }

  return first ? [first, ...recent] : recent;
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

/** Asia/Jakarta — WIB, UTC+7, no daylight saving — the clock every creator reads. */
const WIB_TIME_ZONE = "Asia/Jakarta";

/**
 * Renders `resetAtIso` (a UTC instant) the way an Indonesian creator reads a
 * clock, for the HUMAN-READABLE half of the 429 message only.
 * `RateLimitedError.resetAt` itself stays the raw UTC ISO-8601 string — the
 * dashboard formats that however it likes — this is purely so the Indonesian
 * sentence does not show a raw UTC instant to someone whose cap actually
 * resets at 07:00 WIB, not midnight.
 */
function formatResetTimeWib(resetAtIso: string): string {
  const date = new Date(resetAtIso);
  const datePart = new Intl.DateTimeFormat("id-ID", {
    timeZone: WIB_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("id-ID", {
    timeZone: WIB_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${datePart} pukul ${timePart} WIB`;
}
