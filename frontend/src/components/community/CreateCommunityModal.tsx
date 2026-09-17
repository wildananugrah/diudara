import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperPlane, faSpinner, faWandMagicSparkles, faCheck } from "@fortawesome/free-solid-svg-icons";
import Modal from "../ui/Modal";
import { api, ApiError, type ApiBuilderMessage, type ApiCommunityDraft } from "../../lib/api";
import { formatRupiah } from "../../lib/format";

const GREETING =
  "Halo! Aku Pulse-ID 👋 Aku bantu kamu bikin komunitas berbayar lewat obrolan. " +
  "Ceritain dulu dong — komunitas kamu tentang apa?";

/** The draft is complete enough to send to POST /communities. */
function isReady(d: ApiCommunityDraft): boolean {
  return Boolean(d.name && d.niche && d.category && d.description && d.tiers?.length);
}

type Props = {
  onClose: () => void;
  onCreated: (communityId: string) => void;
};

export default function CreateCommunityModal({ onClose, onCreated }: Props) {
  const [messages, setMessages] = useState<ApiBuilderMessage[]>([
    { role: "assistant", content: GREETING },
  ]);
  const [draft, setDraft] = useState<ApiCommunityDraft>({});
  const [done, setDone] = useState(false);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking, done]);

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;

    const next: ApiBuilderMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setThinking(true);
    setError(null);

    try {
      const turn = await api.ai.communityBuilder(next);
      setMessages([...next, { role: "assistant", content: turn.reply }]);
      // Merge, never replace: a turn only reports the fields it just learned, so
      // overwriting would drop everything gathered earlier in the conversation.
      setDraft((prev) => ({ ...prev, ...turn.draft }));
      if (turn.done) setDone(true);
    } catch (e) {
      // Drop the optimistic user bubble so retrying does not duplicate it.
      setMessages(messages);
      setInput(text);
      setError(e instanceof ApiError ? e.message : "Gagal menghubungi Pulse-ID. Coba lagi.");
    } finally {
      setThinking(false);
    }
  }

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const community = await api.communities.create(draft);
      onCreated(community.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal membuat komunitas. Coba lagi.");
      setCreating(false);
    }
  }

  const ready = done && isReady(draft);

  return (
    <Modal
      title="Buat komunitas baru"
      subtitle="Ngobrol sama Pulse-ID, komunitasmu langsung jadi."
      onClose={onClose}
      width={560}
      // A half-finished conversation is real work; don't lose it to a stray click.
      closeOnBackdrop={false}
      footer={
        ready ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Batal
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={create}
              disabled={creating}
            >
              {creating
                ? <><FontAwesomeIcon icon={faSpinner} spin /> Membuat…</>
                : <><FontAwesomeIcon icon={faCheck} /> Buat komunitas</>}
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="Tulis jawabanmu…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={thinking}
              aria-label="Pesan untuk Pulse-ID"
            />
            <button
              type="submit"
              className="btn btn-primary btn-icon"
              disabled={thinking || !input.trim()}
              aria-label="Kirim"
            >
              <FontAwesomeIcon icon={thinking ? faSpinner : faPaperPlane} spin={thinking} />
            </button>
          </form>
        )
      }
    >
      <div ref={scrollRef} style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 300 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "82%",
              background: m.role === "user" ? "var(--langit)" : "var(--ink-100)",
              color: m.role === "user" ? "var(--awan)" : "var(--ink-700)",
              padding: "10px 13px",
              borderRadius: 14,
              fontSize: 13.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}

        {thinking && (
          <div style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--ink-500)", padding: "6px 4px" }}>
            <FontAwesomeIcon icon={faWandMagicSparkles} /> Pulse-ID sedang mikir…
          </div>
        )}

        {ready && <DraftSummary draft={draft} />}

        {error && (
          <div
            role="alert"
            style={{
              background: "var(--danger-bg)", color: "var(--merah-senja)",
              padding: "10px 13px", borderRadius: 10, fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DraftSummary({ draft }: { draft: ApiCommunityDraft }) {
  return (
    <div className="card" style={{ padding: 16, marginTop: 4, background: "var(--kabut-light, var(--ink-100))" }}>
      <p style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, color: "var(--ink-500)", marginBottom: 10 }}>
        RINGKASAN KOMUNITAS
      </p>
      <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>{draft.name}</h4>
      <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginBottom: 8 }}>
        {draft.niche} · {draft.category}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{draft.description}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {draft.tiers?.map((t, i) => (
          <div
            key={i}
            style={{
              display: "flex", justifyContent: "space-between", gap: 10,
              fontSize: 13, padding: "7px 0", borderTop: "1px solid var(--ink-150)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{t.name}</span>
            <span style={{ color: "var(--ink-500)" }}>
              {formatRupiah(t.priceCents)} {t.billingPeriod ?? "/ bulan"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
