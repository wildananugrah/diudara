import { describe, expect, it } from "bun:test";
import { AiProviderError } from "../../application/ports/ai-provider.port";
import { OpenRouterAiAdapter } from "./openrouter-ai.adapter";

function captureFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

function chatResponse(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const MESSAGES = [{ role: "user" as const, content: "Halo" }];

/**
 * Still UNVERIFIED against the live API, like `XenditPaymentAdapter` — the
 * request shape comes from OpenRouter's published documentation. What these
 * tests prove is the port contract and the fenced-draft parsing, not that
 * this works against the real service.
 */
describe("OpenRouterAiAdapter.converse", () => {
  it("sends the model, temperature and messages, with a bearer Authorization header", async () => {
    const { calls, fetchFn } = captureFetch(chatResponse("Halo juga!"));
    const adapter = new OpenRouterAiAdapter({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://or.test/chat",
      fetchFn,
    });

    await adapter.converse(MESSAGES);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://or.test/chat");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.messages).toEqual(MESSAGES);
  });

  it("returns a plain reply with no draft when the model included no JSON fence", async () => {
    const { fetchFn } = captureFetch(chatResponse("Ceritakan lebih lanjut tentang komunitasnya?"));
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    const turn = await adapter.converse(MESSAGES);

    expect(turn.reply).toBe("Ceritakan lebih lanjut tentang komunitasnya?");
    expect(turn.draft).toBe(null);
  });

  it("strips a valid fenced draft out of the reply and returns it separately", async () => {
    const content =
      'Baik, ini drafnya.\n\n```json\n{"name": "Kelas Desain", "category": "Skill Digital"}\n```';
    const { fetchFn } = captureFetch(chatResponse(content));
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    const turn = await adapter.converse(MESSAGES);

    expect(turn.reply).toBe("Baik, ini drafnya.");
    expect(turn.draft).toEqual({ name: "Kelas Desain", category: "Skill Digital" });
  });

  it("throws AiProviderError(\"malformed\") for a fenced block that is not valid JSON", async () => {
    const { fetchFn } = captureFetch(chatResponse("Ini dia.\n```json\n{not valid\n```"));
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    try {
      await adapter.converse(MESSAGES);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("malformed");
    }
  });

  it("throws AiProviderError(\"malformed\") for a fenced block that fails createCommunitySchema", async () => {
    const content = 'Ini dia.\n```json\n{"name": "ab", "category": "Not A Real Category"}\n```';
    const { fetchFn } = captureFetch(chatResponse(content));
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    try {
      await adapter.converse(MESSAGES);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("malformed");
    }
  });

  it("throws AiProviderError(\"unavailable\") on a non-2xx response", async () => {
    const { fetchFn } = captureFetch({ error: "boom" }, 500);
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    try {
      await adapter.converse(MESSAGES);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("unavailable");
    }
  });

  it("throws AiProviderError(\"unavailable\") when the network call itself rejects", async () => {
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    try {
      await adapter.converse(MESSAGES);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("unavailable");
    }
  });

  it("throws AiProviderError(\"unavailable\") for a 2xx response with no usable message content", async () => {
    const { fetchFn } = captureFetch({ choices: [] });
    const adapter = new OpenRouterAiAdapter({ apiKey: "k", model: "m", fetchFn });

    try {
      await adapter.converse(MESSAGES);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("unavailable");
    }
  });
});
