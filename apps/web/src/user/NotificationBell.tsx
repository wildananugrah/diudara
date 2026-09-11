import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";
import {
  isUserSignedIn,
  listNotifications,
  markNotificationsRead,
  subscribeToUserAuth,
  type NotificationRow,
} from "./apiClient";
import { formatRelativeTime } from "./relativeTime";

/**
 * How often the bell asks. Sixty seconds is deliberately unambitious: a
 * notification arriving up to a minute late is not a product failure, and
 * this interval is the entire reason Phase 8a needs no realtime
 * infrastructure. 8b can replace the polling without changing the table, the
 * endpoints or this component's shape.
 */
const POLL_MS = 60_000;

interface Props {
  /** Injected clock for `formatRelativeTime`, the rule every dated component here follows. */
  now?: Date;
}

/**
 * The bell, its badge and its list.
 *
 * **Polls; does not push.** See `POLL_MS`.
 *
 * **Nothing renders when signed out** — the fetch 401s and the component
 * stays absent rather than showing an empty bell, the rule Phase 1 set when
 * it cut the tab bar.
 */
export default function NotificationBell({ now }: Props) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  // A failed poll leaves the bell exactly as it was. It is a convenience over
  // state readable elsewhere, so a network blip must not put an error in the
  // header of every page.
  const [reachable, setReachable] = useState(false);
  const clock = now ?? new Date();
  // **NO POLL WHEN SIGNED OUT.** A visitor with no session has nothing to be
  // notified about, and asking an authenticated endpoint every minute to be
  // told 401 is a request nobody needed. Subscribed rather than read once, so
  // signing in on another tab starts the bell without a reload — the pattern
  // `SiaranPage` uses.
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);

  const poll = useCallback(async () => {
    try {
      const page = await listNotifications();
      setRows(page.notifications);
      setUnread(page.unreadCount);
      setReachable(true);
    } catch {
      // Signed out, or the request failed. Either way the bell disappears
      // rather than showing a zero it cannot stand behind.
      setReachable(false);
    }
  }, []);

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!signedIn) {
      setReachable(false);
      return;
    }
    void pollRef.current();
    const timer = setInterval(() => {
      // STOPS WHEN THE TAB IS HIDDEN. A background tab asking every minute
      // forever is the kind of thing that shows up on somebody's battery.
      if (document.visibilityState === "visible") void pollRef.current();
    }, POLL_MS);
    // And asks again the moment the tab comes back, so returning to it does
    // not mean waiting out the rest of an interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [signedIn]);

  if (!reachable) return null;

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (!next || unread === 0) return;
    // OPENING IS READING. The count clears optimistically so the badge does
    // not linger while the request is in flight; a failure leaves the rows
    // unread on the server and the next poll restores the badge, which is the
    // honest recovery.
    setUnread(0);
    try {
      await markNotificationsRead();
      setRows((current) => current.map((row) => ({ ...row, read: true })));
    } catch {
      void pollRef.current();
    }
  }

  return (
    <span className="bell">
      <button
        type="button"
        className="bell-button"
        aria-label={unread > 0 ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}
        aria-expanded={open}
        onClick={toggle}
      >
        <FontAwesomeIcon icon={faBell} />
        {/* No badge at all at zero, rather than a "0" — a zero is noise. */}
        {unread > 0 ? <span className="bell-count">{unread}</span> : null}
      </button>

      {open ? (
        <div className="bell-panel">
          {rows.length === 0 ? (
            <p className="empty">Belum ada notifikasi.</p>
          ) : (
            <ul className="bell-list">
              {rows.map((row) => (
                <li key={row.id} data-unread={row.read ? undefined : "true"}>
                  <Link to={hrefFor(row)} onClick={() => setOpen(false)}>
                    <span className="bell-actor">{row.actor.displayName}</span>{" "}
                    {describe(row.kind)}
                    <span className="muted"> · {formatRelativeTime(row.createdAt, clock)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The link, built HERE from the kind and the ids. The server sends no href —
 * a URL in a response is a URL that outlives the route it names, the rule
 * `MediaView` records about bucket URLs.
 *
 * A row whose subject is missing falls back to the actor's profile rather
 * than rendering a dead link: the subject may have been deleted since.
 */
function hrefFor(row: NotificationRow): string {
  if (row.kind === "comment" && row.postId !== null && row.communitySlug !== null) {
    return `/komunitas/${row.communitySlug}/diskusi/${row.postId}`;
  }
  if (row.communitySlug !== null) return `/komunitas/${row.communitySlug}`;
  return `/@${row.actor.handle}`;
}

const KIND_COPY: Record<string, string> = {
  comment: "mengomentari kiriman Anda",
  join: "bergabung ke komunitas Anda",
  follow: "mulai mengikuti Anda",
};

/** An unknown kind reads as something happened rather than as a blank. */
function describe(kind: string): string {
  return KIND_COPY[kind] ?? "melakukan sesuatu";
}
