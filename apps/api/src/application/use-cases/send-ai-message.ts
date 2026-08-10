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
 * most recent messages within `HISTORY_CHARACTER_BUDGET` characters.
 *
 * The conversation's FIRST user message is always retained regardless of
 * age or budget — it carries the niche/business the creator opened with,
 * and losing it under a long conversation is what would visibly degrade a
 * draft proposed many turns later (the model would be answering from a
 * recency window with no memory of what it was originally asked to build).
 * It is not counted against the budget: it is bounded elsewhere already
 * (`MAX_MESSAGE_LENGTH` in routes/ai.ts caps any single message at 4000
 * characters), so keeping it unconditionally cannot itself blow the budget.
 *
 * BEST-EFFORT ALTERNATION — NOT an invariant this function itself guarantees.
 * It tries hard to make the result start with `user` and strictly alternate
 * `user`/`assistant`, because several models proxied through OpenRouter
 * (Anthropic's among them) enforce strict role alternation and reject a
 * request outright otherwise. But `history` can legitimately arrive already
 * ending in TWO consecutive `user` messages — a turn that failed after the
 * user's message was persisted but before any reply (design spec §10: that
 * message is kept, never dropped or retyped) followed by the creator's next
 * attempt — and this function has no way to fix that: `[user, user]` in is
 * `[user, user]` out, unchanged and non-alternating. That is harmless, NOT a
 * bug to chase here: `buildMessages` (ai-prompt.ts) is the function that
 * actually owns this invariant over the assembled list, via its own
 * `collapseConsecutiveSameRole` step (see ai-prompt.ts:83-89) — do not read
 * this docstring as license to delete that step; it is the real guarantor,
 * not a redundant safety net. What follows describes what THIS function
 * does try to do, for the common case where it is sufficient on its own:
 *
 *  A naive "always prepend `first`" implementation would still break even
 * the common case: whether the recency window's own leading message happens
 * to be `user` or `assistant` depends only on where the character budget
 * runs out, so prepending `first` unconditionally can and did produce
 * `["user","user","assistant","user","assistant",…]` on a realistic
 * alternating transcript. The fix:
 *
 *  1. Select the recency window on a TURN BOUNDARY — it may only start at a
 *     `user` message, so a user turn and the assistant reply to it travel
 *     together. If the raw character-budget cutoff lands on an orphaned
 *     `assistant` (its `user` fell just outside the budget), that stranded
 *     assistant is dropped too — this only SHRINKS the window, never grows
 *     it past budget.
 *  2. If `first` already IS the window's own start (a short conversation
 *     that fits in full), nothing is prepended — nothing would need to be.
 *  3. If `first` falls OUTSIDE the window, prepending it verbatim would put
 *     two `user` messages back to back. Instead, the window's OWN leading
 *     `user` message is dropped (the oldest thing in the window, and the
 *     cheapest to lose) and `first` takes its place — what follows it (its
 *     assistant reply) becomes the new second element, so the result still
 *     alternates.
 *
 * Deliberately NOT solved by folding the creator's opening message into the
 * system prompt: creator text must never acquire system-level authority,
 * which is exactly the prompt-injection vector this phase's design is built
 * to avoid (design spec §5.2).
 */
export function boundHistory(history: HistoryMessage[]): HistoryMessage[] {
  if (history.length === 0) {
    return history;
  }

  const rawStart = recencyWindowStart(history);

  const firstIndex = history.findIndex((message) => message.role === "user");
  if (firstIndex === -1) {
    // No user message at all — should not happen in practice (every
    // conversation opens with one, and `SendAiMessage` always appends a
    // user turn before an assistant one). With no `user` to anchor
    // alternation on, there is nothing more principled to do than the plain
    // recency trim.
    return history.slice(rawStart);
  }

  // Snap the window to the nearest `user`-role message at or after
  // `rawStart` — see point 1 above. `windowStart` only ever moves FORWARD
  // (later), so this can shrink the window but never grow it past budget.
  let windowStart = rawStart;
  while (windowStart < history.length && history[windowStart].role !== "user") {
    windowStart++;
  }

  const first = history[firstIndex];
  if (windowStart === firstIndex) {
    // `first` IS the window's own start (point 2) — return it unmodified.
    return history.slice(windowStart);
  }

  // `first` falls outside the window (point 3): prepend it, and drop the
  // window's own leading `user` message so the result keeps alternating
  // instead of running two `user` turns back to back.
  return [first, ...history.slice(windowStart + 1)];
}

/**
 * The raw character-budget cutoff: the earliest index such that
 * `history[index..]`'s content lengths sum to at most
 * `HISTORY_CHARACTER_BUDGET`, walked from the newest message backwards so
 * the messages kept are always the most RECENT ones. Returns
 * `history.length` (an empty window) if even the single most recent message
 * does not fit — defensive only; every message is already bounded well
 * under the budget by `MAX_MESSAGE_LENGTH`/`MAX_REPLY_LENGTH` elsewhere.
 *
 * Deliberately unaware of roles or turn boundaries — `boundHistory` is what
 * snaps this raw cutoff to a `user`-starting turn boundary; keeping that
 * concern out of this function is what makes each piece independently
 * checkable.
 */
function recencyWindowStart(history: HistoryMessage[]): number {
  let windowStart = history.length;
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = history[i].content.length;
    if (used + cost > HISTORY_CHARACTER_BUDGET) {
      break;
    }
    used += cost;
    windowStart = i;
  }
  return windowStart;
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
