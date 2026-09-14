import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronDown,
  faChevronUp,
  faFaceSmile,
  faMagnifyingGlass,
  faPaperPlane,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { MAX_MESSAGE_BODY_LENGTH } from "@diudara/shared";
import {
  getSessionUser,
  isUserSignedIn,
  listConversations,
  listDirectMessages,
  markConversationRead,
  sendDirectMessage,
  startConversation,
  subscribeToUserAuth,
  type ConversationRow,
  type DirectMessageRow,
} from "./apiClient";
import { useChatContext } from "./ChatContext";
import { describeRequestFailure } from "./errorCopy";
import { formatRelativeTime } from "./relativeTime";

/**
 * **Polling intervals, following what is on screen.**
 *
 * This is Phase 8b's cost model, carried through the LinkedIn-style redesign
 * unchanged: the load scales with what is OPEN, not with signed-in users. A
 * collapsed roster polls no list; a minimised window polls no thread; a
 * collapsed roster with nothing open polls NOTHING AT ALL.
 *
 * Three seconds in a thread is close enough to live for a chat; ten in the
 * list is enough for a preview. Both are replaceable by a socket underneath
 * these two effects without changing the tables, the endpoints or this
 * component — see the spec.
 */
const THREAD_POLL_MS = 3_000;
const LIST_POLL_MS = 10_000;

/**
 * How many conversations may sit open beside the roster at once, matching the
 * reference mockup's `MAX_OPEN`. Four 18rem windows plus the roster overflow
 * a 1280px viewport, so the cap is a layout constraint, not a preference.
 */
const MAX_OPEN_WINDOWS = 3;

/** The reference mockup's grid, unchanged — eight columns of three rows. */
const EMOJIS = [
  "😀", "😂", "😍", "👍", "🙏", "🎉", "😢", "😮",
  "🔥", "❤️", "👏", "😅", "🤔", "😴", "💯", "✅",
  "🎯", "📌", "🙌", "😎", "🤝", "👀", "💡", "🚀",
] as const;

interface OpenWindow {
  id: string;
  /** Captured when the window opens so the header has a name to show even if
      the row later drops out of a filtered or re-polled list. */
  displayName: string;
  minimized: boolean;
}

interface Props {
  /** Injected clock for `formatRelativeTime`, the rule every dated component here follows. */
  now?: Date;
}

/** Two letters at most — the same shape `.member-avatar` uses on the roster. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The floating chat dock: a docked "Pesan" roster at the bottom right, with
 * open conversations stacked as their own windows to its left — the shape
 * LinkedIn uses and the one the `adamfloothink/diudara` reference mockup
 * (`src/components/chat/FloatingChat.tsx`) draws.
 *
 * The redesign replaced a round launcher + one sheet. What did NOT change:
 * the API underneath, the polling cost model above, and the rule below —
 * **nothing renders when signed out**, which Phases 1, 7 and 8a all set and
 * which also means no authenticated endpoint is polled by somebody with no
 * session.
 *
 * Attachments and the online dot the reference draws are deliberately absent:
 * `sendDirectMessage` carries a text body and `ConversationRow` has no
 * presence field, so both would be chrome over something that does not exist.
 */
export default function ChatPanel({ now }: Props) {
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [query, setQuery] = useState("");
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [threads, setThreads] = useState<Record<string, DirectMessageRow[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clock = now ?? new Date();
  const me = getSessionUser()?.handle ?? null;
  const { request, clearRequest } = useChatContext();

  const refreshList = useCallback(async (): Promise<ConversationRow[]> => {
    try {
      const { conversations: rows } = await listConversations();
      setConversations(rows);
      return rows;
    } catch (caught: unknown) {
      setError(describeRequestFailure(caught));
      return [];
    }
  }, []);

  const refreshThread = useCallback(async (id: string) => {
    try {
      const { messages } = await listDirectMessages(id);
      setThreads((current) => ({ ...current, [id]: messages }));
    } catch (caught: unknown) {
      setError(describeRequestFailure(caught));
    }
  }, []);

  const listRef = useRef(refreshList);
  listRef.current = refreshList;
  const threadRef = useRef(refreshThread);
  threadRef.current = refreshThread;

  // A COLLAPSED ROSTER POLLS NO LIST. Not a slower interval — nothing at all.
  useEffect(() => {
    if (!signedIn || !rosterOpen) return;
    const tick = () => {
      // Paused while the tab is hidden, and re-fetched the moment it returns —
      // the shape Phase 8a's bell established, for the same battery reason.
      if (document.visibilityState !== "visible") return;
      void listRef.current();
    };
    tick();
    const timer = setInterval(tick, LIST_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [signedIn, rosterOpen]);

  /**
   * One interval for every window that is open AND not minimised. Keyed by a
   * joined id string rather than the array so re-rendering with the same open
   * set does not tear the interval down and rebuild it — and so minimising a
   * window drops it out of the key, which stops its polling.
   *
   * This is also the ONLY place a thread is fetched: opening a window just
   * records it, and this effect's leading `tick()` loads it. One code path,
   * so an open window and a restored one cannot drift apart.
   */
  const liveIds = windows
    .filter((window) => !window.minimized)
    .map((window) => window.id)
    .join(",");

  useEffect(() => {
    if (!signedIn || liveIds === "") return;
    const ids = liveIds.split(",");
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      for (const id of ids) void threadRef.current(id);
    };
    tick();
    const timer = setInterval(tick, THREAD_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [signedIn, liveIds]);

  /**
   * The Anggota roster's "message this member" button (and anything else that
   * calls `requestConversation`) lands here: start-or-resume the thread, open
   * its window, then clear the request so it does not re-fire on the next
   * render. It does NOT expand the roster — the window is what was asked for.
   */
  useEffect(() => {
    if (!signedIn || request === null) return;
    let cancelled = false;
    (async () => {
      try {
        const { id } = await startConversation(request.handle);
        if (cancelled) return;
        const rows = await listRef.current();
        if (cancelled) return;
        const row = rows.find((candidate) => candidate.id === id);
        openWindow(id, row?.other.displayName ?? request.handle);
      } catch (caught: unknown) {
        if (!cancelled) setError(describeRequestFailure(caught));
      } finally {
        if (!cancelled) clearRequest();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, request, clearRequest]);

  if (!signedIn) return null;

  function openWindow(id: string, displayName: string): void {
    setWindows((current) => {
      const existing = current.find((window) => window.id === id);
      // Already open: restore it rather than stacking a duplicate.
      if (existing !== undefined) {
        return current.map((window) =>
          window.id === id ? { ...window, minimized: false } : window
        );
      }
      // Newest first, and the oldest falls off the end at the cap.
      return [{ id, displayName, minimized: false }, ...current].slice(0, MAX_OPEN_WINDOWS);
    });
    void markRead(id);
  }

  async function markRead(id: string): Promise<void> {
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

  function closeWindow(id: string): void {
    setWindows((current) => current.filter((window) => window.id !== id));
    setEmojiFor((current) => (current === id ? null : current));
  }

  function toggleMinimize(id: string): void {
    setWindows((current) =>
      current.map((window) =>
        window.id === id ? { ...window, minimized: !window.minimized } : window
      )
    );
  }

  async function send(id: string): Promise<void> {
    const body = (drafts[id] ?? "").trim();
    if (body === "") return;
    setDrafts((current) => ({ ...current, [id]: "" }));
    setEmojiFor(null);
    setError(null);
    try {
      const sent = await sendDirectMessage(id, body);
      // Appended immediately rather than waiting out an interval — your own
      // message must never appear to lag.
      setThreads((current) => ({ ...current, [id]: [...(current[id] ?? []), sent] }));
    } catch (caught: unknown) {
      setError(`Pesan gagal dikirim. ${describeRequestFailure(caught)}`);
      // The text comes back, so nothing is lost to a failed send.
      setDrafts((current) => ({ ...current, [id]: body }));
    }
  }

  const totalUnread = conversations.reduce((sum, row) => sum + row.unreadCount, 0);
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? conversations
      : conversations.filter((row) => row.other.displayName.toLowerCase().includes(needle));

  return (
    <div className="chat-dock">
      {windows.map(({ id, displayName, minimized }) => (
        <section
          key={id}
          className="chat-window"
          data-minimized={minimized ? "true" : undefined}
        >
          <header className="chat-window-header">
            <button
              type="button"
              className="chat-window-title"
              aria-label={`${minimized ? "Perbesar" : "Kecilkan"} percakapan dengan ${displayName}`}
              onClick={() => toggleMinimize(id)}
            >
              <span className="chat-avatar" aria-hidden="true">
                {initialsOf(displayName)}
              </span>
              <span className="chat-window-name">{displayName}</span>
              <FontAwesomeIcon icon={minimized ? faChevronUp : faChevronDown} />
            </button>
            <button
              type="button"
              className="chat-icon-button"
              aria-label={`Tutup percakapan dengan ${displayName}`}
              onClick={() => closeWindow(id)}
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </header>

          {minimized ? null : (
            <>
              <ul className="chat-thread">
                {(threads[id] ?? []).map((message) => (
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

              {emojiFor === id ? (
                <div className="chat-emoji-grid">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() =>
                        setDrafts((current) => ({ ...current, [id]: (current[id] ?? "") + emoji }))
                      }
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="chat-composer">
                <label htmlFor={`chat-draft-${id}`} className="sr-only">
                  Tulis pesan untuk {displayName}
                </label>
                <textarea
                  id={`chat-draft-${id}`}
                  rows={2}
                  value={drafts[id] ?? ""}
                  maxLength={MAX_MESSAGE_BODY_LENGTH}
                  placeholder="Tulis pesan..."
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [id]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    // Enter sends, Shift+Enter breaks the line — a textarea
                    // that swallowed Enter would make every send a mouse trip.
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(id);
                    }
                  }}
                />
                <div className="chat-composer-actions">
                  <button
                    type="button"
                    className="chat-icon-button"
                    aria-label="Emoji"
                    aria-pressed={emojiFor === id}
                    onClick={() => setEmojiFor((current) => (current === id ? null : id))}
                  >
                    <FontAwesomeIcon icon={faFaceSmile} />
                  </button>
                  <button
                    type="button"
                    className="chat-send"
                    aria-label="Kirim"
                    disabled={(drafts[id] ?? "").trim() === ""}
                    onClick={() => void send(id)}
                  >
                    <FontAwesomeIcon icon={faPaperPlane} />
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      ))}

      <section className="chat-roster" data-open={rosterOpen ? "true" : undefined}>
        {/* Above the bar rather than inside the body, so a failure is visible
            whether the roster is expanded or collapsed. */}
        {error !== null ? (
          <p className="chat-dock-error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          className="chat-roster-bar"
          aria-label={totalUnread > 0 ? `Pesan, ${totalUnread} belum dibaca` : "Pesan"}
          aria-expanded={rosterOpen}
          onClick={() => setRosterOpen((current) => !current)}
        >
          <span className="chat-avatar" aria-hidden="true">
            {initialsOf(getSessionUser()?.displayName ?? me ?? "?")}
          </span>
          <span className="chat-roster-title">Pesan</span>
          {/* No badge at zero rather than a nought — the rule the bell follows. */}
          {totalUnread > 0 ? <span className="chat-badge">{totalUnread}</span> : null}
          <FontAwesomeIcon icon={rosterOpen ? faChevronDown : faChevronUp} />
        </button>

        {rosterOpen ? (
          <>
            <div className="chat-search">
              <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
              <label htmlFor="chat-search" className="sr-only">
                Cari pesan
              </label>
              <input
                id="chat-search"
                value={query}
                placeholder="Cari pesan"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {conversations.length === 0 ? (
              <p className="empty">Belum ada percakapan.</p>
            ) : visible.length === 0 ? (
              <p className="empty">Tidak ada percakapan ditemukan.</p>
            ) : (
              <ul className="chat-list">
                {visible.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      aria-label={`Buka percakapan dengan ${row.other.displayName}`}
                      data-unread={row.unreadCount > 0 ? "true" : undefined}
                      onClick={() => openWindow(row.id, row.other.displayName)}
                    >
                      <span className="chat-avatar" aria-hidden="true">
                        {initialsOf(row.other.displayName)}
                      </span>
                      <span className="chat-list-name">{row.other.displayName}</span>
                      <span className="muted chat-list-time">
                        {row.lastMessageAt === null
                          ? ""
                          : formatRelativeTime(row.lastMessageAt, clock)}
                      </span>
                      <span className="muted chat-list-preview">
                        {row.lastMessageBody ?? "Belum ada pesan"}
                      </span>
                      {row.unreadCount > 0 ? <span className="chat-dot" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
