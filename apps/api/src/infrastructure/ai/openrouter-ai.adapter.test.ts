import { describe, expect, it } from "bun:test";
import type { CommunityDraft } from "@diudara/shared";
import { AiProviderError } from "../../application/ports/ai-provider.port";
import { OpenRouterAiAdapter } from "./openrouter-ai.adapter";

const DEFAULT_URL = "https://openrouter.ai/api/v1/chat/completions";

function captureFetchRaw(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

function captureFetch(content: string, status = 200) {
  return captureFetchRaw({ choices: [{ message: { content } }] }, status);
}

const CONFIG = { apiKey: "sk-or-v1-SUPERSECRET", model: "test/model" };

const MESSAGES = [
  { role: "user" as const, content: "Aku mau bikin komunitas belajar bisnis online." },
];

const VALID_DRAFT: CommunityDraft = {
  name: "Kelas Bisnis Digital",
  niche: "Bisnis online untuk pemula",
  description:
    "Komunitas untuk pelaku UMKM yang ingin belajar bisnis digital dari nol, dengan sesi " +
    "mentoring rutin dan studi kasus nyata.",
  welcomeMessage: "Selamat datang di Kelas Bisnis Digital! Kami senang kamu bergabung.",
  tiers: [
    { name: "Dasar", priceAmount: 50000, billingCycle: "monthly" },
    { name: "Pro", priceAmount: 150000, billingCycle: "monthly" },
  ],
};

describe("OpenRouterAiAdapter — outgoing request shape", () => {
  it("posts to the default OpenRouter base url with a Bearer auth header", async () => {
    const { calls, fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await adapter.converse({ messages: MESSAGES });

    expect(calls[0].url).toBe(DEFAULT_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-v1-SUPERSECRET");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("respects a custom baseUrl", async () => {
    const { calls, fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({
      ...CONFIG,
      baseUrl: "http://localhost:9999/v1",
      fetchFn,
    });

    await adapter.converse({ messages: MESSAGES });

    expect(calls[0].url).toBe("http://localhost:9999/v1/chat/completions");
  });

  it("sends the model, a numeric temperature, and the message history verbatim — no system prompt of its own", async () => {
    const { calls, fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await adapter.converse({ messages: MESSAGES });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("test/model");
    expect(typeof body.temperature).toBe("number");
    // The adapter supplies NO prompt of its own — see the CONTRACT note on
    // `converse` in openrouter-ai.adapter.ts. `domain/ai-prompt.ts` (a later
    // task) owns the system-role framing, so whatever the caller passes in
    // `messages` must be forwarded exactly as given, in order.
    expect(body.messages).toEqual(MESSAGES);
  });

  it("forwards a caller-supplied system message verbatim rather than adding one of its own", async () => {
    const withSystemPrompt = [
      { role: "system" as const, content: "Balas dalam Bahasa Indonesia. Jangan campur JSON dengan teks." },
      ...MESSAGES,
    ];
    const { calls, fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await adapter.converse({ messages: withSystemPrompt });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.messages).toEqual(withSystemPrompt);
  });

  it("carries an AbortSignal so a hung response cannot hold the chat request open forever", async () => {
    const { calls, fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await adapter.converse({ messages: MESSAGES });

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("OpenRouterAiAdapter — draft parsing, happy paths", () => {
  it("parses a bare JSON draft and returns a fixed, human-readable reply distinct from the JSON", async () => {
    const { fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.draft).toEqual(VALID_DRAFT);
    expect(turn.reply.length).toBeGreaterThan(0);
    // The model's content IS the JSON in this case, per the "never mix prose
    // and JSON" rule the CALLER's system prompt is responsible for (see the
    // CONTRACT note on `converse`) — the reply shown to the creator must
    // never be the raw JSON blob itself.
    expect(turn.reply).not.toContain("{");
  });

  it("strips a ```json fence and still produces a valid draft", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_DRAFT) + "\n```";
    const { fetchFn } = captureFetch(fenced);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.draft).toEqual(VALID_DRAFT);
  });

  it("returns draft: null for a plain conversational reply, and never throws", async () => {
    const reply = "Ceritakan lebih lanjut tentang audiens target komunitasmu.";
    const { fetchFn } = captureFetch(reply);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.draft).toBeNull();
    expect(turn.reply).toBe(reply);
  });

  it("returns draft: null for a refusal, indistinguishable in shape from any other conversational reply", async () => {
    const reply = "Maaf, aku tidak dapat membantu dengan permintaan tersebut.";
    const { fetchFn } = captureFetch(reply);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.draft).toBeNull();
    expect(turn.reply).toBe(reply);
  });
});

describe("OpenRouterAiAdapter — reply length bound (throws, never truncates)", () => {
  it("accepts a conversational reply exactly at the 4000-character bound", async () => {
    const reply = "a".repeat(4000);
    const { fetchFn } = captureFetch(reply);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.reply).toBe(reply);
    expect(turn.draft).toBeNull();
  });

  it("throws — rather than truncating — a conversational reply one character over the bound", async () => {
    const reply = "a".repeat(4001);
    const { fetchFn } = captureFetch(reply);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(AiProviderError);
    // Never silently cut: the thrown message names the bound, not a
    // truncated copy of the offending reply.
    expect(error.message).toContain("4000");
    expect(error.message).not.toBe(reply.slice(0, 4000));
  });

  it("also enforces the bound on the fixed DRAFT_REPLY_TEXT path (defense in depth, even though it is well under the limit)", async () => {
    const { fetchFn } = captureFetch(JSON.stringify(VALID_DRAFT));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.reply.length).toBeLessThanOrEqual(4000);
  });
});

describe("OpenRouterAiAdapter — draft parsing, malformed (must throw, never a partial draft)", () => {
  it("throws when a draft was attempted but the JSON is truncated mid-object", async () => {
    const truncated =
      '{"name":"Kelas Bisnis Digital","niche":"Bisnis online","description":"Komunitas ' +
      'untuk pelaku UMKM","welcomeMessage":"Selamat datang!","tiers":[{"name":"Dasar","price';
    const { fetchFn } = captureFetch(truncated);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws when the JSON is valid but missing a required field (description)", async () => {
    const missingDescription = {
      name: VALID_DRAFT.name,
      niche: VALID_DRAFT.niche,
      welcomeMessage: VALID_DRAFT.welcomeMessage,
      tiers: VALID_DRAFT.tiers,
    };
    const { fetchFn } = captureFetch(JSON.stringify(missingDescription));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws when a tier's price is a string instead of an integer", async () => {
    const stringPrice = {
      ...VALID_DRAFT,
      tiers: [{ name: "Dasar", priceAmount: "50000", billingCycle: "monthly" }],
    };
    const { fetchFn } = captureFetch(JSON.stringify(stringPrice));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws when a tier's price is a non-integer float", async () => {
    const floatPrice = {
      ...VALID_DRAFT,
      tiers: [{ name: "Dasar", priceAmount: 50000.5, billingCycle: "monthly" }],
    };
    const { fetchFn } = captureFetch(JSON.stringify(floatPrice));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws when the draft proposes four tiers", async () => {
    const fourTiers = {
      ...VALID_DRAFT,
      tiers: [
        { name: "Dasar", priceAmount: 50000, billingCycle: "monthly" },
        { name: "Pro", priceAmount: 150000, billingCycle: "monthly" },
        { name: "Plus", priceAmount: 250000, billingCycle: "monthly" },
        { name: "Elite", priceAmount: 500000, billingCycle: "monthly" },
      ],
    };
    const { fetchFn } = captureFetch(JSON.stringify(fourTiers));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("never returns a half-parsed object on any malformed shape above", async () => {
    const fourTiers = {
      ...VALID_DRAFT,
      tiers: [
        { name: "A", priceAmount: 1, billingCycle: "monthly" },
        { name: "B", priceAmount: 1, billingCycle: "monthly" },
        { name: "C", priceAmount: 1, billingCycle: "monthly" },
        { name: "D", priceAmount: 1, billingCycle: "monthly" },
      ],
    };
    const { fetchFn } = captureFetch(JSON.stringify(fourTiers));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    try {
      await adapter.converse({ messages: MESSAGES });
      throw new Error("expected converse() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
    }
  });
});

describe("OpenRouterAiAdapter — malformed API response envelope", () => {
  it("throws on a non-2xx response without leaking the api key", async () => {
    const { fetchFn } = captureFetchRaw({ error: "unauthorized" }, 401);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("SUPERSECRET");
  });

  it("throws when the response body is not valid JSON at all", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("not-json{", { status: 200 });
    };
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it('throws on a 200 with no "choices" array', async () => {
    const { fetchFn } = captureFetchRaw({});
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toContain("choices");
  });

  it('throws on a 200 with an empty "choices" array', async () => {
    const { fetchFn } = captureFetchRaw({ choices: [] });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws on a 200 whose choice carries no message", async () => {
    const { fetchFn } = captureFetchRaw({ choices: [{}] });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws on a 200 whose message has no content, rather than stringifying undefined", async () => {
    const { fetchFn } = captureFetchRaw({ choices: [{ message: {} }] });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(AiProviderError);
    // The Xendit-lesson this whole file is following: never let `String(undefined)`
    // through as if it were success.
    expect(error.message).not.toContain('"undefined"');
  });

  it("throws on a 200 whose content is not a string", async () => {
    const { fetchFn } = captureFetchRaw({ choices: [{ message: { content: 12345 } }] });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });

  it("throws on a 200 whose content is an empty/whitespace-only string", async () => {
    const { fetchFn } = captureFetch("   ");
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
  });
});

describe("OpenRouterAiAdapter — network failure", () => {
  it("throws AiProviderError when the fetch call itself rejects (network error or timeout firing)", async () => {
    const fetchFn = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).not.toContain("SUPERSECRET");
  });
});

describe("OpenRouterAiAdapter — AiProviderError.kind classification", () => {
  // TRANSPORT failures — the provider did not answer usefully at the wire
  // level. SendAiMessage never retries these (retrying would double a hung
  // request's wait past what a reverse proxy holds open).
  it('classifies a network failure / timeout as "unavailable"', async () => {
    const fetchFn = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("unavailable");
  });

  it('classifies a non-2xx response as "unavailable"', async () => {
    const { fetchFn } = captureFetchRaw({ error: "unauthorized" }, 401);
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("unavailable");
  });

  // MALFORMED — the provider DID answer (2xx), but the answer could not be
  // turned into a valid turn. SendAiMessage retries these once.
  it('classifies a 200 response body that is not valid JSON as "malformed"', async () => {
    const fetchFn = async () => new Response("not-json{", { status: 200 });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });

  it('classifies a 200 with no usable "choices" as "malformed"', async () => {
    const { fetchFn } = captureFetchRaw({});
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });

  it('classifies a 200 with no usable message content as "malformed"', async () => {
    const { fetchFn } = captureFetchRaw({ choices: [{ message: {} }] });
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });

  it('classifies an attempted draft that is truncated/invalid JSON as "malformed"', async () => {
    const { fetchFn } = captureFetch('{"name":"truncated');
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });

  it('classifies an attempted draft that fails communityDraftSchema as "malformed"', async () => {
    const missingDescription = {
      name: VALID_DRAFT.name,
      niche: VALID_DRAFT.niche,
      welcomeMessage: VALID_DRAFT.welcomeMessage,
      tiers: VALID_DRAFT.tiers,
    };
    const { fetchFn } = captureFetch(JSON.stringify(missingDescription));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });

  it('classifies a reply over MAX_REPLY_LENGTH as "malformed", per requireBoundedReply\'s own comment', async () => {
    const { fetchFn } = captureFetch("a".repeat(4001));
    const adapter = new OpenRouterAiAdapter({ ...CONFIG, fetchFn });

    const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as AiProviderError;
    expect(error.kind).toBe("malformed");
  });
});

describe("OpenRouterAiAdapter — secret hygiene", () => {
  it("never leaks the api key across any failure mode", async () => {
    const secretConfig = { apiKey: "sk-or-v1-EXTRA-SECRET-VALUE", model: "test/model" };

    const scenarios: { fetchFn: (url: string, init: RequestInit) => Promise<Response> }[] = [
      captureFetchRaw({ error: "unauthorized" }, 401),
      captureFetchRaw({}),
      captureFetch('{"name":"truncated'),
    ];

    for (const { fetchFn } of scenarios) {
      const adapter = new OpenRouterAiAdapter({ ...secretConfig, fetchFn });
      const error = (await adapter.converse({ messages: MESSAGES }).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error.message).not.toContain("EXTRA-SECRET-VALUE");
      expect(JSON.stringify(error)).not.toContain("EXTRA-SECRET-VALUE");
    }
  });
});
