import type { BuilderMessage, BuilderTurn, CommunityBuilderAi, CommunityDraft } from "../../domain/ports.ts";
import { ServiceUnavailableError, ValidationError } from "../../domain/errors.ts";

const SYSTEM_PROMPT = `Kamu adalah "Pulse-ID", asisten AI di platform DIUDARA yang membantu kreator Indonesia membuat komunitas berbayar.

Tugasmu: lewat percakapan santai dalam Bahasa Indonesia, kumpulkan informasi berikut dari pengguna:
- name: nama komunitas
- niche: satu kalimat pendek tentang fokus komunitas
- category: satu kata/frasa kategori, contoh "Edukasi", "Bisnis", "Kreator", "Rohani", "Kesehatan"
- description: 1-3 kalimat deskripsi untuk halaman komunitas
- tiers: 1 sampai 3 paket membership, masing-masing { name, priceCents, billingPeriod, benefits }

Aturan:
- Tanya SATU hal per balasan. Jangan memberondong.
- Singkat, ramah, tanpa basa-basi berlebihan.
- priceCents dalam SEN rupiah: Rp149.000 = 14900000.
- billingPeriod selalu berupa string seperti "/ bulan" atau "/ tahun".
- Kalau pengguna ragu soal harga atau kategori, usulkan nilai yang masuk akal dan minta konfirmasi.
- Isi field di "draft" segera setelah kamu tahu jawabannya, walau percakapan belum selesai.
- Set "done": true HANYA setelah name, niche, category, description, dan minimal satu tier terisi DAN pengguna sudah setuju dengan ringkasannya.
- Saat done: true, tulis "reply" sebagai ringkasan singkat komunitas yang akan dibuat.

WAJIB soal "reply":
- "reply" harus SELALU berisi kalimat asli berbahasa Indonesia untuk pengguna — pertanyaan berikutnya, atau ringkasan saat done.
- JANGAN PERNAH mengisi "reply" dengan string kosong, "...", atau placeholder apa pun.

WAJIB soal "draft":
- Hanya sertakan field yang benar-benar sudah kamu ketahui.
- JANGAN mengirim field dengan nilai string kosong ("") atau array kosong — hilangkan saja field itu.

Jawab SELALU dengan JSON objek valid, tanpa teks lain. Bentuknya (isi dengan nilai asli, bukan teks di dalam kurung siku):
{"reply": <kalimat untuk pengguna>, "done": false, "draft": {"name": <nama komunitas>, "niche": <fokus singkat>, "category": <kategori>, "description": <deskripsi>, "tiers": [{"name": <nama paket>, "priceCents": 14900000, "billingPeriod": "/ bulan", "benefits": [<manfaat>]}]}}`;

/** Only dots/ellipsis/whitespace — the prompt skeleton echoed back verbatim. */
const PLACEHOLDER_REPLY = /^[.…\s]*$/;

/**
 * Models routinely send back every draft key with an empty value. The client
 * merges turns with `{...prev, ...draft}`, so a blank "name" would wipe a name
 * the user gave two turns earlier. Drop blanks instead of forwarding them.
 */
function sanitizeDraft(draft: Record<string, unknown>): CommunityDraft {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    clean[key] = value;
  }
  return clean as CommunityDraft;
}

/**
 * OpenRouter adapter for the community co-builder.
 *
 * The key never leaves the server: the browser talks to POST /api/ai/community-builder
 * and this class is the only thing that sees OPENROUTER_API_KEY.
 */
export class OpenRouterCommunityBuilder implements CommunityBuilderAi {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly referer: string,
  ) {}

  async next(messages: BuilderMessage[]): Promise<BuilderTurn> {
    if (!this.apiKey) {
      throw new ServiceUnavailableError(
        "Fitur AI belum aktif. Set OPENROUTER_API_KEY di backend/.env lalu restart API.",
      );
    }
    if (!messages.length) throw new ValidationError("Percakapan kosong");

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attributes usage with these; harmless if the host is unset.
        "HTTP-Referer": this.referer,
        "X-Title": "DIUDARA",
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        temperature: 0.4,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      }),
      // Without this a hung upstream would hold the request open indefinitely.
      signal: AbortSignal.timeout(30_000),
    }).catch((cause) => {
      throw new ServiceUnavailableError(`Tidak bisa menghubungi OpenRouter: ${(cause as Error).message}`);
    });

    if (!res.ok) {
      // Upstream error bodies can contain the request echo; log it, don't return it.
      console.error(`[openrouter] ${res.status} ${await res.text().catch(() => "")}`);
      throw new ServiceUnavailableError(`Layanan AI menolak permintaan (${res.status}). Coba lagi sebentar lagi.`);
    }

    const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ServiceUnavailableError("Layanan AI mengembalikan jawaban kosong.");

    return OpenRouterCommunityBuilder.parseTurn(content);
  }

  /**
   * Models ignore the JSON instruction often enough that a raw JSON.parse here
   * would turn a chatty reply into a 500. Fall back to treating the text as the
   * chat message with an empty draft — the conversation then simply continues.
   *
   * That fallback only applies when the model did NOT obey the format. Once the
   * payload parses into an object the model *did* obey, so the raw text must
   * never reach `reply`: models routinely fill `draft` and leave `reply` empty,
   * which used to echo the whole JSON object back into the chat bubble.
   */
  static parseTurn(content: string): BuilderTurn {
    // Some models wrap JSON in a ```json fence despite response_format.
    const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced);
    } catch {
      return { reply: content.trim(), done: false, draft: {} };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { reply: content.trim(), done: false, draft: {} };
    }
    const obj = parsed as { reply?: unknown; done?: unknown; draft?: unknown };
    const raw = typeof obj.reply === "string" ? obj.reply.trim() : "";
    // "..." is the prompt's own placeholder coming back; rendering it looks
    // exactly like the assistant saying nothing, so treat it as empty.
    const reply = PLACEHOLDER_REPLY.test(raw) ? "" : raw;
    return {
      // A blank bubble is as broken as a JSON one, so nudge the user instead.
      reply: reply || "Oke, aku catat dulu. Ada lagi yang mau kamu ceritain?",
      done: obj.done === true,
      draft: typeof obj.draft === "object" && obj.draft !== null
        ? sanitizeDraft(obj.draft as Record<string, unknown>)
        : {},
    };
  }
}
