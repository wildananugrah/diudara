import { createCommunitySchema } from "@diudara/shared";
import type { AiMessage, AiProviderPort, AiTurn } from "../../application/ports/ai-provider.port";
import { AiProviderError } from "../../application/ports/ai-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Same reasoning as `XenditPaymentAdapter`'s own constant: bare `fetch` has no
 * timeout, and a hung model response must not hold the chat request open forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Low but not zero — a co-builder that never varies its phrasing reads as canned. */
const TEMPERATURE = 0.2;

/** Bounds a single reply shown in the chat bubble, independent of the draft
 * JSON inside it — a model that starts repeating itself must not grow the
 * transcript (and therefore the NEXT request's cost) without limit. */
const MAX_REPLY_LENGTH = 4000;

const JSON_FENCE = /```json\s*([\s\S]*?)```/gi;

/**
 * !!! UNVERIFIED AGAINST THE LIVE OPENROUTER API !!!
 *
 * Written from OpenRouter's published (OpenAI-compatible) chat-completions
 * documentation without an account, so the request/response shape is an
 * ASSUMPTION — the same honesty `XenditPaymentAdapter` carries for the same
 * reason. The tests below prove the port contract and the fenced-draft
 * parsing; they do NOT prove this works against the live API. Exercise it
 * against a real key before relying on it, then delete this warning.
 *
 * The output contract this adapter parses is `co-builder-prompt.ts`'s own —
 * the two files must change together: a plain conversational reply, and
 * once the model is confident, that reply followed by a fenced ```json
 * block matching `createCommunitySchema`. A block that fails that schema
 * is `AiProviderError("malformed")`, never a `null` draft — the caller
 * decides whether that is worth retrying.
 */
export class OpenRouterAiAdapter implements AiProviderPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: { apiKey: string; model: string; baseUrl?: string; fetchFn?: FetchFn }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
  }

  async converse(messages: AiMessage[]): Promise<AiTurn> {
    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: TEMPERATURE,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A network failure, an abort, or `AbortSignal.timeout` firing —
      // `fetchFn` itself rejects rather than resolving with a response.
      throw new AiProviderError(
        `openrouter converse could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        "unavailable"
      );
    }

    if (!response.ok) {
      throw new AiProviderError(`openrouter converse failed with status ${response.status}`, "unavailable");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError("openrouter converse returned a response that was not JSON", "unavailable");
    }

    const content = this.extractContent(body);
    if (content === null) {
      throw new AiProviderError(
        "openrouter converse returned a response with no usable message content — the " +
          "response shape does not match what this adapter assumes, see the UNVERIFIED " +
          "warning in openrouter-ai.adapter.ts.",
        "unavailable"
      );
    }

    return this.parseTurn(content);
  }

  private extractContent(body: unknown): string | null {
    if (typeof body !== "object" || body === null) return null;
    const choices = (body as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  }

  /**
   * Splits the model's raw text into the human-facing reply and, when
   * present, the trailing draft — see this class's own docstring for the
   * contract. A present-but-invalid fence is `"malformed"`, never a
   * swallowed `null`: the caller (`CoBuilderChat`) is the one that decides
   * whether to retry, and it can only do that if it knows a draft was
   * ATTEMPTED.
   */
  private parseTurn(rawContent: string): AiTurn {
    const matches = [...rawContent.matchAll(JSON_FENCE)];
    const reply = rawContent.replace(JSON_FENCE, "").trim().slice(0, MAX_REPLY_LENGTH);

    if (matches.length === 0) {
      return { reply, draft: null };
    }

    const rawDraft = matches[matches.length - 1]![1]!.trim();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawDraft);
    } catch {
      throw new AiProviderError("openrouter converse's draft block was not valid JSON", "malformed");
    }

    const result = createCommunitySchema.safeParse(parsedJson);
    if (!result.success) {
      throw new AiProviderError(
        `openrouter converse's draft did not match the community schema: ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; ")}`,
        "malformed"
      );
    }

    return { reply, draft: result.data };
  }
}
