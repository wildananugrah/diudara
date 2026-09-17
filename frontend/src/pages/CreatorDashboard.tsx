import { useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faUserPlus,
  faArrowUp,
  faTriangleExclamation,
  faUserMinus,
  faCartShopping,
  faFileLines,
  faVideo,
  faFile,
  faDownload,
  faCircleInfo,
} from "@fortawesome/free-solid-svg-icons";
import { api, ApiError, type ApiStats } from "../lib/api";
import { useApi } from "../lib/useApi";
import TopicManager from "../components/community/TopicManager";
import { FullPageMessage } from "../lib/auth";
import { formatCount, formatRupiah, percent, timeAgo } from "../lib/format";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";

const activityIcon: Record<string, IconDefinition> = {
  join: faUserPlus, upgrade: faArrowUp, failed: faTriangleExclamation, churn: faUserMinus, purchase: faCartShopping,
};

const statusBadge: Record<string, string> = { active: "badge-active", pending: "badge-pending", churned: "badge-churn" };
const statusLabel: Record<string, string> = { active: "Aktif", pending: "Menunggu", churned: "Churned" };

const docTypeIcon: Record<string, IconDefinition> = { document: faFileLines, video: faVideo, file: faFile };

/** Lets a 403 render as a message instead of surfacing as a generic failure. */
type StatsResult =
  | { ok: true; stats: ApiStats }
  | { ok: false; forbidden: boolean; message: string };

export default function CreatorDashboard() {
  const { id } = useParams();

  const communityState = useApi(() => api.communities.detail(id!), [id]);
  const statsState = useApi<StatsResult>(async () => {
    try {
      return { ok: true, stats: await api.communities.stats(id!) };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, forbidden: err.status === 403, message: err.message };
      throw err;
    }
  }, [id]);

  if (statsState.loading || communityState.loading) return <FullPageMessage text="Memuat dashboard…" />;
  if (statsState.error) return <FullPageMessage text={statsState.error} tone="error" />;

  const result = statsState.data;
  const communityName = communityState.data?.name ?? "komunitas ini";

  if (result && !result.ok) {
    return (
      <>
        <Header title="Dashboard Creator" subtitle={communityName} />
        <PageContainer>
          <div className="card" style={{ padding: 32, textAlign: "center", maxWidth: 480, margin: "40px auto" }}>
            <span style={{ fontSize: 26, color: "var(--kabut)" }}><FontAwesomeIcon icon={faCircleInfo} /></span>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "12px 0 8px" }}>
              {result.forbidden ? "Akses terbatas" : "Tidak dapat memuat dashboard"}
            </h3>
            <p style={{ fontSize: 13.5, color: "var(--ink-500)", lineHeight: 1.6 }}>
              {result.forbidden
                ? `Dashboard creator hanya bisa dibuka oleh admin atau pemilik ${communityName}.`
                : result.message}
            </p>
          </div>
        </PageContainer>
      </>
    );
  }

  if (!result) return <FullPageMessage text="Data dashboard tidak tersedia" tone="error" />;

  const stats = result.stats;
  const { salesSummary } = stats;
  // Empty history would make Math.max return -Infinity and every bar NaN.
  const maxRevenue = stats.revenueByMonth.length
    ? Math.max(...stats.revenueByMonth.map((r) => r.value), 1)
    : 1;

  const metrics: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Total revenue", value: formatRupiah(salesSummary.totalRevenue) },
    {
      label: "Total member",
      value: formatCount(salesSummary.totalMembers),
      sub: `+${formatCount(salesSummary.newMembersThisMonth)} baru bulan ini`,
    },
    { label: "Churn rate", value: percent(salesSummary.churnRate) },
    { label: "Success rate bayar", value: percent(salesSummary.successRate) },
  ];

  return (
    <>
      <Header title="Dashboard Creator" subtitle={`Ringkasan performa ${communityName}`} />
      <PageContainer>
      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 20, marginBottom: 28 }}>
        {metrics.map((m, i) => (
          <div key={i} className="card" style={{ padding: 18 }}>
            <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginBottom: 8 }}>{m.label}</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: "var(--langit)", marginBottom: 4 }}>{m.value}</p>
            {m.sub && <p style={{ fontSize: 12, color: "var(--hijau-lepas)", fontWeight: 600 }}>{m.sub}</p>}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Revenue chart */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>Revenue 6 bulan terakhir</h3>
            <span style={{ fontSize: 12.5, color: "var(--ink-500)" }}>dalam juta Rupiah</span>
          </div>
          {stats.revenueByMonth.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada pembayaran yang tercatat.</p>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 18, height: 160 }}>
              {stats.revenueByMonth.map((r, i) => (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11.5, color: "var(--ink-500)", fontWeight: 600 }}>{r.value}jt</span>
                  <div
                    style={{
                      width: "100%", borderRadius: "6px 6px 0 0",
                      height: `${(r.value / maxRevenue) * 120}px`,
                      background: i === stats.revenueByMonth.length - 1 ? "var(--sinyal)" : "var(--langit)",
                      opacity: i === stats.revenueByMonth.length - 1 ? 1 : 0.85,
                    }}
                  />
                  <span style={{ fontSize: 12, color: "var(--ink-500)" }}>{r.month}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Member distribution */}
        <div className="card" style={{ padding: 22 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 18 }}>Distribusi tier</h3>
          {stats.tierDistribution.map((t, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <span style={{ color: "var(--ink-500)" }}>{t.pct}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "var(--ink-100)", overflow: "hidden" }}>
                <div style={{ width: `${t.pct}%`, height: "100%", background: t.color, borderRadius: 999 }} />
              </div>
            </div>
          ))}
          {stats.tierDistribution.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada tier.</p>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Activity log */}
        <div className="card" style={{ padding: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, padding: "14px 16px 6px" }}>Log aktivitas</h3>
          {stats.activityLog.map((a, i) => (
            <div
              key={i}
              style={{
                display: "flex", gap: 12, alignItems: "center", padding: "12px 16px",
                borderTop: "1px solid var(--ink-100)",
              }}
            >
              <span style={{ fontSize: 15, color: "var(--ink-500)" }}>
                <FontAwesomeIcon icon={activityIcon[a.type] ?? faCircleInfo} />
              </span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 500 }}>
                  <strong>{a.name}</strong> {a.action}
                </p>
              </div>
              <span style={{ fontSize: 11.5, color: "var(--ink-300)", flexShrink: 0 }}>{timeAgo(a.time)}</span>
            </div>
          ))}
          {stats.activityLog.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 16px" }}>Belum ada aktivitas.</p>
          )}
        </div>

        {/* Recent members */}
        <div className="card" style={{ padding: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, padding: "14px 16px 6px" }}>Member terbaru</h3>
          {stats.recentMembers.map((m, i) => (
            <div
              key={i}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "12px 16px", borderTop: "1px solid var(--ink-100)",
              }}
            >
              <div>
                <p style={{ fontSize: 13.5, fontWeight: 600 }}>{m.name}</p>
                <p style={{ fontSize: 12, color: "var(--ink-500)" }}>{timeAgo(m.joined)}</p>
              </div>
              <span className={`badge ${statusBadge[m.status] ?? "badge-neutral"}`}>
                <span className="dot"></span>
                {statusLabel[m.status] ?? m.status}
              </span>
            </div>
          ))}
          {stats.recentMembers.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 16px" }}>Belum ada member.</p>
          )}
        </div>
      </div>

      {/* Dokumen paling banyak diunduh */}
      <div className="card" style={{ padding: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, padding: "14px 16px 6px" }}>Dokumen paling banyak diunduh</h3>
        {stats.topDocuments.map((d, i) => (
          <div
            key={i}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "12px 16px", borderTop: "1px solid var(--ink-100)",
            }}
          >
            <span style={{ fontSize: 18, color: "var(--ink-500)", flexShrink: 0 }}>
              <FontAwesomeIcon icon={docTypeIcon[d.type] ?? faFile} />
            </span>
            <p style={{ flex: 1, fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</p>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-500)", flexShrink: 0 }}>
              <FontAwesomeIcon icon={faDownload} /> {formatCount(d.downloads)}
            </span>
          </div>
        ))}
        {stats.topDocuments.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 16px" }}>Belum ada dokumen yang diunduh.</p>
        )}
      </div>

      {/* Topik — the dashboard is already owner/admin only, so no extra gate. */}
      <div style={{ marginTop: 20 }}>
        <TopicManager communityId={id!} />
      </div>
      </PageContainer>
    </>
  );
}
