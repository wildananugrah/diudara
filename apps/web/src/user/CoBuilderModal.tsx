import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  COMMUNITY_CATEGORIES,
  MAX_COMMUNITY_DESCRIPTION_LENGTH,
  MAX_COMMUNITY_NAME_LENGTH,
  MAX_COMMUNITY_TAGS,
  MAX_COMMUNITY_TAG_LENGTH,
} from "@diudara/shared";
import { chatWithCoBuilder, createCommunity, type CoBuilderMessage, type CoBuilderTurn } from "./apiClient";
import { describeCommunityFailure, describeRequestFailure } from "./errorCopy";
import Modal from "./shell/Modal";

const GREETING = "Halo! Ceritakan komunitas yang ingin kamu buat — nama, kategori, dan sedikit deskripsinya.";

/** `createCommunity`'s own — kept local rather than imported, the same
 * reason `CommunityCreatePage`'s own copy gives for its own `Field`: one
 * small parser, duplicated per consumer rather than shared. */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim().slice(0, MAX_COMMUNITY_TAG_LENGTH))
    .filter((tag) => tag !== "")
    .slice(0, MAX_COMMUNITY_TAGS);
}

type DraftForm = {
  name: string;
  category: string;
  description: string;
  tags: string;
};

function draftToForm(draft: NonNullable<CoBuilderTurn["draft"]>): DraftForm {
  return {
    name: draft.name,
    category: draft.category,
    description: draft.description ?? "",
    tags: (draft.tags ?? []).join(", "),
  };
}

/**
 * Discover's "Mulai sekarang" modal — a conversation with an AI (OpenRouter,
 * see `selectAiProvider` in `apps/api/src/bootstrap.ts`) that proposes a
 * community draft.
 *
 * **The AI never creates the community.** Every turn only calls
 * `chatWithCoBuilder`; a draft it proposes lands in the SAME editable
 * fields `CommunityCreatePage` already uses, pre-filled rather than blank,
 * and only an explicit "Buat komunitas" click calls the unchanged
 * `createCommunity` — the exact function and endpoint the manual form at
 * `/komunitas/baru` already uses. That route stays linked here as a
 * fallback for whenever the chat itself is unavailable.
 *
 * **Nothing is persisted across a reload.** `messages` is this component's
 * own state, resent in full on every turn — see the API's own
 * `CoBuilderChat` docstring for why.
 */
export default function CoBuilderModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<CoBuilderMessage[]>([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [draftForm, setDraftForm] = useState<DraftForm | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (content === "" || sending) return;

    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setChatError(null);
    setSending(true);
    try {
      const turn = await chatWithCoBuilder(next);
      setMessages([...next, { role: "assistant", content: turn.reply }]);
      if (turn.draft !== null) setDraftForm(draftToForm(turn.draft));
    } catch (err) {
      setChatError(describeRequestFailure(err));
    } finally {
      setSending(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (draftForm === null) return;
    setCreateError(null);
    setCreating(true);
    try {
      const created = await createCommunity({
        name: draftForm.name.trim(),
        category: draftForm.category,
        description: draftForm.description.trim() === "" ? undefined : draftForm.description.trim(),
        tags: parseTags(draftForm.tags),
      });
      onClose();
      navigate(`/komunitas/${created.slug}`);
    } catch (err) {
      setCreateError(describeCommunityFailure(err));
      setCreating(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="co-builder-title">
      <div className="modal-header">
        <h2 id="co-builder-title">Buat komunitas dengan AI</h2>
        <button type="button" className="button-quiet" onClick={onClose} aria-label="Tutup">
          ✕
        </button>
      </div>

      <div className="chat-transcript" role="log">
        {messages.map((message, index) => (
          <div key={index} className={`chat-bubble chat-bubble-${message.role}`}>
            <p>{message.content}</p>
          </div>
        ))}
        {sending ? (
          <div className="chat-bubble chat-bubble-assistant">
            <p className="muted">Mengetik...</p>
          </div>
        ) : null}
      </div>

      {chatError !== null ? (
        <p className="form-error" role="alert">
          {chatError} <Link to="/komunitas/baru">Buka formulir manual</Link>.
        </p>
      ) : null}

      <form onSubmit={handleSend} className="chat-composer">
        <textarea
          aria-label="Pesan"
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend(e);
            }
          }}
        />
        <button type="submit" className="button-primary" disabled={sending || input.trim() === ""}>
          Kirim
        </button>
      </form>

      {draftForm !== null ? (
        <form onSubmit={handleCreate} className="stack cobuilder-draft">
          <h3>Draf komunitas</h3>
          <p className="hint">Periksa dan ubah bila perlu sebelum membuatnya — AI bisa saja salah.</p>

          <Field label="Nama komunitas" name="draft-name">
            <input
              id="field-draft-name"
              type="text"
              value={draftForm.name}
              maxLength={MAX_COMMUNITY_NAME_LENGTH}
              onChange={(e) => setDraftForm({ ...draftForm, name: e.target.value })}
            />
          </Field>

          <Field label="Kategori" name="draft-category">
            <select
              id="field-draft-category"
              value={draftForm.category}
              onChange={(e) => setDraftForm({ ...draftForm, category: e.target.value })}
            >
              {COMMUNITY_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Deskripsi" name="draft-description" hint="Opsional.">
            <textarea
              id="field-draft-description"
              value={draftForm.description}
              maxLength={MAX_COMMUNITY_DESCRIPTION_LENGTH}
              rows={3}
              onChange={(e) => setDraftForm({ ...draftForm, description: e.target.value })}
            />
          </Field>

          <Field label="Tag" name="draft-tags" hint="Pisahkan dengan koma. Opsional.">
            <input
              id="field-draft-tags"
              type="text"
              value={draftForm.tags}
              onChange={(e) => setDraftForm({ ...draftForm, tags: e.target.value })}
            />
          </Field>

          <button type="submit" className="button-primary" disabled={creating}>
            {creating ? "Membuat..." : "Buat komunitas"}
          </button>

          {createError !== null ? (
            <p className="form-error" role="alert">
              {createError}
            </p>
          ) : null}
        </form>
      ) : null}
    </Modal>
  );
}

/** The same field wrapper `CommunityCreatePage`/`SignupPage` each keep their
 * own copy of, for the same reason they do. */
function Field({
  label,
  name,
  hint,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      {children}
      {hint !== undefined ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
