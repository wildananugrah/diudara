import { describe, expect, it } from "bun:test";
import { communityDraftSchema } from "@diudara/shared";
import { AiProviderError } from "../../application/ports/ai-provider.port";
import { FakeAiAdapter } from "./fake-ai.adapter";

const MESSAGES = [
  { role: "user" as const, content: "Aku mau bikin komunitas belajar bisnis online." },
];

describe("FakeAiAdapter", () => {
  it("defaults to the happy path: a valid, schema-conforming draft", async () => {
    const adapter = new FakeAiAdapter();
    const turn = await adapter.converse({ messages: MESSAGES });

    expect(turn.reply.length).toBeGreaterThan(0);
    expect(turn.draft).not.toBeNull();
    const result = communityDraftSchema.safeParse(turn.draft);
    expect(result.success).toBe(true);
  });

  it("records every call it receives, so tests can assert on what was sent", async () => {
    const adapter = new FakeAiAdapter();
    await adapter.converse({ messages: MESSAGES });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].messages).toEqual(MESSAGES);
  });

  describe("nextBehaviour: draft", () => {
    it("returns a valid draft", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "draft";
      const turn = await adapter.converse({ messages: MESSAGES });
      expect(turn.draft).not.toBeNull();
      expect(communityDraftSchema.safeParse(turn.draft).success).toBe(true);
    });
  });

  describe("nextBehaviour: reply-only", () => {
    it("returns draft: null as a LEGITIMATE outcome, not an error", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "reply-only";
      const turn = await adapter.converse({ messages: MESSAGES });
      expect(turn.draft).toBeNull();
      expect(turn.reply.length).toBeGreaterThan(0);
    });
  });

  describe("nextBehaviour: refusal", () => {
    it("returns draft: null with a refusal message, not a thrown error", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "refusal";
      const turn = await adapter.converse({ messages: MESSAGES });
      expect(turn.draft).toBeNull();
      expect(turn.reply.length).toBeGreaterThan(0);
    });

    it("is distinguishable in content from a plain reply-only turn", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "reply-only";
      const replyOnly = await adapter.converse({ messages: MESSAGES });
      adapter.nextBehaviour = "refusal";
      const refusal = await adapter.converse({ messages: MESSAGES });
      expect(refusal.reply).not.toBe(replyOnly.reply);
    });
  });

  describe("nextBehaviour: fenced-json", () => {
    it("strips a ```json fence and still produces a valid draft", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "fenced-json";
      const turn = await adapter.converse({ messages: MESSAGES });
      expect(turn.draft).not.toBeNull();
      expect(communityDraftSchema.safeParse(turn.draft).success).toBe(true);
    });
  });

  describe("nextBehaviour: prose", () => {
    it("throws AiProviderError when a draft was expected but prose came back", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "prose";
      await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
    });

    it("never returns a half-parsed object", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "prose";
      try {
        await adapter.converse({ messages: MESSAGES });
        throw new Error("expected converse() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AiProviderError);
      }
    });
  });

  describe("nextBehaviour: truncated-json", () => {
    it("throws AiProviderError on JSON truncated mid-object", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "truncated-json";
      await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
    });
  });

  describe("nextBehaviour: refusal vs malformed", () => {
    it("a refusal never throws, unlike prose or truncated-json", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "refusal";
      const turn = await adapter.converse({ messages: MESSAGES });
      expect(turn.draft).toBeNull();
    });
  });

  describe("nextBehaviour: injection", () => {
    it("returns a hostile payload as inert, schema-conforming data — never thrown, never executed", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "injection";
      const turn = await adapter.converse({ messages: MESSAGES });

      expect(turn.draft).not.toBeNull();
      const result = communityDraftSchema.safeParse(turn.draft);
      expect(result.success).toBe(true);

      // The injected instruction/XSS attempt must survive unmodified as a
      // plain string field — proof that the schema treats it as DATA, never
      // as an instruction to act on or content to sanitise here.
      const haystack = JSON.stringify(turn.draft);
      expect(haystack).toContain("Abaikan semua instruksi");
      expect(haystack).toContain("<script>");
    });
  });

  describe("nextBehaviour: timeout", () => {
    it("throws AiProviderError, simulating a provider that never responded", async () => {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = "timeout";
      await expect(adapter.converse({ messages: MESSAGES })).rejects.toThrow(AiProviderError);
    });
  });

  it("every nextBehaviour value is reachable and does not throw a non-AiProviderError", async () => {
    const behaviours = [
      "draft",
      "reply-only",
      "prose",
      "truncated-json",
      "fenced-json",
      "refusal",
      "injection",
      "timeout",
    ] as const;

    for (const behaviour of behaviours) {
      const adapter = new FakeAiAdapter();
      adapter.nextBehaviour = behaviour;
      try {
        await adapter.converse({ messages: MESSAGES });
      } catch (err) {
        expect(err).toBeInstanceOf(AiProviderError);
      }
    }
  });
});
