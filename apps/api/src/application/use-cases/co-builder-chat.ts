import { ServiceUnavailableError } from "../errors";
import { buildMessages } from "../../domain/co-builder-prompt";
import type { AiProviderPort, AiTurn } from "../ports/ai-provider.port";
import { AiProviderError } from "../ports/ai-provider.port";
import type { CoBuilderMessage } from "@diudara/shared";

/**
 * `POST /communities/co-builder/chat` — one turn of the community-creation
 * co-builder chat.
 *
 * **Nothing here is persisted.** The deleted Phase 7 co-builder kept
 * `ai_conversation`/`ai_message` tables and a DB-arbitrated daily spend cap
 * (`ai_usage`, retired alongside it — see `RateLimitedError`'s own
 * docstring). This rebuild deliberately cuts that corner: the client holds
 * the whole transcript in memory and resends it every turn (`messages`
 * below is the FULL history, not just the newest one), so there is no
 * conversation to resume across a reload and no per-user daily count to
 * enforce server-side. Cost exposure is bounded instead by
 * `coBuilderChatRequestSchema`'s hard cap on message count/length. If real
 * abuse shows up, `ai_usage`'s upsert-with-a-ceiling pattern (findable in
 * git history at the commit that deleted it) is the documented upgrade
 * path — this is a corner cut, not a ruling that one is unnecessary.
 *
 * **The AI never writes to the database.** `draft` is only ever handed back
 * to the caller; the actual `POST /communities` still goes through
 * `CreateCommunity`, completely unchanged, once a human clicks "Buat
 * komunitas" on the (editable) form the draft pre-fills. This use-case's
 * only job is to hold a conversation and propose that draft.
 */
export class CoBuilderChat {
  constructor(private readonly aiProvider: AiProviderPort) {}

  async execute(input: { messages: CoBuilderMessage[] }): Promise<AiTurn> {
    const messages = buildMessages(input.messages);
    try {
      return await this.aiProvider.converse(messages);
    } catch (err) {
      if (!(err instanceof AiProviderError)) throw err;
      if (err.kind === "unavailable") {
        throw new ServiceUnavailableError("Asisten AI sedang tidak tersedia. Coba lagi sebentar lagi.");
      }
      // "malformed" — worth exactly one retry, with a corrective note the
      // model can act on. A SECOND malformed result is not surfaced as an
      // error: the reply text (if any survived past the failed adapter
      // call) is still worth showing, and "keep chatting" is a better
      // outcome than a dead end over a JSON formatting slip.
      try {
        return await this.aiProvider.converse([
          ...messages,
          {
            role: "system",
            content:
              `Balasan Anda sebelumnya gagal: ${err.message}. Coba lagi, dan pastikan blok JSON ` +
              "mengikuti format yang diminta persis, atau jangan sertakan blok JSON sama sekali " +
              "jika belum yakin.",
          },
        ]);
      } catch (retryErr) {
        if (!(retryErr instanceof AiProviderError)) throw retryErr;
        if (retryErr.kind === "unavailable") {
          throw new ServiceUnavailableError("Asisten AI sedang tidak tersedia. Coba lagi sebentar lagi.");
        }
        return {
          reply: "Maaf, saya belum berhasil menyiapkan draf yang valid. Bisa ceritakan lagi dengan kata lain?",
          draft: null,
        };
      }
    }
  }
}
