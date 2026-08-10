import type { CommunityDraft } from "@diudara/shared";

/**
 * One turn of chat history sent to the provider. Mirrors `ai_message`'s
 * `role` (`user`/`assistant`) and `content` columns — this port is the
 * boundary between that stored history and whatever a concrete adapter sends
 * over the wire.
 */
export interface AiMessage {
  role: "user" | "assistant";
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
 * A provider call failed: malformed model output, a timeout, or a non-2xx
 * response. Callers catch this specifically (rather than a bare `Error`) to
 * distinguish an expected provider failure — the thing the retry-once policy
 * and the "clear error, conversation preserved" UX both react to — from a
 * programming bug in this codebase.
 *
 * Deliberately flat, unlike `ProviderCallError` in `messaging-provider.port`:
 * that port's outcome classification exists ONLY because a failed grant can
 * leave a live credential at the provider that must not be re-minted. The AI
 * path never writes anything anywhere — the draft is discarded on any
 * failure — so there is no equivalent state to protect and no outcome to
 * classify.
 */
export class AiProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
