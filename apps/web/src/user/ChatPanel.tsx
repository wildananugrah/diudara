import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComments } from "@fortawesome/free-solid-svg-icons";
import { MAX_MESSAGE_BODY_LENGTH } from "@diudara/shared";
import {
  getSessionUser,
  isUserSignedIn,
  listConversations,
  listDirectMessages,
  markConversationRead,
  sendDirectMessage,
  subscribeToUserAuth,
  type ConversationRow,
  type DirectMessageRow,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatRelativeTime } from "./relativeTime";

/**
 * **Polling intervals, following what is on screen.**
 *
 * A closed panel polls NOTHING. This is Phase 8b's whole cost model: the load
 * scales with open conversations, not with signed-in users.
 *
 * Three seconds in a thread is close enough to live for a chat; ten in the
 * list is enough for a preview. Both are replaceable by a socket underneath
 * `useConversation` without changing the tables, the endpoints or this
 * component — see the spec.
 */
const THREAD_POLL_MS = 3_000;
const LIST_POLL_MS = 10_000;

interface Props {
  /** Injected clock for `formatRelativeTime`, the rule every dated component here follows. */
  now?: Date;
}

/**
 * The floating chat panel.
 *
 * **Nothing renders when signed out**, the rule Phase 1 set and Phases 7 and
 * 8a repeated — and it also means no authenticated endpoint is polled by
 * somebody with no session.
 */
export default function ChatPanel({ now }: Props) {
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DirectMessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clock = now ?? new Date();
  const me = getSessionUser()?.handle ?? null;

  const refreshList = useCallback(async () => {
    try {
      setConversations((await listConversations()).conversations);
    } catch (caught: unknown) {
      setError(describeRequestFailure(caught));
    }
  }, []);

  const refreshThread = useCallback(async (id: string) => {
    try {
      setMessages((await listDirectMessages(id)).messages);
    } catch (caught: unknown) {
      setError(describeRequestFailure(caught));
    }
  }, []);

  const listRef = useRef(refreshList);
  listRef.current = refreshList;
  const threadRef = useRef(refreshThread);
  threadRef.current = refreshThread;

  useEffect(() => {
    // A CLOSED PANEL POLLS NOTHING. Not a slower interval — nothing at all.
    if (!signedIn || !open) return;

    const showingThread = activeId !== null;
    const tick = () => {
      // Paused while the tab is hidden, and re-fetched the moment it returns —
      // the shape Phase 8a's bell established, for the same battery reason.
      if (document.visibilityState !== "visible") return;
      if (showingThread) void threadRef.current(activeId);
      else void listRef.current();
    };

    tick();
    const timer = setInterval(tick, showingThread ? THREAD_POLL_MS : LIST_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [signedIn, open, activeId]);

  if (!signedIn) return null;

  async function openConversation(id: string): Promise<void> {
    setActiveId(id);
    setMessages([]);
    await refreshThread(id);
    try {
      await markConversationRead(id);
      // The list's badge is stale the moment this returns, so it is corrected
      // locally rather than waiting out an interval for the next poll.
      setConversations((current) =>
        current.map((row) => (row.id === id ? { ...row, unreadCount: 0 } : row))
      );
    } catch {
      // A failed read-mark leaves the badge; the next poll restores the truth.
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const body = draft.trim();
    if (body === "" || activeId === null) return;
    setDraft("");
    setError(null);
    try {
      const sent = await sendDirectMessage(activeId, body);
      // Appended immediately rather than waiting out an interval — your own
      // message must never appear to lag.
      setMessages((current) => [...current, sent]);
    } catch (caught: unknown) {
      setError(`Pesan gagal dikirim. ${describeRequestFailure(caught)}`);
      // The text comes back, so nothing is lost to a failed send.
      setDraft(body);
    }
  }

  const totalUnread = conversations.reduce((sum, row) => sum + row.unreadCount, 0);
  const active = conversations.find((row) => row.id === activeId) ?? null;

  return (
    <div className="chat-panel">
      <button
        type="button"
        className="chat-launcher"
        aria-label={totalUnread > 0 ? `Pesan, ${totalUnread} belum dibaca` : "Pesan"}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FontAwesomeIcon icon={faComments} />
        {/* No badge at zero rather than a nought — the rule the bell follows. */}
        {totalUnread > 0 ? <span className="chat-badge">{totalUnread}</span> : null}
      </button>

      {open ? (
        <section className="chat-sheet">
          {error !== null ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          {activeId === null ? (
            conversations.length === 0 ? (
              <p className="empty">Belum ada percakapan.</p>
            ) : (
              <ul className="chat-list">
                {conversations.map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => openConversation(row.id)}>
                      <span className="chat-list-name">{row.other.displayName}</span>
                      <span className="muted chat-list-preview">
                        {row.lastMessageBody ?? "Belum ada pesan"}
                      </span>
                      {row.unreadCount > 0 ? (
                        <span className="chat-badge">{row.unreadCount}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <header className="chat-thread-header">
                <button type="button" onClick={() => setActiveId(null)}>
                  Kembali
                </button>
                <span>{active?.other.displayName ?? "Percakapan"}</span>
              </header>

              <ul className="chat-thread">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    data-mine={message.senderHandle === me ? "true" : undefined}
                  >
                    {/* A plain text node, NEVER dangerouslySetInnerHTML —
                        `PostCard` records why for exactly this class of
                        untrusted input. */}
                    <span className="chat-bubble">{message.body}</span>
                    <span className="muted">{formatRelativeTime(message.createdAt, clock)}</span>
                  </li>
                ))}
              </ul>

              <form className="chat-composer" onSubmit={submit}>
                <label htmlFor="chat-draft" className="sr-only">
                  Tulis pesan
                </label>
                <input
                  id="chat-draft"
                  value={draft}
                  maxLength={MAX_MESSAGE_BODY_LENGTH}
                  placeholder="Tulis pesan..."
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" disabled={draft.trim() === ""}>
                  Kirim
                </button>
              </form>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
