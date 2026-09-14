import { COMMUNITY_CATEGORIES } from "@diudara/shared";
import type { AiMessage } from "../application/ports/ai-provider.port";

/**
 * The co-builder's whole contract with the model, in one string. Lists the
 * six real categories BY NAME rather than trusting the model to know them —
 * `OpenRouterAiAdapter` validates whatever comes back against
 * `createCommunitySchema` regardless, but a model that never heard the exact
 * strings has no chance of matching one.
 *
 * The output shape (plain reply, optionally followed by a fenced ```json
 * draft) is deliberately the SAME contract the adapter parses — see its own
 * docstring — so this prompt and that parser must change together.
 */
export const SYSTEM_PROMPT = `Anda adalah asisten yang membantu seseorang membuat komunitas baru di Diudara, sebuah platform komunitas berbayar di Indonesia.

Ajak pengguna bercakap-cakap secara natural dalam Bahasa Indonesia untuk mengumpulkan informasi berikut:
- Nama komunitas (wajib, 3-120 karakter)
- Kategori (wajib, harus PERSIS salah satu dari: ${COMMUNITY_CATEGORIES.map((c) => `"${c}"`).join(", ")})
- Deskripsi singkat (opsional, maksimal 300 karakter)
- Beberapa tag/kata kunci (opsional, maksimal 5 tag)

Jangan bertanya semuanya sekaligus — ajukan satu atau dua pertanyaan per giliran, dan simpulkan sendiri kategori yang paling cocok dari apa yang diceritakan pengguna alih-alih memaksa mereka memilih dari daftar.

Begitu Anda yakin memiliki nama dan kategori yang valid (deskripsi dan tag boleh kosong), akhiri balasan Anda dengan blok kode berikut, PERSIS dalam format ini, berisi HANYA JSON (tanpa komentar), setelah kalimat konfirmasi biasa ke pengguna:

\`\`\`json
{"name": "...", "category": "...", "description": "...", "tags": ["...", "..."]}
\`\`\`

Jangan pernah menyertakan blok JSON ini sampai Anda benar-benar yakin — jika masih ada yang kurang jelas, tanyakan dulu tanpa blok JSON.`;

/**
 * Prepends the system prompt and collapses accidental consecutive
 * same-role entries — a defensive guarantee, not a real invariant this
 * codebase's own callers are expected to violate. The client sends the
 * whole transcript on every turn (see `CoBuilderChat`'s own docstring for
 * why nothing here is persisted), so a retry, a double-submit, or a future
 * caller with a bug could hand this two `user` messages in a row; most
 * chat-completion providers, OpenRouter included, treat that as malformed
 * input.
 */
export function buildMessages(history: AiMessage[]): AiMessage[] {
  const collapsed: AiMessage[] = [];
  for (const message of history) {
    const last = collapsed[collapsed.length - 1];
    if (last !== undefined && last.role === message.role) {
      collapsed[collapsed.length - 1] = { role: last.role, content: `${last.content}\n\n${message.content}` };
      continue;
    }
    collapsed.push(message);
  }
  return [{ role: "system", content: SYSTEM_PROMPT }, ...collapsed];
}
