import type { AiMessage, AiProviderPort, AiTurn } from "../../application/ports/ai-provider.port";
import { AiProviderError } from "../../application/ports/ai-provider.port";

/**
 * In-memory AI provider for `RELAXED_NODE_ENVS` (see `selectAiProvider` in
 * `bootstrap.ts`) and for tests — the same role `FakePaymentAdapter`/
 * `FakeEmailAdapter` play for their own providers: `bun run dev`/`bun test`
 * must work with no `OPENROUTER_API_KEY` at all.
 *
 * Deterministic on purpose, not "hostile" the way the deleted Phase 7 fake
 * was — this rebuild has no per-day cost cap left to exercise against a
 * hostile fake (see `CoBuilderChat`'s own docstring for why), so there is
 * nothing here that NEEDS an adversarial script. It asks one clarifying
 * question on the first turn, then proposes a draft once the transcript
 * holds at least two user messages, so the whole modal — chat, draft form,
 * create — is exercisable locally without a real key.
 */
export class FakeAiAdapter implements AiProviderPort {
  readonly conversations: AiMessage[][] = [];
  /** One-shot, same shape as `FakePaymentAdapter.failNextInvoice`. */
  failNextConverse = false;

  async converse(messages: AiMessage[]): Promise<AiTurn> {
    this.conversations.push(messages);
    if (this.failNextConverse) {
      this.failNextConverse = false;
      throw new AiProviderError("fake AI provider: converse failed", "unavailable");
    }

    const userTurns = messages.filter((m) => m.role === "user");
    if (userTurns.length < 2) {
      return {
        reply:
          "Menarik! Ceritakan sedikit lagi — komunitas ini tentang apa, dan siapa yang cocok bergabung?",
        draft: null,
      };
    }

    const name = userTurns[0]!.content.trim().slice(0, 60) || "Komunitas Baru";
    return {
      reply: `Baik, sepertinya saya sudah cukup paham. Ini draf komunitas "${name}" — silakan periksa dan ubah sebelum membuatnya.`,
      draft: {
        name,
        category: "Skill Digital",
        description: userTurns.map((m) => m.content).join(" ").slice(0, 300),
        tags: [],
      },
    };
  }
}
