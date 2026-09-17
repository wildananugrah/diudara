import { useCallback, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen, faTrash, faTag } from "@fortawesome/free-solid-svg-icons";
import { api, type ApiTopic } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * Topic administration for a community owner.
 *
 * A topic has no row of its own — it exists while posts carry it. So renaming
 * rewrites every post that uses it, deleting detaches it from them, and a topic
 * with no posts simply stops existing. Nothing here ever deletes a post.
 */
export default function TopicManager({ communityId }: { communityId: string }) {
  const topicsQ = useApi(useCallback(() => api.communities.topics(communityId), [communityId]));

  const [renaming, setRenaming] = useState<ApiTopic | null>(null);
  const [removing, setRemoving] = useState<ApiTopic | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topics = topicsQ.data ?? [];

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      topicsQ.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const nextName = draft.trim();
  const mergesInto = renaming && nextName !== renaming.name
    && topics.some((t) => t.name === nextName);

  return (
    <div className="card" style={{ padding: 8 }}>
      <div style={{ padding: "14px 16px 6px" }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>Topik</h3>
        <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 3 }}>
          Topik muncul otomatis dari post yang memakainya. Menghapus topik tidak menghapus postnya.
        </p>
      </div>

      {topicsQ.loading && <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 16px" }}>Memuat…</p>}
      {topicsQ.error && <p style={{ fontSize: 13, color: "var(--merah-senja)", padding: "12px 16px" }}>{topicsQ.error}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--merah-senja)", padding: "4px 16px" }}>{error}</p>}

      {!topicsQ.loading && topics.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 16px" }}>
          Belum ada topik. Tambahkan lewat kolom Topik saat membuat post.
        </p>
      )}

      {topics.map((topic) => (
        <div
          key={topic.name}
          style={{
            display: "flex", alignItems: "center", gap: 14,
            padding: "12px 16px", borderTop: "1px solid var(--ink-100)",
          }}
        >
          <span style={{ fontSize: 15, color: "var(--ink-500)", flexShrink: 0 }}>
            <FontAwesomeIcon icon={faTag} />
          </span>
          <p style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {topic.name}
          </p>
          <span style={{ fontSize: 12.5, color: "var(--ink-500)", flexShrink: 0 }}>
            {topic.count} post
          </span>
          <button
            aria-label={`Ubah nama topik ${topic.name}`} title="Ubah nama"
            disabled={busy}
            onClick={() => { setRenaming(topic); setDraft(topic.name); }}
            className="btn btn-ghost btn-icon"
            style={{ width: 30, height: 30, fontSize: 12, color: "var(--ink-500)", flexShrink: 0 }}
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
          <button
            aria-label={`Hapus topik ${topic.name}`} title="Hapus topik"
            disabled={busy}
            onClick={() => setRemoving(topic)}
            className="btn btn-ghost btn-icon"
            style={{ width: 30, height: 30, fontSize: 12, color: "var(--merah-senja)", flexShrink: 0 }}
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
        </div>
      ))}

      {renaming && (
        <ConfirmDialog
          title={`Ubah nama topik "${renaming.name}"?`}
          tone="primary"
          confirmLabel="Simpan"
          busyLabel="Menyimpan…"
          busy={busy}
          disabled={!nextName || nextName === renaming.name}
          onCancel={() => setRenaming(null)}
          onConfirm={() => void run(async () => {
            await api.communities.renameTopic(communityId, renaming.name, nextName);
            setRenaming(null);
          }, "Gagal mengubah nama topik")}
        >
          <input
            className="input" autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Nama topik baru"
            style={{ fontSize: 13.5, marginBottom: 10 }}
          />
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-700)" }}>
            {renaming.count} post bertopik ini ikut berubah.
            {mergesInto && " Nama itu sudah dipakai, jadi kedua topik akan digabung jadi satu."}
          </p>
        </ConfirmDialog>
      )}

      {removing && (
        <ConfirmDialog
          title={`Hapus topik "${removing.name}"?`}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void run(async () => {
            await api.communities.deleteTopic(communityId, removing.name);
            setRemoving(null);
          }, "Gagal menghapus topik")}
        >
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            Topik ini akan dilepas dari {removing.count} post yang memakainya.
            Postnya sendiri tetap ada — hanya labelnya yang hilang.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
