import type { CommunityDraft } from "@diudara/shared";

/**
 * One turn of chat history sent to the provider. `user`/`assistant` mirror
 * `ai_message`'s `role` and `content` columns exactly — this port is the
 * boundary between that stored history and whatever a concrete adapter sends
 * over the wire.
 *
 * `system` is NOT a stored role: `ai_message` only ever persists `user` and
 * `assistant` turns. It exists here purely so a caller can prepend the
 * framing instructions a concrete adapter needs (Bahasa Indonesia output, the
 * draft JSON shape, the "never mix prose and JSON in one message" rule an
 * adapter's parsing may depend on — see `OpenRouterAiAdapter.converse`)
 * without that prompt ever being written to the database or owned by the
 * adapter itself. An adapter forwards whatever `messages` it is given,
 * verbatim, in order; it supplies no prompt of its own.
 */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The result of one conversational turn.
 *
 * `draft: null` is the LEGITIMATE representation of "the model replied
 * conversationally without proposing a draft" — a clarifying question, small
 * talk, a refusal. It is not an error and callers must not treat it as one.
 *
 * A non-null `draft` has already been parsed and validated against
 * `communityDraftSchema` by the adapter that produced it — never raw model
 * text, never a half-parsed object. See `AiProviderPort.converse`.
 */
export interface AiTurn {
  reply: string;
  draft: CommunityDraft | null;
}

/**
 * A single provider-level conversational turn with an LLM that may propose a
 * community draft.
 *
 * CONTRACT: returns parsed, schema-conforming data or throws. There is no
 * third outcome — an adapter must never return a string that merely LOOKS
 * like it might be JSON, and must never return an object that only partially
 * matches `CommunityDraft`. Malformed output (prose where a draft was
 * attempted, truncated JSON, a shape that fails `communityDraftSchema`) is an
 * `AiProviderError` thrown from inside the adapter, not a value handed back
 * for the caller to inspect.
 *
 * Model output is untrusted data, never instructions — every adapter must
 * Zod-validate and length-bound whatever the provider returns before it
 * leaves the adapter layer.
 */
export interface AiProviderPort {
  converse(input: { messages: AiMessage[] }): Promise<AiTurn>;
}

/**
 * `AiProviderError.kind` — WHY a provider call failed, decided by the
 * adapter at the throw site, because only the adapter knows which branch it
 * is in:
 *
 *  - `"malformed"`   the provider ANSWERED, but what came back could not be
 *    turned into a valid turn: prose where a draft was attempted, truncated
 *    or invalid JSON, a shape that fails `communityDraftSchema`, or (
 *    `OpenRouterAiAdapter` specifically) a reply that exceeded
 *    `MAX_REPLY_LENGTH`. Worth retrying — a fresh completion against the SAME
 *    prompt may not repeat the same mistake, which is exactly what the
 *    retry-once policy (design spec §5.1/§10) is for.
 *  - `"unavailable"` the provider did NOT answer usefully at the TRANSPORT
 *    level: a network failure, `AbortSignal.timeout` firing, or a non-2xx
 *    HTTP status. Retrying immediately is the wrong response — a hung
 *    request has already burned up to `REQUEST_TIMEOUT_MS` (60s at
 *    `OpenRouterAiAdapter`), and retrying doubles that to ~120s, past what a
 *    reverse proxy in front of this API holds a connection open for (nginx
 *    60s, Cloudflare 100s): the creator gets a dead socket instead of a
 *    clear error, having already spent a usage slot. It is also the wrong
 *    thing to do to an upstream already signalling 429/503 — retrying
 *    instantly with no backoff makes that worse, not better.
 *
 * `SendAiMessage` retries ONLY `"malformed"`, and uses this discriminator to
 * pick a different HTTP status for each ("the model produced garbage twice"
 * vs "the provider is down") — see `send-ai-message.ts`'s `converseWithRetry`.
 */
export type AiProviderErrorKind = "malformed" | "unavailable";

/**
 * A provider call failed: malformed model output, or a transport-level
 * failure (timeout / non-2xx). Callers catch this specifically (rather than
 * a bare `Error`) to distinguish an expected provider failure — the thing
 * `kind` classifies further — from a programming bug in this codebase.
 *
 * Unlike `ProviderCallError` in `messaging-provider.port`, this carries no
 * state-protection concern: that port's outcome classification exists ONLY
 * because a failed grant can leave a live credential at the provider that
 * must not be re-minted. The AI path never writes anything anywhere — the
 * draft is discarded on any failure — so `kind` here exists purely to pick
 * the right RESPONSE to the failure (retry vs not, which status code),
 * never to protect any stored state.
 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: AiProviderErrorKind,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
