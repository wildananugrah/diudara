import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faCheckDouble } from "@fortawesome/free-solid-svg-icons";
import { api, type ApiNotification } from "../../lib/api";
import { notificationCopy, timeAgo } from "../../lib/notificationCopy";

/** Wide enough that the badge is current, rare enough to be free. Chat polls 5s. */
const POLL_MS = 30_000;
const DROPDOWN_LIMIT = 10;

/**
 * The bell, its badge, and the panel behind it.
 *
 * Polls only the count — a separate endpoint exists precisely so the thing that
 * runs every 30s in every open tab is one indexed COUNT rather than a list with
 * its payloads. The list is fetched when the panel opens and not before.
 */
export default function NotificationBell() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ApiNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      const { count: n } = await api.notifications.unreadCount();
      setCount(n);
    } catch {
      // A failed poll is not worth a message; the next tick retries.
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  // Same click-outside behaviour as the profile menu beside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openPanel = async () => {
    setOpen((o) => !o);
    if (open) return;
    setError(null);
    try {
      setItems(await api.notifications.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat notifikasi");
      setItems([]);
    }
  };

  const activate = async (n: ApiNotification) => {
    const { link } = notificationCopy(n);
    if (!n.readAt) {
      // Optimistic: the badge should not lag behind the click that caused it.
      setItems((list) => list?.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)) ?? null);
      setCount((c) => Math.max(0, c - 1));
      void api.notifications.markRead(n.id).catch(() => void refreshCount());
    }
    if (link) {
      setOpen(false);
      navigate(link);
    }
  };

  const markAll = async () => {
    setCount(0);
    setItems((list) => list?.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) ?? null);
    try {
      await api.notifications.markAllRead();
    } catch {
      void refreshCount();
    }
  };

  const recent = (items ?? []).slice(0, DROPDOWN_LIMIT);

  return (
    <div ref={panelRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        aria-label={count > 0 ? `Notifikasi, ${count} belum dibaca` : "Notifikasi"}
        aria-expanded={open}
        onClick={() => void openPanel()}
        style={{
          position: "relative", width: 38, height: 38, borderRadius: "50%",
          border: "1px solid var(--ink-150)", background: open ? "var(--ink-100)" : "var(--awan)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 15, color: "var(--ink-700)", cursor: "pointer",
        }}
      >
        <FontAwesomeIcon icon={faBell} />
        {count > 0 && (
          <span
            style={{
              position: "absolute", top: -4, right: -4, minWidth: 17, height: 17, padding: "0 4px",
              borderRadius: 9, background: "var(--merah-senja)", color: "#fff",
              fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="card"
          style={{
            position: "absolute", top: "calc(100% + 8px)", right: 0, width: 340, maxWidth: "90vw",
            padding: 0, boxShadow: "var(--shadow-card)", zIndex: 20, overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--ink-100)" }}>
            <p style={{ fontSize: 13.5, fontWeight: 700 }}>Notifikasi</p>
            {count > 0 && (
              <button
                onClick={() => void markAll()}
                style={{ background: "none", border: "none", color: "var(--ink-500)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                <FontAwesomeIcon icon={faCheckDouble} /> Tandai semua
              </button>
            )}
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {items === null && <p style={{ fontSize: 13, color: "var(--ink-500)", padding: 14 }}>Memuat…</p>}
            {error && <p style={{ fontSize: 13, color: "var(--merah-senja)", padding: 14 }}>{error}</p>}
            {items !== null && !error && recent.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--ink-500)", padding: 14, lineHeight: 1.6 }}>
                Belum ada notifikasi. Balasan di postmu, pembayaran, dan anggota baru muncul di sini.
              </p>
            )}

            {recent.map((n) => {
              const { text, link } = notificationCopy(n);
              return (
                <button
                  key={n.id}
                  onClick={() => void activate(n)}
                  className="hover-bg"
                  style={{
                    width: "100%", textAlign: "left", border: "none", background: n.readAt ? "transparent" : "var(--warning-bg)",
                    borderBottom: "1px solid var(--ink-100)", padding: "11px 14px",
                    cursor: link ? "pointer" : "default", display: "block",
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--ink-700)", lineHeight: 1.5, display: "block", fontWeight: n.readAt ? 400 : 600 }}>
                    {text}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--ink-500)", display: "block", marginTop: 3 }}>
                    {timeAgo(n.createdAt)}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => { setOpen(false); navigate("/notifications"); }}
            className="hover-bg"
            style={{
              width: "100%", border: "none", background: "transparent", padding: "11px 14px",
              fontSize: 13, fontWeight: 600, color: "var(--langit)", cursor: "pointer",
            }}
          >
            Lihat semua notifikasi
          </button>
        </div>
      )}
    </div>
  );
}
