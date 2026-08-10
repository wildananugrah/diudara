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
 * Returned as `reply` whenever a draft was attempted and validated
 * successfully. A caller's system prompt (see the CONTRACT note on
 * `converse` below) must instruct the model to send ONLY the JSON when
 * proposing a draft — nothing else in the message — so the model's own
 * content is never fit for display in a chat transcript in that case. This
 * fixed, friendly line stands in for it, the same fixed-string convention
 * `fake-ai.adapter.ts` uses for its own `"draft"` case.
 */
const DRAFT_REPLY_TEXT =
  "Berikut draf komunitas berdasarkan percakapan kita. Silakan tinjau dan ubah sebelum disimpan.";

/**
 * `reply` is model output rendered directly in the creator's dashboard, so —
 * same rule as the draft path, which is bounded by `communityDraftSchema` —
 * it must be length-bounded before it leaves this adapter. 4000 characters is
 * a judgement call, not a mirrored value: roughly one long chat turn of
 * Indonesian prose, generous enough that a real conversational reply should
 * never hit it, tight enough to stop an unbounded/degenerate completion (a
 * model stuck in a repetition loop, for instance) from reaching the browser.
 *
 * Exceeding it THROWS rather than truncates. Silently cutting a message
 * could leave the creator acting on half an instruction — worse than surfacing
 * nothing — and throwing routes a degenerate completion through the same
 * retry-once policy a caller already applies to malformed drafts, giving it
 * a second chance instead of a mangled first one.
 */
const MAX_REPLY_LENGTH = 4000;

/**
 * Enforces MAX_REPLY_LENGTH on every `reply` this adapter produces, whichever
 * path produced it (a plain conversational turn or the fixed `DRAFT_REPLY_TEXT`
 * on a successful draft parse) — see MAX_REPLY_LENGTH for why this throws
 * instead of truncating.
 */
function requireBoundedReply(reply: string): string {
  if (reply.length > MAX_REPLY_LENGTH) {
    // MALFORMED, not unavailable: the provider answered, the answer is just
    // too big to be a real conversational reply (a repetition loop, most
    // likely). A retry is a fresh completion that may not repeat the loop.
    throw new AiProviderError(
      `openrouter converse: model reply exceeded ${MAX_REPLY_LENGTH} characters ` +
        `(was ${reply.length}) — refusing to forward unbounded model output to the dashboard`,
      "malformed"
    );
  }
  return reply;
}

/**
 * Strips a ```json ... ``` (or bare ``` ... ```) fence if the ENTIRE trimmed
 * message is that fence — the unprompted quirk real models add per the
 * design plan. Deliberately anchored (`^...$`), same regex as
 * `fake-ai.adapter.ts`'s `stripJsonFence`: it assumes the model never mixes
 * prose with a fenced block in one message, which is a property of the
 * CALLER's system prompt (see the CONTRACT note on `converse` below), not of
 * anything this adapter controls. Not shared between the two files — each
 * adapter stays self-contained, same as `XenditPaymentAdapter`'s private
 * helpers.
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
 *     misses real drafts (see the CONTRACT note on `converse`)?
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
 *
 * This adapter supplies NO system prompt of its own — `domain/ai-prompt.ts`
 * (a later task) owns the Bahasa Indonesia framing and the "never mix prose
 * and JSON" instruction the heuristic below depends on. See the CONTRACT note
 * on `converse`.
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

  /**
   * CONTRACT this adapter depends on but does not enforce: whatever
   * `messages` this is called with must already begin with the system-role
   * framing a real completion needs (Bahasa Indonesia output, the draft JSON
   * shape) — this adapter sends `input.messages` to OpenRouter VERBATIM, in
   * order, and supplies no prompt of its own. `domain/ai-prompt.ts` (a later
   * task) owns that prompt so it has exactly one source of truth instead of
   * drifting between this file and wherever else it might otherwise be
   * duplicated.
   *
   * That system prompt carries an obligation this adapter's parsing leans on
   * completely: it MUST instruct the model to send EITHER plain prose OR a
   * single bare/fenced JSON object, never both in the same message.
   * `parseAttemptedDraft` below decides "was a draft attempted" purely from
   * whether the content, once a fence is stripped, starts with `{` — a
   * caller whose prompt allows prose-plus-JSON ("Here's your draft: { ... }")
   * would silently defeat that heuristic, having a real draft read back as a
   * plain reply instead of either succeeding or throwing. Do not remove that
   * instruction from the system prompt without understanding this is why it
   * is there.
   */
  async converse(input: { messages: AiMessage[] }): Promise<AiTurn> {
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
          messages: input.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
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
        "unavailable",
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
      // TRANSPORT: the provider answered but with a failure status — same
      // classification as the fetchFn catch above. Never retried.
      throw new AiProviderError(
        `openrouter converse failed with status ${response.status}`,
        "unavailable"
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      // MALFORMED: a 2xx response whose body could not be parsed as JSON —
      // the provider answered, but with garbage. Worth one retry.
      throw new AiProviderError(
        "openrouter converse returned a response that was not valid JSON",
        "malformed",
        { cause }
      );
    }

    const choices = (body as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      // MALFORMED: a 2xx, valid-JSON response whose SHAPE is still unusable
      // — the provider answered, just not usefully. Worth one retry.
      throw new AiProviderError(
        'openrouter converse returned a response with no usable "choices" (expected a ' +
          "non-empty array). The response shape does not match what this adapter assumes " +
          "— see the UNVERIFIED warning in openrouter-ai.adapter.ts.",
        "malformed"
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
          "openrouter-ai.adapter.ts.",
        "malformed"
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
   * fence is stripped, starts with `{`. This is safe ONLY if the CALLER's
   * system prompt instructs the model to never mix prose and JSON in one
   * message — see the CONTRACT note on `converse` above; this adapter cannot
   * enforce that instruction, only depend on it. Content that does not look
   * like an attempted draft is passed straight through as a legitimate
   * conversational reply (`draft: null`); content that does start with `{` is
   * held to the full JSON.parse + `communityDraftSchema` pipeline and throws
   * on ANY failure — a missing field, a string price, a non-integer price,
   * four tiers, truncated JSON — so malformed output is never mistaken for
   * "no draft was offered", and a broken draft is never handed back as a
   * partial one.
   *
   * Every `reply` this returns — the plain-conversational branch and
   * `DRAFT_REPLY_TEXT` alike — is run through `requireBoundedReply`: `reply`
   * is model output rendered in the dashboard, and it must be length-bounded
   * before it leaves this adapter exactly like the draft path is.
   */
  private parseAttemptedDraft(raw: string): AiTurn {
    const stripped = stripJsonFence(raw);
    const trimmed = stripped.trim();

    if (!trimmed.startsWith("{")) {
      return { reply: requireBoundedReply(trimmed), draft: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new AiProviderError(
        "openrouter converse: model appeared to attempt a draft but the output was not " +
          "valid JSON",
        "malformed",
        { cause }
      );
    }

    const result = communityDraftSchema.safeParse(parsed);
    if (!result.success) {
      throw new AiProviderError(
        "openrouter converse: model appeared to attempt a draft but it did not match the " +
          `community draft shape: ${result.error.message}`,
        "malformed"
      );
    }

    return { reply: requireBoundedReply(DRAFT_REPLY_TEXT), draft: result.data };
  }
}
