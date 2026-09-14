import { describe, expect, it } from "bun:test";
import { ServiceUnavailableError } from "../errors";
import type { AiMessage, AiProviderPort, AiTurn } from "../ports/ai-provider.port";
import { AiProviderError } from "../ports/ai-provider.port";
import { CoBuilderChat } from "./co-builder-chat";

/** Scripted per-call answers, same shape as this codebase's other hand-written fakes. */
function fakeAiProvider(answers: (AiTurn | AiProviderError)[]): AiProviderPort & { calls: AiMessage[][] } {
  const calls: AiMessage[][] = [];
  let index = 0;
  return {
    calls,
    async converse(messages) {
      calls.push(messages);
      const answer = answers[index++];
      if (answer === undefined) throw new Error("fake AI provider: ran out of scripted answers");
      if (answer instanceof AiProviderError) throw answer;
      return answer;
    },
  };
}

const READY: AiTurn = {
  reply: "Ini drafnya.",
  draft: { name: "Kelas Desain", category: "Skill Digital" },
};

describe("CoBuilderChat", () => {
  it("returns the provider's turn unchanged when it succeeds on the first try", async () => {
    const provider = fakeAiProvider([READY]);
    const useCase = new CoBuilderChat(provider);

    const turn = await useCase.execute({ messages: [{ role: "user", content: "Halo" }] });

    expect(turn).toEqual(READY);
    expect(provider.calls.length).toBe(1);
  });

  it("prepends the system prompt before calling the provider", async () => {
    const provider = fakeAiProvider([READY]);
    const useCase = new CoBuilderChat(provider);

    await useCase.execute({ messages: [{ role: "user", content: "Halo" }] });

    expect(provider.calls[0]![0]!.role).toBe("system");
    expect(provider.calls[0]![1]).toEqual({ role: "user", content: "Halo" });
  });

  it("retries exactly once, with a corrective note, when the provider answers \"malformed\"", async () => {
    const provider = fakeAiProvider([new AiProviderError("bad json", "malformed"), READY]);
    const useCase = new CoBuilderChat(provider);

    const turn = await useCase.execute({ messages: [{ role: "user", content: "Halo" }] });

    expect(turn).toEqual(READY);
    expect(provider.calls.length).toBe(2);
    const retryMessages = provider.calls[1]!;
    expect(retryMessages[retryMessages.length - 1]!.role).toBe("system");
    expect(retryMessages[retryMessages.length - 1]!.content).toContain("bad json");
  });

  it("drops the draft rather than erroring when the provider is \"malformed\" twice", async () => {
    const provider = fakeAiProvider([
      new AiProviderError("bad json", "malformed"),
      new AiProviderError("still bad", "malformed"),
    ]);
    const useCase = new CoBuilderChat(provider);

    const turn = await useCase.execute({ messages: [{ role: "user", content: "Halo" }] });

    expect(turn.draft).toBe(null);
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(provider.calls.length).toBe(2);
  });

  it("throws ServiceUnavailableError immediately on \"unavailable\", never retrying", async () => {
    const provider = fakeAiProvider([new AiProviderError("network down", "unavailable")]);
    const useCase = new CoBuilderChat(provider);

    await expect(useCase.execute({ messages: [{ role: "user", content: "Halo" }] })).rejects.toThrow(
      ServiceUnavailableError
    );
    expect(provider.calls.length).toBe(1);
  });

  it("throws ServiceUnavailableError when the RETRY itself is \"unavailable\"", async () => {
    const provider = fakeAiProvider([
      new AiProviderError("bad json", "malformed"),
      new AiProviderError("network down mid-retry", "unavailable"),
    ]);
    const useCase = new CoBuilderChat(provider);

    await expect(useCase.execute({ messages: [{ role: "user", content: "Halo" }] })).rejects.toThrow(
      ServiceUnavailableError
    );
    expect(provider.calls.length).toBe(2);
  });
});
