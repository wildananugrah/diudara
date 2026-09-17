import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronDown,
  faChevronUp,
  faXmark,
  faMagnifyingGlass,
  faPaperPlane,
  faPen,
  faImage,
  faPaperclip,
  faFaceSmile,
  faFile,
} from "@fortawesome/free-solid-svg-icons";
import Avatar from "../ui/Avatar";
import { api, type ApiAttachment, type ApiConversation, type ApiMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clockTime, timeAgoShort } from "../../lib/format";

const MAX_OPEN = 3;
const POLL_MS = 15_000;

const EMOJIS = [
  "😀", "😂", "😍", "👍", "🙏", "🎉", "😢", "😮",
  "🔥", "❤️", "👏", "😅", "🤔", "😴", "💯", "✅",
  "🎯", "📌", "🙌", "😎", "🤝", "👀", "💡", "🚀",
];

/**
 * Event global untuk membuka chat privat dari halaman mana pun
 * (mis. tombol chat di kartu member).
 *
 * `userId` HARUS id user asli dari API (mis. `members[].userId`) — bukan slug
 * nama. Percakapan diselesaikan server-side lewat `api.chat.open(userId)`,
 * yang idempoten per pasangan user.
 */
export const OPEN_CHAT_EVENT = "diudara:open-chat";
export type OpenChatRequest = { userId: string; name: string; initials: string; color?: string };

type OpenChat = { id: string; minimized: boolean };

export default function FloatingChat() {
  const { user } = useAuth();
  const [panelOpen, setPanelOpen] = useState(true);
  const [convoList, setConvoList] = useState<ApiConversation[]>([]);
  const [openChats, setOpenChats] = useState<OpenChat[]>([]);
  const [messages, setMessages] = useState<Record<string, ApiMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, ApiAttachment[]>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const threadRef = useRef<HTMLDivElement | null>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConvoList(await api.chat.conversations());
    } catch {
      // A failed poll is not worth interrupting the user over; the next tick retries.
    }
  }, []);

  // Initial load + polling. No websocket: nothing in this UI pushes messages,
  // so a 15s poll reaches parity without the extra moving part.
  useEffect(() => {
    if (!user) return;
    void refreshConversations();
    const timer = setInterval(() => void refreshConversations(), POLL_MS);
    return () => clearInterval(timer);
  }, [user, refreshConversations]);

  const loadThread = useCallback(async (conversationId: string) => {
    try {
      const thread = await api.chat.messages(conversationId);
      setMessages((prev) => ({ ...prev, [conversationId]: thread }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat pesan");
    }
  }, []);

  const openChat = useCallback(async (conversationId: string) => {
    setOpenChats((prev) => {
      if (prev.find((c) => c.id === conversationId)) {
        return prev.map((c) => (c.id === conversationId ? { ...c, minimized: false } : c));
      }
      return [{ id: conversationId, minimized: false }, ...prev].slice(0, MAX_OPEN);
    });

    await loadThread(conversationId);
    try {
      await api.chat.markRead(conversationId);
      await refreshConversations();
    } catch {
      // Clearing the unread badge is cosmetic — never block opening the chat.
    }
  }, [loadThread, refreshConversations]);

  // Permintaan buka chat dari luar (mis. tombol chat di tab Anggota).
  useEffect(() => {
    const handler = (e: Event) => {
      const req = (e as CustomEvent<OpenChatRequest>).detail;
      if (!req?.userId) {
        setError("Tidak bisa membuka chat: id pengguna tidak tersedia.");
        return;
      }
      void (async () => {
        try {
          const { id } = await api.chat.open(req.userId);
          await refreshConversations();
          await openChat(id);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Gagal membuka percakapan");
        }
      })();
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, [openChat, refreshConversations]);

  // Keep the newest message in view as threads load or grow.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, openChats]);

  const closeChat = (id: string) => setOpenChats((prev) => prev.filter((c) => c.id !== id));
  const toggleMinimize = (id: string) =>
    setOpenChats((prev) => prev.map((c) => (c.id === id ? { ...c, minimized: !c.minimized } : c)));

  const addEmoji = (id: string, emoji: string) =>
    setDrafts((prev) => ({ ...prev, [id]: (prev[id] ?? "") + emoji }));

  /** Uploads immediately so the message only ever carries real attachment ids. */
  const addFiles = async (id: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading((prev) => ({ ...prev, [id]: true }));
    setError("");
    try {
      const uploaded = await Promise.all(Array.from(files).map((f) => api.uploads.upload(f)));
      setPendingAttachments((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), ...uploaded] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengunggah file");
    } finally {
      setUploading((prev) => ({ ...prev, [id]: false }));
    }
  };

  const removeAttachment = (id: string, attachmentId: string) =>
    setPendingAttachments((prev) => ({ ...prev, [id]: (prev[id] ?? []).filter((a) => a.id !== attachmentId) }));

  const send = async (id: string) => {
    const text = (drafts[id] ?? "").trim();
    const attachments = pendingAttachments[id] ?? [];
    if (!text && attachments.length === 0) return;

    setDrafts((prev) => ({ ...prev, [id]: "" }));
    setPendingAttachments((prev) => ({ ...prev, [id]: [] }));
    setEmojiPickerFor(null);

    try {
      await api.chat.send(id, { text, attachmentIds: attachments.map((a) => a.id) });
      // Refetch rather than trusting the POST response: the API returns only an
      // id/timestamp for the new message, not its attachments.
      await loadThread(id);
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pesan gagal dikirim");
      setDrafts((prev) => ({ ...prev, [id]: text }));
      setPendingAttachments((prev) => ({ ...prev, [id]: attachments }));
    }
  };

  if (!user) return null;

  const unreadTotal = convoList.reduce((sum, c) => sum + c.unread, 0);
  const filtered = convoList.filter((c) => c.peerName.toLowerCase().includes(query.toLowerCase()));

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        right: 20,
        display: "flex",
        alignItems: "flex-end",
        gap: 10,
        zIndex: 100,
      }}
    >
      {/* Jendela chat privat — tumpuk ke kiri panel utama */}
      {openChats.map(({ id, minimized }) => {
        const convo = convoList.find((c) => c.id === id);
        if (!convo) return null;
        const thread = messages[id] ?? [];
        return (
          <div
            key={id}
            className="card"
            style={{
              width: 300,
              borderTopLeftRadius: 12,
              borderTopRightRadius: 12,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              height: minimized ? "auto" : 460,
              boxShadow: "var(--shadow-card)",
            }}
          >
            {/* Header jendela chat */}
            <div
              onClick={() => toggleMinimize(id)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 10px 14px",
                background: "var(--langit-dark)", color: "var(--awan)", cursor: "pointer", flexShrink: 0,
              }}
            >
              <span style={{ position: "relative", flexShrink: 0 }}>
                <Avatar initials={convo.peerInitials} color={convo.peerColor} size={28} />
              </span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {convo.peerName}
              </span>
              <button
                aria-label="Tutup"
                onClick={(e) => { e.stopPropagation(); closeChat(id); }}
                className="btn btn-ghost btn-icon"
                style={{ width: 26, height: 26, color: "var(--awan)", fontSize: 12 }}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>

            {!minimized && (
              <>
                {/* Riwayat pesan */}
                <div ref={threadRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "var(--surface)" }}>
                  {thread.length === 0 && (
                    <p style={{ fontSize: 12, color: "var(--ink-500)", textAlign: "center", marginTop: 12 }}>
                      Belum ada pesan. Mulai percakapan.
                    </p>
                  )}
                  {thread.map((m) => (
                    <div key={m.id} style={{ display: "flex", justifyContent: m.sender === "me" ? "flex-end" : "flex-start" }}>
                      <div style={{ maxWidth: "78%", display: "flex", flexDirection: "column", gap: 4, alignItems: m.sender === "me" ? "flex-end" : "flex-start" }}>
                        {m.attachments?.map((a) =>
                          a.kind === "image" ? (
                            <img key={a.id} src={a.url} alt={a.name} style={{ maxWidth: 160, borderRadius: 10, display: "block" }} />
                          ) : (
                            <a
                              key={a.id}
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 10,
                                background: "var(--awan)", fontSize: 11.5, color: "var(--ink-700)",
                              }}
                            >
                              <FontAwesomeIcon icon={faFile} /> {a.name}
                            </a>
                          )
                        )}
                        {m.body && (
                          <div
                            style={{
                              padding: "7px 11px",
                              borderRadius: 14,
                              fontSize: 12.5,
                              lineHeight: 1.4,
                              background: m.sender === "me" ? "var(--langit)" : "var(--awan)",
                              color: m.sender === "me" ? "var(--awan)" : "var(--ink-900)",
                            }}
                          >
                            {m.body}
                          </div>
                        )}
                        <span style={{ fontSize: 10, color: "var(--ink-300)" }}>{clockTime(m.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Lampiran yang belum terkirim */}
                {(pendingAttachments[id]?.length ?? 0) > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 8px 0" }}>
                    {pendingAttachments[id]!.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          position: "relative", display: "flex", alignItems: "center", gap: 6,
                          padding: a.kind === "image" ? 0 : "5px 8px", borderRadius: 8,
                          background: "var(--awan)", fontSize: 11, color: "var(--ink-700)", overflow: "hidden",
                        }}
                      >
                        {a.kind === "image" ? (
                          <img src={a.url} alt={a.name} style={{ width: 44, height: 44, objectFit: "cover", display: "block" }} />
                        ) : (
                          <>
                            <FontAwesomeIcon icon={faFile} />
                            <span style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                          </>
                        )}
                        <button
                          aria-label="Hapus lampiran"
                          onClick={() => removeAttachment(id, a.id)}
                          style={{
                            position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: "50%",
                            background: "rgba(22,40,58,0.65)", color: "#fff", border: "none", fontSize: 9,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          <FontAwesomeIcon icon={faXmark} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Emoji picker */}
                {emojiPickerFor === id && (
                  <div
                    style={{
                      display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2,
                      padding: 8, borderTop: "1px solid var(--border)", background: "var(--awan)",
                    }}
                  >
                    {EMOJIS.map((emo) => (
                      <button
                        key={emo}
                        onClick={() => addEmoji(id, emo)}
                        style={{ background: "none", border: "none", fontSize: 16, padding: 3, cursor: "pointer" }}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                )}

                {/* Input pesan */}
                <div style={{ padding: 8, borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <textarea
                    className="input"
                    placeholder="Tulis pesan..."
                    rows={3}
                    value={drafts[id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send(id);
                      }
                    }}
                    style={{
                      width: "100%", fontSize: 12.5, padding: "10px 12px", background: "var(--awan)",
                      resize: "none", fontFamily: "inherit", lineHeight: 1.5, minHeight: 64,
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <label
                      aria-label="Kirim gambar"
                      title="Kirim gambar"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 30, height: 30, fontSize: 13, color: "var(--ink-500)", cursor: "pointer" }}
                    >
                      <FontAwesomeIcon icon={faImage} />
                      <input type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(id, e.target.files)} />
                    </label>
                    <label
                      aria-label="Lampirkan file"
                      title="Lampirkan file"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 30, height: 30, fontSize: 13, color: "var(--ink-500)", cursor: "pointer" }}
                    >
                      <FontAwesomeIcon icon={faPaperclip} />
                      <input type="file" multiple hidden onChange={(e) => void addFiles(id, e.target.files)} />
                    </label>
                    <button
                      aria-label="Emoji"
                      title="Emoji"
                      onClick={() => setEmojiPickerFor((prev) => (prev === id ? null : id))}
                      className="btn btn-ghost btn-icon"
                      style={{ width: 30, height: 30, fontSize: 13, color: emojiPickerFor === id ? "var(--sinyal)" : "var(--ink-500)" }}
                    >
                      <FontAwesomeIcon icon={faFaceSmile} />
                    </button>
                    <span style={{ flex: 1, fontSize: 10.5, color: "var(--ink-500)" }}>
                      {uploading[id] ? "Mengunggah…" : ""}
                    </span>
                    <button
                      aria-label="Kirim"
                      onClick={() => void send(id)}
                      className="btn btn-primary btn-icon"
                      style={{ width: 32, height: 32, fontSize: 12 }}
                    >
                      <FontAwesomeIcon icon={faPaperPlane} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}

      {/* Panel utama daftar percakapan */}
      <div
        className="card"
        style={{
          width: 300,
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-card)",
          maxHeight: panelOpen ? 420 : "auto",
        }}
      >
        <div
          onClick={() => setPanelOpen((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 8px 12px 16px",
            cursor: "pointer", flexShrink: 0,
          }}
        >
          <Avatar initials={user.initials} color={user.avatarColor} size={30} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>Pesan</span>
          {unreadTotal > 0 && (
            <span
              style={{
                minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
                background: "var(--merah-senja)", color: "#fff", fontSize: 10.5, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {unreadTotal}
            </span>
          )}
          <button aria-label="Pesan baru" onClick={(e) => e.stopPropagation()} className="btn btn-ghost btn-icon" style={{ width: 28, height: 28, fontSize: 13 }}>
            <FontAwesomeIcon icon={faPen} />
          </button>
          <button
            aria-label={panelOpen ? "Tutup panel" : "Buka panel"}
            onClick={(e) => { e.stopPropagation(); setPanelOpen((v) => !v); }}
            className="btn btn-ghost btn-icon"
            style={{ width: 28, height: 28, fontSize: 12 }}
          >
            <FontAwesomeIcon icon={panelOpen ? faChevronDown : faChevronUp} />
          </button>
        </div>

        {panelOpen && (
          <>
            <div style={{ padding: "0 12px 10px" }}>
              <div style={{ position: "relative" }}>
                <FontAwesomeIcon
                  icon={faMagnifyingGlass}
                  style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11.5, color: "var(--ink-500)" }}
                />
                <input
                  className="input"
                  placeholder="Cari pesan"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: "100%", padding: "7px 10px 7px 30px", fontSize: 12.5, background: "var(--awan)" }}
                />
              </div>
            </div>

            {error && (
              <p style={{ padding: "0 14px 8px", fontSize: 11.5, color: "var(--merah-senja)" }}>{error}</p>
            )}

            <div style={{ overflowY: "auto", borderTop: "1px solid var(--border)" }}>
              {filtered.map((c) => (
                <div
                  key={c.id}
                  onClick={() => void openChat(c.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                    cursor: "pointer", background: c.unread > 0 ? "var(--awan)" : "transparent",
                  }}
                >
                  <span style={{ position: "relative", flexShrink: 0 }}>
                    <Avatar initials={c.peerInitials} color={c.peerColor} size={36} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: c.unread > 0 ? 700 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.peerName}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--ink-500)", flexShrink: 0 }}>{timeAgoShort(c.lastMessageAt)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: c.unread > 0 ? "var(--ink-900)" : "var(--ink-500)", fontWeight: c.unread > 0 ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.lastMessage}
                    </p>
                  </div>
                  {c.unread > 0 && (
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--sinyal)", flexShrink: 0 }} />
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <p style={{ padding: 16, fontSize: 12.5, color: "var(--ink-500)" }}>Tidak ada percakapan ditemukan.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
