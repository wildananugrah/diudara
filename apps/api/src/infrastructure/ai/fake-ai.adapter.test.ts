import { describe, expect, it } from "bun:test";
import { AiProviderError } from "../../application/ports/ai-provider.port";
import { FakeAiAdapter } from "./fake-ai.adapter";

describe("FakeAiAdapter", () => {
  it("asks a clarifying question and proposes no draft on the first user turn", async () => {
    const adapter = new FakeAiAdapter();

    const turn = await adapter.converse([{ role: "user", content: "Saya mau bikin komunitas desain" }]);

    expect(turn.draft).toBe(null);
    expect(turn.reply.length).toBeGreaterThan(0);
  });

  it("proposes a valid draft once at least two user turns are in the transcript", async () => {
    const adapter = new FakeAiAdapter();

    const turn = await adapter.converse([
      { role: "user", content: "Kelas Desain UI/UX" },
      { role: "assistant", content: "Ceritakan lebih lanjut?" },
      { role: "user", content: "Untuk pemula yang mau belajar Figma" },
    ]);

    expect(turn.draft).not.toBe(null);
    expect(turn.draft?.name).toBe("Kelas Desain UI/UX");
    expect(turn.draft?.category).toBe("Skill Digital");
  });

  it("records every call it was given, in order", async () => {
    const adapter = new FakeAiAdapter();

    await adapter.converse([{ role: "user", content: "a" }]);
    await adapter.converse([{ role: "user", content: "b" }]);

    expect(adapter.conversations.length).toBe(2);
  });

  it("throws AiProviderError(\"unavailable\") once, when failNextConverse is set", async () => {
    const adapter = new FakeAiAdapter();
    adapter.failNextConverse = true;

    try {
      await adapter.converse([{ role: "user", content: "a" }]);
      throw new Error("expected converse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("unavailable");
    }

    // One-shot: the next call succeeds.
    const turn = await adapter.converse([{ role: "user", content: "a" }]);
    expect(turn.reply.length).toBeGreaterThan(0);
  });
});
