import { communityDraftSchema } from "@diudara/shared";
import { AiProviderError } from "../../application/ports/ai-provider.port";
import type { AiMessage, AiProviderPort, AiTurn } from "../../application/ports/ai-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * A chat turn is synchronous and the creator is sitting there watching it
 * (design spec §6), so a hung OpenRouter response must fail with a clear,
 * bounded error rather than hold the request open indefinitely. 60s is
 * roughly double what `XenditPaymentAdapter` allows an invoice call, because a
 * model completion is legitimately slower than a payment API round-trip —
 * but it is still short enough that a creator waiting on a reply gets an
 * answer rather than a spinner forever.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Biases the model toward reliably-valid JSON when it proposes a draft, at
 * the cost of more repetitive phrasing on ordinary conversational turns.
 * UNVERIFIED: no real completion has ever been run against this value — see
 * the class-level warning below.
 */
const TEMPERATURE = 0.2;

/**
 * Sent as the FIRST message on every turn. English instructions (for
 * reliability across models) that require Bahasa Indonesia OUTPUT, and — this
 * part is load-bearing — require the model to send EITHER plain prose OR a
 * single bare/fenced JSON object, never both in the same message.
 *
 * `parseAttemptedDraft` below decides "was a draft attempted" purely from
 * whether the message, once a fence is stripped, starts with `{`. A model
 * that prefixes JSON with an explanatory sentence ("Here's your draft: { ...
 * }") would defeat that heuristic and have a real draft silently read back as
 * a plain conversational reply instead of either a parsed draft or a thrown
 * error. Whether real models actually honour "never mix prose and JSON" is
 * exactly the kind of thing the class-level warning says must be checked
 * against a live model before this is trusted.
 */
const SYSTEM_PROMPT = `You are DIUDARA's community co-builder, helping an Indonesian creator set up a paid online community.

Always reply to the creator in Bahasa Indonesia, in a natural, conversational tone. Ask about their niche, target audience, and pricing before proposing anything.

When — and only when — you have enough information to propose a concrete draft, respond with ONLY a single JSON object matching this exact shape, optionally wrapped in a single \`\`\`json code fence, and nothing else in the message (no preamble, no explanation before or after it):

{
  "name": string, 1-255 characters,
  "niche": string, 1-128 characters,
  "description": string, 1-2000 characters,
  "welcomeMessage": string, 1-1000 characters,
  "tiers": array of 1 to 3 objects, each:
    { "name": string 1-128 characters, "priceAmount": a WHOLE NUMBER of Indonesian Rupiah between 0 and 2000000000 (never a decimal, never a string), "billingCycle": one of "monthly", "quarterly", "yearly" }
}

If you are asking a question, making small talk, or declining the request, reply with plain Bahasa Indonesia text only — never include JSON, and never mix prose with the JSON object in the same message.`;

/**
 * Returned as `reply` whenever a draft was attempted and validated
 * successfully. Per SYSTEM_PROMPT, the model's own message IS the JSON in
 * that case — it must contain nothing else — so it is never fit for display
 * in a chat transcript. This fixed, friendly line stands in for it, the same
 * fixed-string convention `fake-ai.adapter.ts` uses for its own `"draft"`
 * case.
 */
const DRAFT_REPLY_TEXT =
  "Berikut draf komunitas berdasarkan percakapan kita. Silakan tinjau dan ubah sebelum disimpan.";

/**
 * Strips a ```json ... ``` (or bare ``` ... ```) fence if the ENTIRE trimmed
 * message is that fence — the unprompted quirk real models add per the
 * design plan. Deliberately anchored (`^...$`), same regex as
 * `fake-ai.adapter.ts`'s `stripJsonFence`: it assumes the model never mixes
 * prose with a fenced block in one message, which is exactly what
 * SYSTEM_PROMPT instructs and exactly what is unverified against a real
 * model. Not shared between the two files — each adapter stays
 * self-contained, same as `XenditPaymentAdapter`'s private helpers.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * !!! UNVERIFIED AGAINST THE LIVE OPENROUTER API !!!
 *
 * Written from OpenRouter's published OpenAI-compatible chat-completions
 * documentation without an API key — this is now the THIRD unverified
 * adapter after Xendit and Telegram. The tests alongside this file prove the
 * outgoing request shape, the fence-stripping and schema-validation pipeline,
 * and every malformed shape this file anticipates. They do NOT prove a real
 * model behaves the way this file assumes.
 *
 * Before this is exposed to real creators, run it against a real model and
 * check, specifically:
 *   - Does it return valid JSON RELIABLY at TEMPERATURE (0.2) when it
 *     proposes a draft, or does it wander into prose-plus-JSON often enough
 *     that the "starts with `{`" heuristic in `parseAttemptedDraft` below
 *     misses real drafts (see the SYSTEM_PROMPT comment)?
 *   - Does it actually answer in Bahasa Indonesia, unprompted, on every turn
 *     — or does it drift to English after a few exchanges?
 *   - Does it ever refuse something an ordinary Indonesian creator would
 *     consider a normal request (a niche it finds sensitive, a price it
 *     finds unusual), and is that refusal legible to the creator if so?
 *   - Does a caller's retry-once policy (design spec §10) actually rescue a
 *     malformed turn, or does the retry just double the bill on a model that
 *     is reliably bad at the instruction?
 * Exercise all four against a real OpenRouter key before removing this
 * warning.
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

  async converse(input: { messages: AiMessage[] }): Promise<AiTurn> {
    const requestMessages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ];

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: TEMPERATURE,
          messages: requestMessages,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // Network failure, or AbortSignal.timeout firing. `cause` is whatever
      // `fetchFn` throws — a test can construct anything — so it is never
      // included verbatim; only this fixed message is. Neither the url nor
      // the Authorization header (which carries the API key) is ever part of
      // it.
      throw new AiProviderError(
        "openrouter converse: request failed (network error or timeout)",
        { cause }
      );
    }

    const content = await this.readContent(response);
    return this.parseAttemptedDraft(content);
  }

  /**
   * Never includes the request (which carries the Authorization header) or
   * the raw response body in a thrown message — same rule
   * `xendit-payment.adapter.ts` follows, and for the same reason: Phase 2
   * found credentials reaching logs exactly this way.
   */
  private async readContent(response: Response): Promise<string> {
    if (!response.ok) {
      throw new AiProviderError(`openrouter converse failed with status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new AiProviderError(
        "openrouter converse returned a response that was not valid JSON",
        { cause }
      );
    }

    const choices = (body as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AiProviderError(
        'openrouter converse returned a response with no usable "choices" (expected a ' +
          "non-empty array). The response shape does not match what this adapter assumes " +
          "— see the UNVERIFIED warning in openrouter-ai.adapter.ts."
      );
    }

    const message = (choices[0] as { message?: unknown } | null)?.message;
    const content = (message as { content?: unknown } | null)?.content;

    // `String(undefined)` on an unrecognised response is exactly the bug
    // `xendit-payment.adapter.ts`'s `requireString` was written to prevent —
    // a 200 with no usable content must fail loudly, not stringify into the
    // literal "undefined" and be mistaken for a real (empty) reply.
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new AiProviderError(
        'openrouter converse returned a response with no usable "choices[0].message.content" ' +
          "(expected a non-empty string). See the UNVERIFIED warning in " +
          "openrouter-ai.adapter.ts."
      );
    }

    return content;
  }

  /**
   * The parse-or-throw pipeline that IS this adapter's contract with
   * `AiProviderPort`: parsed, schema-conforming data or throw, never raw
   * model text and never a half-parsed object.
   *
   * "Was a draft attempted" is decided purely by whether the content, once a
   * fence is stripped, starts with `{` — see the SYSTEM_PROMPT comment for
   * why that is safe ONLY if the model honours "never mix prose and JSON",
   * which is unverified. Content that does not look like an attempted draft
   * is passed straight through as a legitimate conversational reply
   * (`draft: null`); content that does start with `{` is held to the full
   * JSON.parse + `communityDraftSchema` pipeline and throws on ANY failure —
   * a missing field, a string price, a non-integer price, four tiers,
   * truncated JSON — so malformed output is never mistaken for "no draft was
   * offered", and a broken draft is never handed back as a partial one.
   */
  private parseAttemptedDraft(raw: string): AiTurn {
    const stripped = stripJsonFence(raw);
    const trimmed = stripped.trim();

    if (!trimmed.startsWith("{")) {
      return { reply: trimmed, draft: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new AiProviderError(
        "openrouter converse: model appeared to attempt a draft but the output was not " +
          "valid JSON",
        { cause }
      );
    }

    const result = communityDraftSchema.safeParse(parsed);
    if (!result.success) {
      throw new AiProviderError(
        "openrouter converse: model appeared to attempt a draft but it did not match the " +
          `community draft shape: ${result.error.message}`
      );
    }

    return { reply: DRAFT_REPLY_TEXT, draft: result.data };
  }
}
