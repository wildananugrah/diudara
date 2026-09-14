import type { CreateCommunityInput } from "@diudara/shared";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * One turn of the co-builder chat. `draft` is `null` until the model
 * decides it has enough information — see `co-builder-prompt.ts`'s own
 * docstring for the exact output contract every adapter parses against.
 */
export interface AiTurn {
  reply: string;
  draft: CreateCommunityInput | null;
}

/**
 * `"malformed"` — the model included a JSON block but it failed
 * `createCommunitySchema` (bad category, name too short, …). Worth one
 * retry: the model can often correct itself when told what was wrong.
 *
 * `"unavailable"` — the provider itself could not be reached, timed out, or
 * answered with a non-2xx/unparseable response. NOT retried — the same
 * `ServiceUnavailableError` `payments`/`streaming` already use for "this
 * feature is not configured or not reachable on this box" is what the
 * route maps this to.
 */
export class AiProviderError extends Error {
  constructor(message: string, readonly kind: "malformed" | "unavailable") {
    super(message);
    this.name = new.target.name;
  }
}

export interface AiProviderPort {
  converse(messages: AiMessage[]): Promise<AiTurn>;
}
