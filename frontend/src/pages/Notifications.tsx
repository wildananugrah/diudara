import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faCheckDouble } from "@fortawesome/free-solid-svg-icons";
import { api, type ApiNotification } from "../lib/api";
import { useApi } from "../lib/useApi";
import { notificationCopy, timeAgo } from "../lib/notificationCopy";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";

/** "Hari ini" / "Kemarin" / a date — the grouping the list is read by. */
function dayLabel(iso: string): string {
  const then = new Date(iso);
  const today = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(then)) / 86_400_000);
  if (days <= 0) return "Hari ini";
  if (days === 1) return "Kemarin";
  return then.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function groupByDay(items: ApiNotification[]): Array<[string, ApiNotification[]]> {
  const groups = new Map<string, ApiNotification[]>();
  for (const item of items) {
    const key = dayLabel(item.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()];
}

export default function Notifications() {
  const navigate = useNavigate();
  const state = useApi(useCallback(() => api.notifications.list(), []));
  const [local, setLocal] = useState<ApiNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The fetched list, with optimistic read marks laid over it.
  const items = local ?? state.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  const activate = async (n: ApiNotification) => {
    const { link } = notificationCopy(n);
    if (!n.readAt) {
      setLocal(items.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)));
      api.notifications.markRead(n.id).catch(() => state.reload());
    }
    if (link) navigate(link);
  };

  const markAll = async () => {
    setError(null);
    const now = new Date().toISOString();
    setLocal(items.map((i) => ({ ...i, readAt: i.readAt ?? now })));
    try {
      await api.notifications.markAllRead();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menandai notifikasi");
      state.reload();
    }
  };

  return (
    <>
      <Header title="Notifikasi" breadcrumb={[{ label: "Notifikasi" }]} />
      <PageContainer>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, paddingBottom: 60 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <p style={{ fontSize: 13, color: "var(--ink-500)" }}>
              {unread > 0 ? `${unread} belum dibaca` : "Semua sudah dibaca"}
            </p>
            {unread > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => void markAll()}>
                <FontAwesomeIcon icon={faCheckDouble} /> Tandai semua dibaca
              </button>
            )}
          </div>

          {state.loading && !state.data && (
            <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Memuat notifikasi…</p>
          )}
          {state.error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{state.error}</p>}
          {error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{error}</p>}

          {!state.loading && items.length === 0 && (
            <div className="card" style={{ padding: 32, textAlign: "center" }}>
              <FontAwesomeIcon icon={faBell} style={{ fontSize: 28, color: "var(--ink-300)" }} />
              <p style={{ fontSize: 14.5, fontWeight: 600, marginTop: 12 }}>Belum ada notifikasi</p>
              <p style={{ fontSize: 13, color: "var(--ink-500)", marginTop: 6, lineHeight: 1.6 }}>
                Balasan di postmu, pembayaran yang berhasil, anggota baru di komunitasmu, dan pesan
                langsung akan muncul di sini.
              </p>
            </div>
          )}

          {groupByDay(items).map(([day, group]) => (
            <div key={day}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-500)", margin: "6px 0 8px 2px" }}>
                {day}
              </p>
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {group.map((n, i) => {
                  const { text, link } = notificationCopy(n);
                  return (
                    <button
                      key={n.id}
                      onClick={() => void activate(n)}
                      className="hover-bg"
                      style={{
                        width: "100%", textAlign: "left", border: "none", display: "flex", gap: 12,
                        alignItems: "flex-start", padding: "13px 16px",
                        borderTop: i === 0 ? "none" : "1px solid var(--ink-100)",
                        background: n.readAt ? "transparent" : "var(--warning-bg)",
                        cursor: link ? "pointer" : "default",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8, height: 8, borderRadius: "50%", marginTop: 6, flexShrink: 0,
                          background: n.readAt ? "transparent" : "var(--sinyal)",
                        }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 13.5, color: "var(--ink-700)", lineHeight: 1.55, display: "block", fontWeight: n.readAt ? 400 : 600 }}>
                          {text}
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--ink-500)", display: "block", marginTop: 3 }}>
                          {timeAgo(n.createdAt)}
                          {!link && " · buka lewat kotak pesan"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </PageContainer>
    </>
  );
}
